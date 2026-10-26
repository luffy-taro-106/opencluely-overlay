'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, desktopCapturer, clipboard, nativeImage, dialog, safeStorage, session, powerMonitor, systemPreferences, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DEFAULTS, MAX_IMAGE_BYTES, MAX_IMAGES, imageIds, imageNames, validateSettings, validateQuestion, inspectImage, clampBounds, boundedContext, diskHistory, validateHistory } = require('./core');
const { streamAnswer, validateApiKey, listProviderModels } = require('./providers');
const { Store } = require('./storage');
const { InterruptedWork } = require('./interrupted-work');
const { QuitGuard } = require('./quit-guard');
const { WindowsRecovery, recoverySession } = require('./recovery');
const { MODEL_CATALOG, PROVIDERS, PROVIDER_NAMES, EFFORTS, validModelId, modelDetails } = require('./models');
const { platformInfo, shortcutLabel, loginOptions, startHidden, startupAvailable } = require('./platform');
const platform = platformInfo();
const { WindowsPanel } = require('./windows-panel');

const quitTestMode = !app.isPackaged && process.argv.includes('--quit-smoke-test');
const interruptionTestMode = !app.isPackaged && process.argv.includes('--interruption-smoke-test');
const testMode = !app.isPackaged && (process.argv.includes('--smoke-test') || quitTestMode || interruptionTestMode);
if (interruptionTestMode) {
  const profile = path.resolve(process.argv.at(-1));
  const info = fs.lstatSync(profile);
  if (path.dirname(profile) !== fs.realpathSync(os.tmpdir()) || !path.basename(profile).startsWith('opencluely-interruption-test-') ||
    !info.isDirectory() || info.isSymbolicLink()) throw new Error('Interruption tests require a disposable profile.');
  app.setPath('userData', profile);
} else if (testMode) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-test-')));
app.setName('OpenCluely Overlay');
if (process.platform === 'win32') app.setAppUserModelId('com.opencluely.overlay');

let win, tray, store, quitting = false, settings, keys = {}, history = [], active = null, lastAttempt = null;
let passThrough = false, captureBusy = false, settingsBusy = false, geometryTimer, normalBounds;
let panel = null;
let screenshotRestore = true;
let launchHidden = false;
let recovery, interruptedWork, initializationComplete = false;
let recoveryBeforeSessionEnd = false;
let archivedChats = [];
const images = new Map(), warnings = [], recoveryTimes = [], shortcuts = [];
const draftImageIds = new Set();
const html = path.join(__dirname, 'ui', 'index.html');
const pageURL = pathToFileURL(html).href;
let answerFunction = streamAnswer;
let keyValidator = validateApiKey;
let modelLister = listProviderModels;
const modelCatalog = structuredClone(MODEL_CATALOG), modelStatus = {}, modelRefreshes = new Map();
let screenPermissionFunction = () => platform.mac ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
let quitConfirmationFunction = async () => {
  showOverlay(true);
  const result = await dialog.showMessageBox(win, {
    type: 'question', title: 'Quit OpenCluely?',
    message: active ? 'Quit and stop the current answer?' : 'Quit OpenCluely?',
    detail: 'The overlay, its shortcut, and automatic reopening will stop until you open the app again.',
    buttons: ['Keep running', 'Quit OpenCluely'], defaultId: 0, cancelId: 0, noLink: true
  });
  return result.response === 1;
};
const quitGuard = new QuitGuard({
  enabled: () => settings?.protectFromQuit === true,
  confirm: () => quitConfirmationFunction(),
  quit: async () => { await recovery?.stopForQuit(); app.quit(); },
  blocked: () => {
    log('external-quit-blocked');
    emit({ type: 'notice', text: 'A normal Quit request was blocked. Use Quit OpenCluely in Settings or the tray to exit.' });
  }
});
function requestQuit() {
  return quitGuard.requestQuit().catch(() => {
    emit({ type: 'notice', text: 'OpenCluely could not finish quitting. Check automatic reopening in Settings and try Quit again.' });
    return false;
  });
}

function log(code) {
  try {
    const file = path.join(app.getPath('userData'), 'diagnostics.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 512000) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${code}\n`);
  } catch { /* Logging must never prevent recovery. No prompts, keys or API bodies are logged. */ }
}
function warn(message) { if (!warnings.includes(message)) warnings.push(message); log('warning'); }
function emit(event) { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('overlay:event', event); }
function publicImage(image) { return { id: image.id, name: image.name, preview: image.preview, width: image.width, height: image.height }; }
function loginState() {
  if (!app.isPackaged) return {};
  try {
    if (platform.mac) return app.getLoginItemSettings({});
    const exact = app.getLoginItemSettings({ path: process.execPath, args: ['--background'] });
    const quoted = app.getLoginItemSettings({ path: `"${process.execPath}"`, args: ['--background'] });
    return { ...exact, executableWillLaunchAtLogin: quoted.executableWillLaunchAtLogin };
  }
  catch { return {}; }
}
function canStartAtLogin() {
  return startupAvailable(app.isPackaged, platform.mac && app.isInApplicationsFolder(), !!process.env.PORTABLE_EXECUTABLE_DIR);
}
function screenPermission() { return screenPermissionFunction(); }
function currentState() {
  return {
    settings, history: diskHistory(history), passThrough, panelBehavior: panel?.status() || { available: false, preventsActivation: false }, busy: !!active, captureBusy,
    active: active ? { id: active.id, question: active.question, text: active.text, images: active.images.map(publicImage), provider: active.provider, model: active.model } : null,
    lastAttempt: lastAttempt ? { ...lastAttempt, images: imageIds(lastAttempt.question).map(id => images.get(id)).filter(Boolean).map(publicImage) } : null,
    maxImages: MAX_IMAGES,
    draftImages: [...draftImageIds].map(id => images.get(id)).filter(Boolean).map(publicImage),
    keyStatus: Object.fromEntries(PROVIDERS.map(provider => [provider, !!keys[provider]])),
    modelCatalog, modelStatus,
    archivedChats: archivedChats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    secureStorage: store.available(), warnings, shortcuts, platform,
    captureProtectionActive: !!win && !win.isDestroyed() && win.isContentProtected(),
    screenPermission: screenPermission(),
    startupAvailable: canStartAtLogin(), startupStatus: loginState().status || '',
    recovery: recovery?.status() || { available: false, enabled: false, busy: false, error: '' },
    displays: screen.getAllDisplays().map((display, i) => ({ id: String(display.id), name: display.label || `Display ${i + 1}`, primary: display.id === screen.getPrimaryDisplay().id }))
  };
}
function syncState() { emit({ type: 'state', value: currentState() }); updateTray(); }

function persistModelCatalog() {
  try {
    store.write('model-catalog.json', Object.fromEntries(PROVIDERS.filter(provider => keys[provider] && modelStatus[provider]?.checkedAt)
      .map(provider => [provider, { models: modelCatalog[provider], total: modelStatus[provider].total, checkedAt: modelStatus[provider].checkedAt }])));
  } catch { warn('The refreshed model list could not be cached. It is available until you quit.'); }
}
function restoreModelCatalog() {
  const cached = store.read('model-catalog.json', {});
  for (const provider of PROVIDERS) {
    const entry = cached?.[provider];
    if (!keys[provider] || !entry || !Array.isArray(entry.models) || entry.models.length > 1000 || !Number.isFinite(entry.total) || !Number.isFinite(Date.parse(entry.checkedAt))) continue;
    if (!entry.models.every(model => model && validModelId(model.id) && typeof model.name === 'string' && model.name.length <= 250 &&
      Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.every(value => EFFORTS.includes(value) && value !== 'auto') &&
      [null, 'effort', 'thinkingLevel', 'thinkingBudget'].includes(model.reasoningMode) && [null, 'adaptive', 'enabled'].includes(model.thinking) && typeof model.vision === 'boolean')) continue;
    modelCatalog[provider] = entry.models;
    modelStatus[provider] = { source: 'cached', total: entry.total, checkedAt: entry.checkedAt, refreshing: false, error: '' };
  }
}
async function refreshModels(provider = null) {
  if (provider !== null && !PROVIDERS.includes(provider)) throw new Error('Choose a valid AI provider.');
  await Promise.all((provider ? [provider] : PROVIDERS).map(async selected => {
    const apiKey = keys[selected];
    if (!apiKey) return;
    if (modelRefreshes.get(selected)?.apiKey === apiKey) return modelRefreshes.get(selected).promise;
    const task = { apiKey };
    modelStatus[selected] = { ...modelStatus[selected], refreshing: true, error: '' };
    task.promise = (async () => {
      try {
        const result = await modelLister(selected, apiKey);
        if (keys[selected] !== apiKey) return;
        modelCatalog[selected] = result.models;
        modelStatus[selected] = { source: 'live', total: result.total, checkedAt: result.checkedAt, refreshing: false, error: '' };
        persistModelCatalog();
      } catch (error) {
        if (keys[selected] !== apiKey) return;
        modelStatus[selected] = { ...modelStatus[selected], refreshing: false, error: error.message };
      } finally {
        if (modelRefreshes.get(selected) === task) modelRefreshes.delete(selected);
        if (!quitting) syncState();
      }
    })();
    modelRefreshes.set(selected, task);
    syncState();
    return task.promise;
  }));
  return currentState();
}
async function setRecoveryEnabled(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether automatic reopening is on or off.');
  if (!recovery?.available) throw new Error('Automatic reopening is available in the installed Windows app.');
  if (enabled) await recovery.enable(); else await recovery.disable();
  return currentState();
}
function manualReopen() {
  if (!settings || quitting) return;
  showOverlay(false);
  if (initializationComplete && recovery?.available && !recovery.enabled && !recovery.busy) {
    void recovery.enable().catch(() => {});
  }
}
function allowSessionEnd(terminal = true) {
  interruptedWork?.flush();
  if (!quitGuard.sessionEnding) recoveryBeforeSessionEnd = !!recovery?.enabled || recovery?.shouldResumeAfterSessionEnd?.() === true;
  quitGuard.allowSessionEnd(); recovery?.disarmForSessionEnd({ terminal });
}
function cancelSessionEnd() {
  if (!quitGuard.sessionEnding) return;
  quitGuard.cancelSessionEnd();
  const restoreRecovery = recoveryBeforeSessionEnd; recoveryBeforeSessionEnd = false;
  if (restoreRecovery && recovery?.available && !quitting) {
    void recovery.enable().catch(() => emit({ type: 'notice', text: 'Windows canceled shutdown. Automatic reopening is paused; enable it again in Settings.' }));
  }
}
function persistSettings() { store.write('preferences.json', settings); }
function persistHistory() {
  try {
    if (settings.rememberHistory && store.available()) {
      store.write('chats.enc', { current: diskHistory(history), archive: archivedChats }, true);
      store.write('conversation.enc', diskHistory(history), true);
    } else { store.remove('conversation.enc'); store.remove('chats.enc'); }
    return true;
  } catch { warn('The conversation could not be saved. It is still available until you quit.'); return false; }
}
function clearInterruptedWork() {
  try { interruptedWork?.clear(); }
  catch { warn('The saved unfinished answer could not be removed. Check available storage and try again.'); }
}
function changeConversation(archiveId = null) {
  if (active) throw new Error('Stop the current answer before starting or switching chats.');
  if (settingsBusy || captureBusy) throw new Error('Wait for the current operation before switching chats.');
  const target = archiveId === null ? null : archivedChats.find(chat => chat.id === archiveId);
  if (archiveId !== null && !target) throw new Error('That conversation is no longer available.');
  const nextArchives = archivedChats.filter(chat => chat !== target);
  if (history.length) nextArchives.unshift({ id: randomUUID(), title: history.find(message => message.role === 'user')?.text.slice(0, 80) || 'Conversation', updatedAt: new Date().toISOString(), history: diskHistory(history) });
  if (nextArchives.length > 100) throw new Error('You have 100 saved chats. Export and remove old conversations before starting another.');
  if (Buffer.byteLength(JSON.stringify(nextArchives), 'utf8') > 3 * 1024 * 1024) throw new Error('Saved chats are full. Export and remove older chats before starting another.');
  const nextHistory = target ? validateHistory(target.history) : [];
  // Save the old conversation first; a failed archive write cannot clear it.
  if (settings.rememberHistory && store.available()) {
    store.write('chats.enc', { current: diskHistory(nextHistory), archive: nextArchives }, true);
  }
  archivedChats = nextArchives; history = nextHistory; images.clear(); draftImageIds.clear(); lastAttempt = null;
  clearInterruptedWork();
  persistHistory();
  syncState(); return currentState();
}

function fitWindow() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  win.setBounds(clampBounds(bounds, display.workArea, settings.compact));
}
function applyWindowMode() {
  if (!win || win.isDestroyed()) return;
  // Apply before first show, and restore after sleep, focus/mode changes or recovery.
  try { win.setContentProtection(settings.hideFromCapture); }
  catch { warn('Screen capture protection could not be enabled. Check Settings and your sharing preview before sharing.'); }
  win.setAlwaysOnTop(true, 'screen-saver');
  // Renderer layers control opacity so code boxes never inherit the app fade.
  win.setOpacity(1);
  win.setIgnoreMouseEvents(passThrough, { forward: true });
  panel?.apply(passThrough);
}
function showOverlay(focus = false) {
  if (!win || win.isDestroyed()) createWindow();
  if (focus) { passThrough = false; panel?.apply(false); panel?.allowKeyboard(); }
  else if (!win.isFocused()) panel?.releaseKeyboard();
  applyWindowMode(); fitWindow();
  if (win.isMinimized()) win.restore();
  if (focus) { win.show(); win.focus(); }
  else win.showInactive();
  syncState();
  if (focus) emit({ type: 'focus-input' });
}
function hideOverlay() {
  screenshotRestore = false;
  if (win && !win.isDestroyed()) { win.hide(); panel?.releaseKeyboard(); applyWindowMode(); }
  syncState();
}
function toggleVisibility() { if (win?.isVisible()) hideOverlay(); else showOverlay(false); }
function togglePassThrough() {
  passThrough = !passThrough;
  applyWindowMode(); syncState();
  if (!passThrough) showOverlay(false);
  return passThrough;
}
function saveGeometry() {
  clearTimeout(geometryTimer);
  geometryTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || quitting) return;
    const bounds = win.getBounds();
    settings.bounds = settings.compact ? { ...bounds, height: normalBounds?.height || 700 } : bounds;
    if (!settings.compact) normalBounds = bounds;
    try { persistSettings(); } catch { warn('Window position could not be saved.'); }
  }, 350);
}
function toggleCompact() {
  if (!win || win.isDestroyed()) return false;
  if (!settings.compact) normalBounds = win.getBounds();
  settings.compact = !settings.compact;
  const bounds = settings.compact ? win.getBounds() : { ...win.getBounds(), height: normalBounds?.height || 700 };
  win.setMinimumSize(360, settings.compact ? 122 : 440);
  win.setBounds(clampBounds(bounds, screen.getDisplayMatching(bounds).workArea, settings.compact));
  try { persistSettings(); } catch { warn('Window preference could not be saved.'); }
  syncState(); return settings.compact;
}
function recoverRenderer(reason) {
  if (quitting || !win || win.isDestroyed()) return;
  // Provider requests and their checkpoints live in main. A renderer crash
  // should not interrupt a healthy request; the reloaded UI receives its state.
  const now = Date.now();
  recoveryTimes.push(now);
  while (recoveryTimes[0] < now - 60000) recoveryTimes.shift();
  log(`renderer-recovery:${reason}`);
  passThrough = false; panel?.releaseKeyboard(); applyWindowMode();
  if (recoveryTimes.length <= 3) win.reload();
  else {
    hideOverlay();
    dialog.showMessageBox({ type: 'error', title: 'Overlay needs a restart', message: 'The overlay failed repeatedly. Your saved conversation is preserved.', detail: 'Use the tray menu to show the overlay again, or quit and reopen the app.', buttons: ['OK'] }).catch(() => {});
  }
}
function createWindow() {
  const saved = settings.bounds;
  const display = saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay();
  normalBounds = clampBounds(saved, display.workArea, false);
  win = new BrowserWindow({
    ...clampBounds(saved, display.workArea, settings.compact), minWidth: 360, minHeight: settings.compact ? 122 : 440,
    title: 'Chat',
    frame: false, transparent: true, backgroundColor: '#00000000', show: false, focusable: process.platform !== 'win32',
    ...(platform.mac ? { type: 'panel', hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
    alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true, maximizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), partition: 'overlay-memory', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false }
  });
  panel = new WindowsPanel(win);
  // The app is already an accessory. Avoid process transformations that flash/hide the window.
  if (platform.mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  applyWindowMode();
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => recoverRenderer(details.reason));
  win.on('unresponsive', async () => {
    log('renderer-unresponsive');
    const result = await dialog.showMessageBox({ type: 'warning', title: 'Overlay is busy', message: 'The overlay is not responding.', buttons: ['Reload overlay', 'Wait'], defaultId: 1, cancelId: 1 });
    if (result.response === 0) recoverRenderer('unresponsive');
  });
  win.on('close', event => { if (!quitting) { event.preventDefault(); hideOverlay(); } });
  win.on('query-session-end', () => allowSessionEnd(false));
  win.on('session-end', () => allowSessionEnd(true));
  if (process.platform === 'win32') {
    // WM_ENDSESSION(FALSE) follows a shutdown canceled by another application.
    win.hookWindowMessage(0x0016, wParam => { if (wParam.readUInt32LE(0) === 0) cancelSessionEnd(); });
  }
  win.on('closed', () => { win = null; });
  win.on('move', saveGeometry); win.on('resize', saveGeometry);
  win.on('blur', () => {
    if (quitting || !win || win.isDestroyed()) return;
    panel?.handleBlur(syncState);
  });
  win.on('focus', () => { if (!quitting && settings && store) syncState(); });
  win.webContents.on('did-finish-load', () => syncState());
  win.webContents.on('did-fail-load', (_event, code) => { if (code !== -3) { warn('The overlay could not load. Quit and reopen from the tray.'); } });
  win.once('ready-to-show', () => { if (!testMode && !launchHidden) win.showInactive(); });
  win.loadFile(html).catch(() => warn('The overlay could not load.'));
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'OpenCluely Overlay', enabled: false },
    { label: 'Show and type a question', click: () => showOverlay(true) },
    { label: win?.isVisible() ? 'Hide overlay (keep running)' : 'Show overlay without focus', click: () => win?.isVisible() ? hideOverlay() : showOverlay(false) },
    { type: 'separator' },
    { label: 'Click-through', type: 'checkbox', checked: passThrough, click: togglePassThrough },
    { label: 'Compact view', type: 'checkbox', checked: settings.compact, click: toggleCompact },
    { label: 'Settings', click: () => { showOverlay(false); emit({ type: 'open-settings' }); } },
    ...(platform.mac ? [{ label: 'Screen Recording permission…', click: () => { void openScreenSettings().catch(() => {}); } }] : []),
    ...(recovery?.available ? [{ label: 'Reopen automatically', type: 'checkbox', checked: recovery.enabled, enabled: !recovery.busy,
      click: item => { void setRecoveryEnabled(item.checked).catch(error => emit({ type: 'notice', text: error.message })); } }] : []),
    { type: 'separator' },
    { label: 'Quit OpenCluely', click: requestQuit }
  ]));
}

function addImage(native, name) {
  if (!native || native.isEmpty()) throw new Error('This image could not be decoded. Choose a different PNG or JPEG.');
  const original = native.getSize();
  if (original.width * original.height > 32_000_000) throw new Error('The image exceeds 32 megapixels.');
  const ratio = Math.min(1, 2560 / Math.max(original.width, original.height));
  const resized = ratio < 1 ? native.resize({ width: Math.round(original.width * ratio), height: Math.round(original.height * ratio), quality: 'best' }) : native;
  const bytes = resized.toJPEG(92);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('The processed image is too large. Please crop it first.');
  const size = resized.getSize();
  const preview = resized.resize({ width: Math.min(260, size.width), quality: 'good' }).toDataURL();
  const image = { id: randomUUID(), name: String(name || 'Image').slice(0, 160), mime: 'image/jpeg', data: bytes.toString('base64'), preview, ...size };
  // Composer attachments and all images in a running request must survive
  // cache eviction. Older history retains attachment names after pixels expire.
  while (images.size >= MAX_IMAGES * 2) {
    const removable = [...images.keys()].find(id => !imageIds(active?.question).includes(id) && !draftImageIds.has(id));
    if (!removable) throw new Error('Image memory is full. Finish the answer or remove a queued image first.');
    images.delete(removable);
  }
  images.set(image.id, image);
  return publicImage(image);
}
function importImage(input) {
  if (!input || typeof input.data !== 'string' || input.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new Error('Choose a PNG or JPEG up to 10 MB.');
  const bytes = Buffer.from(input.data, 'base64');
  inspectImage(bytes);
  return addImage(nativeImage.createFromBuffer(bytes), input.name);
}
async function capture(displayId) {
  if (captureBusy) throw new Error('A screenshot is already in progress.');
  if (['denied', 'restricted'].includes(screenPermission())) throw new Error('Allow OpenCluely in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen the app. You can still upload or paste images.');
  if (displayId != null && (typeof displayId !== 'string' || !screen.getAllDisplays().some(display => String(display.id) === displayId))) throw new Error('That display is no longer connected.');
  captureBusy = true;
  screenshotRestore = true;
  const visible = win && !win.isDestroyed() && win.isVisible();
  const display = displayId ? screen.getAllDisplays().find(display => String(display.id) === displayId) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (visible) win.hide();
  try {
    await new Promise(resolve => setTimeout(resolve, 180));
    const scale = Math.min(display.scaleFactor || 1, 2560 / Math.max(display.size.width, display.size.height));
    let captureTimer;
    let sources;
    try {
      sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } }),
        new Promise((_resolve, reject) => { captureTimer = setTimeout(() => reject(new Error('Screenshot timed out. Upload an image or try again.')), 10000); })
      ]);
    } finally { clearTimeout(captureTimer); }
    if (platform.mac && screenPermission() !== 'granted') throw new Error('Enable Screen & System Audio Recording for OpenCluely in System Settings, then quit and reopen it. Open Settings in the overlay for a shortcut.');
    const source = sources.find(source => source.display_id === String(display.id));
    if (!source) throw new Error('Could not capture this display. Check screen-recording permission or upload an image instead.');
    return addImage(source.thumbnail, `${display.label || 'Screen'} screenshot`);
  } finally {
    captureBusy = false;
    if (visible && screenshotRestore && win && !win.isDestroyed() && !quitting) { applyWindowMode(); win.showInactive(); }
    syncState();
  }
}

async function ask(input) {
  if (active) throw new Error('An answer is already running. Stop it before asking another question.');
  if (settingsBusy) throw new Error('Settings are being saved. Please try again.');
  const question = validateQuestion(input);
  const provider = settings.provider, model = settings.models[provider], apiKey = keys[provider];
  if (!apiKey) throw new Error(`Add your ${PROVIDER_NAMES[provider]} API key in Settings first.`);
  const attachments = question.imageIds.map(id => images.get(id));
  if (attachments.some(image => !image)) throw new Error('An attachment expired. Please attach the missing image again.');
  const modelInfo = modelCatalog[provider].find(item => item.id === model) || modelDetails(provider, model);
  if (!modelInfo.vision && attachments.length) throw new Error('This model accepts text only. Select a vision model for images.');
  const savedEffort = settings.reasoningEfforts[provider]?.[model] || 'auto';
  const reasoningEffort = modelInfo.reasoningEfforts.includes(savedEffort) ? savedEffort : 'auto';
  const request = { id: randomUUID(), question, images: attachments, provider, model, text: '', controller: new AbortController() };
  active = request; lastAttempt = null;
  interruptedWork.start(request, history);
  emit({ type: 'start', id: request.id, question, images: attachments.map(publicImage), provider, model });
  updateTray();
  // Returning immediately lets the UI cancel while the stream is running.
  void (async () => {
    try {
      const answer = await answerFunction({ provider, model, apiKey, reasoningEffort, modelInfo, messages: boundedContext(history, question, id => images.get(id)), signal: request.controller.signal,
        onDelta: delta => { request.text += delta; interruptedWork.update(request, history); emit({ type: 'delta', id: request.id, text: delta }); },
        onStatus: text => emit({ type: 'status', id: request.id, text }) });
      request.controller.signal.throwIfAborted();
      request.text = answer.text;
      interruptedWork.start(request, history);
      const createdAt = new Date().toISOString();
      history.push({ id: randomUUID(), role: 'user', text: question.text, imageId: question.imageId, imageIds: question.imageIds, imageName: attachments[0]?.name, imageNames: attachments.map(image => image.name), createdAt },
        { id: request.id, role: 'assistant', text: answer.text, provider, model, createdAt });
      history = history.slice(-40);
      if (persistHistory()) clearInterruptedWork();
      emit({ type: 'done', id: request.id, text: answer.text, truncated: answer.truncated });
    } catch (error) {
      const message = request.controller.signal.aborted ? 'Answer stopped. You can retry when you are ready.' : error.message;
      lastAttempt = { id: request.id, question, text: request.text, error: message, provider, model, imageNames: attachments.map(image => image.name) };
      interruptedWork.start(request, history);
      emit({ type: 'error', ...lastAttempt }); log('request-failed');
    } finally {
      if (active === request) active = null;
      syncState();
    }
  })();
  return { id: request.id };
}

async function saveSettings(input) {
  if (settingsBusy) throw new Error('Settings are already being saved.');
  if (active) throw new Error('Stop the current answer before changing settings.');
  settingsBusy = true;
  try {
    const next = validateSettings(input, settings);
    for (const [provider, choices] of Object.entries(input.reasoningEfforts || {})) {
      for (const [model, effort] of Object.entries(choices)) {
        const info = modelCatalog[provider].find(item => item.id === model) || modelDetails(provider, model);
        if (effort !== 'auto' && !info.reasoningEfforts.includes(effort)) throw new Error('This model does not support the selected reasoning effort.');
      }
    }
    if (next.rememberHistory && !store.available()) throw new Error('Secure storage is unavailable. Turn off conversation history to save preferences.');
    const nextKeys = { ...keys };
    let replacementKey = '';
    if (input.apiKey != null) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 500) throw new Error('Enter a valid API key, or leave the field blank to keep your saved key.');
      replacementKey = input.apiKey.trim();
      if (replacementKey && (/\s/.test(replacementKey) || replacementKey.length < 12)) throw new Error('Enter a valid API key, or leave the field blank to keep your saved key.');
      if (replacementKey && input.removeKey === true) throw new Error('Choose either replacing or removing the saved key.');
      if (replacementKey) {
        if (!store.available()) throw new Error('Secure storage is unavailable. The new key cannot be saved.');
        await keyValidator(next.provider, replacementKey);
        nextKeys[next.provider] = replacementKey;
      }
    }
    if (input.removeKey === true) delete nextKeys[next.provider];
    const startupChanged = next.launchAtLogin !== settings.launchAtLogin;
    if (startupChanged && !canStartAtLogin()) throw new Error(platform.startupHint);
    const credentialsChanged = !!replacementKey || input.removeKey === true;
    // A user can move/compact the window while the network check is in progress.
    next.bounds = settings.bounds;
    if (!('compact' in input)) next.compact = settings.compact;
    const hadCredentials = fs.existsSync(path.join(store.directory, 'credentials.enc'));
    try {
      if (!next.rememberHistory) interruptedWork.clear();
      if (credentialsChanged) store.write('credentials.enc', nextKeys, true);
      if (startupChanged) {
        app.setLoginItemSettings(loginOptions(next.launchAtLogin, process.execPath));
        const login = loginState();
        if (platform.mac && next.launchAtLogin && !login.openAtLogin && login.status !== 'requires-approval') throw new Error('macOS did not enable launch at sign-in. Add OpenCluely in System Settings → General → Login Items.');
      }
      store.write('preferences.json', next);
    } catch (error) {
      try {
        if (credentialsChanged) { if (hadCredentials) store.write('credentials.enc', keys, true); else store.remove('credentials.enc'); }
        if (startupChanged) app.setLoginItemSettings(loginOptions(settings.launchAtLogin, process.execPath));
      } catch { warn('Settings could not be fully restored after a disk error. Reopen Settings and check your preferences.'); }
      throw error;
    }
    settings = next; keys = nextKeys;
    if (credentialsChanged) {
      modelCatalog[next.provider] = structuredClone(MODEL_CATALOG[next.provider]);
      delete modelStatus[next.provider];
      persistModelCatalog();
      if (replacementKey && !testMode) void refreshModels(next.provider);
    }
    if (settings.rememberHistory && lastAttempt) interruptedWork.start(lastAttempt, history);
    applyWindowMode(); persistHistory(); syncState();
    return currentState();
  } finally { settingsBusy = false; }
}

function handle(channel, action) {
  ipcMain.handle(`overlay:${channel}`, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pageURL) return { ok: false, error: 'Unauthorized app request.' };
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: error.message || 'This action could not be completed.' }; }
  });
}
async function openScreenSettings() {
  if (!platform.mac) return false;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return true;
}
function requestKeyboardFocus(field = 'question') {
  if (!['question', 'apiKey', 'model'].includes(field)) throw new Error('Choose an editable overlay field.');
  if (!win || win.isDestroyed() || !win.isVisible() || passThrough) throw new Error('Show the overlay and turn off click-through before typing.');
  panel?.allowKeyboard(); applyWindowMode(); win.focus(); win.webContents.focus(); syncState();
  return currentState();
}
function registerIPC() {
  handle('state', currentState); handle('ask', ask);
  handle('focus-field', requestKeyboardFocus);
  handle('cancel', () => { active?.controller.abort(); return true; });
  handle('set-attachments', ids => {
    const question = validateQuestion({ text: 'attachments', imageIds: ids });
    if (question.imageIds.some(id => !images.has(id))) throw new Error('An attachment expired. Attach the image again.');
    draftImageIds.clear(); for (const id of question.imageIds) draftImageIds.add(id);
    return true;
  });
  handle('upload', async (limit = MAX_IMAGES) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question.`);
    const result = await dialog.showOpenDialog(win, { title: 'Attach images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Question images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (result.canceled || !result.filePaths.length) return [];
    if (result.filePaths.length > limit) throw new Error(`Choose up to ${limit} more image${limit === 1 ? '' : 's'}.`);
    const selected = result.filePaths.map(file => {
      if (fs.statSync(file).size > MAX_IMAGE_BYTES) throw new Error('Choose images up to 10 MB each.');
      const bytes = fs.readFileSync(file); inspectImage(bytes);
      return { native: nativeImage.createFromBuffer(bytes), name: path.basename(file) };
    });
    const added = [];
    try { for (const item of selected) added.push(addImage(item.native, item.name)); return added; }
    catch (error) { for (const item of added) images.delete(item.id); throw error; }
  });
  handle('paste-image', async () => {
    const added = [];
    try {
      for (const item of await clipboard.read()) {
        const mime = item.types.find(type => ['image/png', 'image/jpeg'].includes(type));
        if (!mime) continue;
        const blob = await item.getType(mime);
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('Choose a PNG or JPEG up to 10 MB.');
        const bytes = Buffer.from(await blob.arrayBuffer()); inspectImage(bytes);
        if (added.length >= MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question.`);
        added.push(addImage(nativeImage.createFromBuffer(bytes), 'Clipboard image'));
      }
      return added;
    } catch (error) { for (const item of added) images.delete(item.id); throw error; }
  });
  handle('import-image', importImage); handle('capture', capture);
  handle('release-image', id => { draftImageIds.delete(id); if (typeof id === 'string' && !history.some(message => imageIds(message).includes(id)) && !imageIds(active?.question).includes(id) && !imageIds(lastAttempt?.question).includes(id)) images.delete(id); return true; });
  handle('save-settings', saveSettings);
  handle('refresh-models', refreshModels);
  handle('screen-settings', openScreenSettings);
  handle('set-recovery-enabled', setRecoveryEnabled);
  handle('new-chat', () => changeConversation());
  handle('open-chat', id => { if (typeof id !== 'string') throw new Error('Choose a saved chat.'); return changeConversation(id); });
  handle('delete-chat', id => {
    if (typeof id !== 'string' || !archivedChats.some(chat => chat.id === id)) throw new Error('Choose a saved chat.');
    const next = archivedChats.filter(chat => chat.id !== id);
    if (settings.rememberHistory && store.available()) store.write('chats.enc', { current: diskHistory(history), archive: next }, true);
    archivedChats = next; syncState(); return currentState();
  });
  handle('clear', () => {
    if (active) throw new Error('Stop the answer before clearing the conversation.');
    // Remove the saved file first, so a disk failure does not falsely report deletion.
    interruptedWork.clear();
    if (settings.rememberHistory && store.available()) store.write('chats.enc', { current: [], archive: archivedChats }, true);
    store.remove('conversation.enc'); history = []; lastAttempt = null; images.clear(); draftImageIds.clear(); syncState(); return true;
  });
  handle('export', async () => {
    if (!history.length) throw new Error('There is no completed conversation to export.');
    const result = await dialog.showSaveDialog(win, { title: 'Export conversation', defaultPath: 'OpenCluely-conversation.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    const content = history.map(message => `## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${imageNames(message).map(name => `[Image: ${name}]\n\n`).join('')}${message.text}\n`).join('\n');
    fs.writeFileSync(result.filePath, content, 'utf8'); return true;
  });
  handle('hide', hideOverlay); handle('pass-through', togglePassThrough); handle('compact', toggleCompact);
  handle('copy', async text => { if (typeof text !== 'string' || text.length > 80000) throw new Error('Invalid clipboard text.'); await clipboard.writeText(text); return true; });
  handle('quit', requestQuit);
}
function registerShortcuts() {
  const commands = [
    ['CommandOrControl+Alt+Space', 'Show / hide', toggleVisibility],
    ['CommandOrControl+Alt+T', 'Type a question', () => showOverlay(true)],
    ['CommandOrControl+Alt+I', 'Click-through', togglePassThrough],
    ['CommandOrControl+Alt+S', 'Screenshot', async () => {
      try { if (draftImageIds.size >= MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question. Remove one before taking another screenshot.`); const image = await capture(); showOverlay(false); emit({ type: 'attach', image }); }
      catch (error) { showOverlay(false); emit({ type: 'notice', text: error.message }); }
    }]
  ];
  for (const [accelerator, label, action] of commands) {
    let registered = false;
    try { registered = globalShortcut.register(accelerator, action); } catch { /* Surface conflicts in UI. */ }
    shortcuts.push({ accelerator, label, registered, display: shortcutLabel(accelerator) });
    if (!registered) warn(`${label} shortcut is unavailable because another app may be using it. Use the tray or overlay buttons.`);
  }
}

async function initialize() {
  recovery = new WindowsRecovery({
    available: process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && !testMode,
    directory: path.join(app.getPath('userData'), 'recovery'),
    appPath: path.dirname(path.dirname(path.dirname(process.execPath))),
    executablePath: process.execPath,
    helperPath: path.join(process.resourcesPath, 'app.asar.unpacked', 'overlay', 'native', 'bin', `recovery-helper-win32-${process.arch}.exe`),
    onChange: () => { if (settings && store) syncState(); }
  });
  const automaticSession = recoverySession(process.argv);
  // A delayed launch request from a supervisor that the user paused must not
  // silently turn recovery back on, show UI, or touch the Keychain.
  if (automaticSession !== null && (!recovery.available || !recovery.acceptsSession(automaticSession))) { app.exit(0); return; }
  if (platform.mac) {
    app.setActivationPolicy('accessory');
    // Native edit roles enable Command+C/V/X/A in the frameless accessory window.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.getName(), submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: 'Quit OpenCluely', accelerator: 'Command+Q', click: requestQuit }
      ] }, { role: 'editMenu' },
      { label: 'Overlay', submenu: [{ label: 'Settings…', accelerator: 'Command+,', click: () => { showOverlay(true); emit({ type: 'open-settings' }); } }] }
    ]));
  }
  const login = loginState();
  launchHidden = startHidden(process.argv, login);
  store = new Store(app.getPath('userData'), safeStorage, warn);
  const loaded = store.read('preferences.json', DEFAULTS);
  try { settings = validateSettings(loaded); settings.bounds = loaded.bounds && ['x','y','width','height'].every(key => Number.isFinite(loaded.bounds[key])) ? loaded.bounds : null; }
  catch { settings = { ...DEFAULTS, models: { ...DEFAULTS.models } }; warn('Saved settings were invalid. Defaults are in use.'); }
  if (canStartAtLogin() && typeof login.openAtLogin === 'boolean') settings.launchAtLogin = login.openAtLogin;
  if (!store.available()) { settings.rememberHistory = false; warn('Secure storage is unavailable. API keys and history cannot be saved.'); }
  const credentials = store.read('credentials.enc', {}, true);
  for (const provider of PROVIDERS) if (typeof credentials?.[provider] === 'string' && credentials[provider].length <= 500) keys[provider] = credentials[provider];
  restoreModelCatalog();
  if (settings.rememberHistory) {
    try { history = validateHistory(store.read('conversation.enc', [], true)); }
    catch { warn('Saved conversation could not be restored.'); }
    try {
      const saved = store.read('chats.enc', null, true);
      if (saved !== null && (!Array.isArray(saved.archive) || saved.archive.length > 100)) throw new Error('Invalid chat archive.');
      archivedChats = (saved?.archive || []).map(chat => {
        if (!chat || typeof chat.id !== 'string' || typeof chat.title !== 'string' || typeof chat.updatedAt !== 'string') throw new Error('Invalid chat.');
        return { id: chat.id, title: chat.title.slice(0, 80), updatedAt: chat.updatedAt, history: validateHistory(chat.history) };
      });
      if (saved !== null) history = validateHistory(saved.current);
    } catch { warn('Previous chats could not be restored. The original file is preserved until the next successful save.'); }
  }
  interruptedWork = new InterruptedWork({ store, enabled: () => settings.rememberHistory && store.available(), report: warn });
  // Temporary Keychain unavailability must not delete an existing checkpoint.
  lastAttempt = store.available() ? interruptedWork.restore(history) : null;
  const overlaySession = session.fromPartition('overlay-memory');
  overlaySession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  overlaySession.setPermissionCheckHandler(() => false);
  // The renderer uses only packaged files and data-URL image previews. AI networking stays in main.
  overlaySession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'devtools:'].some(prefix => details.url.startsWith(prefix)) }));
  createWindow();
  const trayImage = nativeImage.createFromPath(path.join(__dirname, 'assets', platform.mac ? 'trayTemplate.png' : 'tray.png'));
  if (platform.mac) trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.setToolTip(`OpenCluely Overlay — ${shortcutLabel('CommandOrControl+Alt+Space')}`);
  if (!platform.mac) tray.on('click', () => showOverlay(false));
  updateTray();
  registerIPC(); registerShortcuts();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => { fitWindow(); syncState(); });
  powerMonitor.on('resume', () => { applyWindowMode(); fitWindow(); syncState(); });
  powerMonitor.on('suspend', () => { active?.controller.abort(); });
  powerMonitor.on('shutdown', () => allowSessionEnd(true));
  if (recovery.available) {
    try { await recovery.enable({ sessionId: automaticSession }); }
    catch { log('automatic-reopening-start-failed'); }
  }
  initializationComplete = true;
  log('app-ready');
  if (!testMode) void refreshModels();
  if (testMode) {
    await require(interruptionTestMode ? '../tests/interruption-electron' : quitTestMode ? '../tests/quit-electron' : '../tests/smoke-electron').run({ app, getWindow: () => win, store, currentState, ask, saveSettings, refreshModels, requestKeyboardFocus, importImage, capture, images, showOverlay, hideOverlay, togglePassThrough, toggleCompact, requestQuit, setRecoveryEnabled, changeConversation, cancelSessionEnd,
      setModelLister: fn => { modelLister = fn; },
      setQuitConfirmationFunction: fn => { quitConfirmationFunction = fn; },
      setRecoveryController: controller => { const previous = recovery; recovery = controller; syncState(); return previous; },
      setAnswerFunction: fn => { answerFunction = fn; }, setKeyValidator: fn => { keyValidator = fn; }, setScreenPermissionFunction: fn => { screenPermissionFunction = fn; }, cancel: () => active?.controller.abort(), clear: () => { history = []; images.clear(); lastAttempt = null; persistHistory(); syncState(); },
      getHistory: () => history, interruptedWork });
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (recoverySession(argv) === null) manualReopen(); });
  app.on('activate', manualReopen);
  app.on('window-all-closed', () => { /* The tray owns lifetime; closing the UI keeps the app running. */ });
  app.on('before-quit', event => {
    if (quitGuard.preventQuit()) { event.preventDefault(); return; }
    interruptedWork?.flush();
    // An accepted ordinary quit is intentional; only abnormal exits should reopen.
    recovery?.disarmForSessionEnd();
    quitting = true; active?.controller.abort(); clearTimeout(geometryTimer);
    if (settings && store) {
      if (win && !win.isDestroyed()) { const bounds = win.getBounds(); settings.bounds = { ...bounds, height: settings.compact ? normalBounds?.height || 700 : bounds.height }; }
      try { persistSettings(); persistHistory(); } catch { log('shutdown-save-failed'); }
    }
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
  app.whenReady().then(initialize).catch(error => {
    log('startup-failed');
    if (testMode) { console.error(error); app.exit(1); }
    else { dialog.showErrorBox('OpenCluely could not start', 'The app could not initialize. Reopen it or reinstall the app. Your saved data is preserved.'); app.exit(1); }
  });
}
process.on('uncaughtException', () => { log('main-process-fatal'); app.exit(1); });
process.on('unhandledRejection', () => { log('unhandled-operation'); });
