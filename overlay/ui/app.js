'use strict';
const $ = id => document.getElementById(id);
const api = window.overlay;
let state, attachments = [], sending = false, importing = false, streamTimer, toastTimer, streamView, renderedSignature = '', autoScroll = true, dragDepth = 0;
const MAX_IMAGES = 10;
let composerInitialized = false;
const models = {};
let deletingChatId = null;
const question = $('question');
const messageContainer = $('messages');
const content = $('content');
let selectedDisplay = sessionStorage.getItem('display') || '';
let recoveryRequested = null, recoveryActionError = '';
let backdropFrame = 0;
let themeChanging = false;
let chatgptActionPending = false, chatgptSigningIn = false, chatgptActionError = '', signingOutProfile = null, settingsSaving = false;
let codexActionPending = false, codexActionError = '';
const accountProvider = provider => provider === 'chatgpt' || provider === 'codex';
const codexState = () => state?.codex || { connected: false, busy: false, signingIn: false };
const chatgptState = () => state?.chatgpt || { profiles: [], connected: false, sharing: false, busy: false };
function selectedChatGPTProfile(account = chatgptState()) { return account.profiles?.find(profile => profile.id === account.activeProfileId); }
function chatgptNeedsSignIn(account = chatgptState()) { return !!(account.needsSignIn || selectedChatGPTProfile(account)?.needsSignIn); }
function connectionReady(provider = state?.settings.provider) { const account = chatgptState(); return provider === 'codex' ? !!codexState().connected : provider === 'chatgpt' ? !!(account.connected && account.sharing && !chatgptNeedsSignIn(account)) : !!state?.keyStatus?.[provider]; }
function focusQuestion() { if (!document.querySelector('dialog[open]') && !state?.settings.compact) question.focus(); }
// Only a real pointer action on our own editable field may request OS focus.
// DOM focus during state updates, image attachment, or recovery stays passive.
document.addEventListener('pointerdown', guard(async event => {
  const field = event.target.closest?.('#question, #apiKey, #model');
  if (event.isTrusted && field && !field.disabled && !field.readOnly && state?.panelBehavior?.typingRequiresActivation &&
    !(state.panelBehavior.keyboardFocus && document.hasFocus())) await call('focusField', field.id);
}), true);

// The app background has holes behind visible code boxes. Otherwise an opaque
// app background would impose a minimum opacity on a translucent code box.
function updateBackdrop() {
  backdropFrame = 0;
  const width = innerWidth, height = innerHeight;
  let path = `M0 0H${width}V${height}H0Z`;
  const viewport = content.getBoundingClientRect();
  const rightEdge = viewport.left + content.clientWidth;
  if (content.clientHeight) for (const pre of messageContainer.querySelectorAll('pre')) {
    const rect = pre.getBoundingClientRect();
    const left = Math.max(0, viewport.left, rect.left), right = Math.min(width, rightEdge, rect.right);
    const top = Math.max(0, viewport.top, rect.top), bottom = Math.min(height, viewport.bottom, rect.bottom);
    if (right <= left || bottom <= top) continue;
    const radius = Math.min(parseFloat(getComputedStyle(pre).borderTopLeftRadius) || 0, (right - left) / 2, (bottom - top) / 2);
    const tl = top === rect.top && left === rect.left ? radius : 0;
    const tr = top === rect.top && right === rect.right ? radius : 0;
    const br = bottom === rect.bottom && right === rect.right ? radius : 0;
    const bl = bottom === rect.bottom && left === rect.left ? radius : 0;
    path += `M${left + tl} ${top}H${right - tr}Q${right} ${top} ${right} ${top + tr}V${bottom - br}Q${right} ${bottom} ${right - br} ${bottom}H${left + bl}Q${left} ${bottom} ${left} ${bottom - bl}V${top + tl}Q${left} ${top} ${left + tl} ${top}Z`;
  }
  $('appBackdrop').style.setProperty('--code-cutouts', `path(evenodd, "${path}")`);
}
function scheduleBackdrop() { if (!backdropFrame) backdropFrame = requestAnimationFrame(updateBackdrop); }

function fadeProse(element) {
  for (const node of [...element.childNodes]) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches('pre')) continue;
      if (node.querySelector('pre')) { node.classList.add('contains-code'); fadeProse(node); }
      else node.classList.add('app-opacity');
    } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const span = document.createElement('span'); span.className = 'app-opacity';
      node.replaceWith(span); span.append(node);
    }
  }
}

async function call(method, ...args) {
  const result = await api[method](...args);
  if (!result?.ok) throw new Error(result?.error || 'This action could not be completed.');
  return result.value;
}
function notify(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
function guard(fn) { return async (...args) => { try { return await fn(...args); } catch (error) { notify(error.message); } }; }
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#${name}`); svg.append(use); return svg; }
function scrollToLatest(force = false) { if (autoScroll || force) { content.scrollTop = content.scrollHeight; $('jumpButton').hidden = true; } else $('jumpButton').hidden = false; }
function richText(element, text) {
  element.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), {
    FORBID_TAGS: ['img', 'svg', 'style', 'input', 'button', 'form', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name', 'target'], ALLOW_DATA_ATTR: false
  });
  element.querySelectorAll('pre').forEach(pre => {
    const copy = document.createElement('button'); copy.className = 'copy-code'; copy.type = 'button'; copy.textContent = 'Copy';
    copy.addEventListener('click', guard(async () => { await call('copy', pre.querySelector('code')?.textContent || pre.textContent); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1300); }));
    pre.prepend(copy);
  });
  fadeProse(element);
  scheduleBackdrop();
  element.querySelectorAll('a').forEach(link => link.addEventListener('click', guard(async event => {
    event.preventDefault(); const url = link.getAttribute('href');
    if (url && /^https?:\/\//i.test(url)) { await call('copy', url); notify('Link copied. Paste it into your browser to open it.'); }
  })));
}
function createMessage(role, text, metadata = {}) {
  const card = document.createElement('article'); card.className = `message ${role}`;
  const header = document.createElement('div'); header.className = 'message-header';
  const label = document.createElement('span'); label.textContent = role === 'user' ? 'YOU' : metadata.provider === 'codex' ? 'CODEX' : metadata.provider === 'chatgpt' ? 'CHATGPT PLAN' : metadata.provider === 'openai' ? 'OPENAI API' : metadata.provider === 'gemini' ? 'GEMINI' : 'CLAUDE'; header.append(label);
  if (role === 'assistant' && metadata.model) { const model = document.createElement('span'); model.className = 'model-label'; model.textContent = metadata.model; header.append(model); }
  card.append(header);
  const imageNames = metadata.imageNames || metadata.images?.map(image => image.name) || (metadata.imageName ? [metadata.imageName] : []);
  for (const name of imageNames) {
    const reference = document.createElement('div'); reference.className = 'image-reference'; reference.append(icon('image'), document.createTextNode(name)); card.append(reference);
  }
  const body = document.createElement('div'); body.className = 'message-body';
  if (role === 'user') body.textContent = text;
  else if (text) richText(body, text);
  card.append(body); messageContainer.append(card);
  if (role === 'assistant' && text && !metadata.streaming) addCopy(card, text);
  return { card, body, text, id: metadata.id };
}
function addCopy(card, text) {
  if (card.querySelector('.message-actions')) return;
  const actions = document.createElement('div'); actions.className = 'message-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.append(icon('copy'), document.createTextNode('Copy answer'));
  copy.addEventListener('click', guard(async () => { await call('copy', text); notify('Answer copied.'); }));
  actions.append(copy); card.append(actions);
}
function showFailure(view, attempt) {
  if (attempt.text) richText(view.body, attempt.text); else view.body.textContent = '';
  const error = document.createElement('div'); error.className = 'message-error'; error.textContent = attempt.error; view.card.append(error);
  const retry = document.createElement('button'); retry.className = 'retry-button'; retry.type = 'button'; retry.textContent = attempt.needsAttachment ? 'Restore question to attach image' : 'Retry question';
  retry.addEventListener('click', guard(() => {
    if (!attempt.needsAttachment) return submit(attempt.question);
    question.value = attempt.question.text; sessionStorage.setItem('draft', question.value);
    resizeQuestion(); updateControls(); focusQuestion();
    notify('Attach the original images again, then send the question.');
  })); view.card.append(retry);
  if (attempt.provider === 'chatgpt' && (attempt.action === 'manage-usage' || attempt.code === 'subscription_sharing_usage_limit_exceeded')) {
    const usage = document.createElement('button'); usage.type = 'button'; usage.className = 'retry-button manage-usage-button'; usage.textContent = 'Manage ChatGPT usage';
    usage.addEventListener('click', guard(() => call('chatgptManageUsage'))); view.card.append(usage);
  }
  if (attempt.text) addCopy(view.card, attempt.text);
}
function renderTimeline() {
  if (!state) return;
  const signature = state.history.map(message => message.id).join('|') + `/${state.active?.id || ''}/${state.lastAttempt?.id || ''}`;
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  clearTimeout(streamTimer); messageContainer.replaceChildren(); streamView = null;
  for (const message of state.history) createMessage(message.role, message.text, message);
  if (state.active) {
    createMessage('user', state.active.question.text, { images: state.active.images });
    streamView = createMessage('assistant', state.active.text, { ...state.active, streaming: true });
    if (!state.active.text) streamView.body.innerHTML = '<div class="streaming-indicator"><span></span><span></span><span></span></div>';
  } else if (state.lastAttempt) {
    createMessage('user', state.lastAttempt.question.text, { images: state.lastAttempt.images, imageNames: state.lastAttempt.imageNames, imageName: state.lastAttempt.imageName });
    const view = createMessage('assistant', '', state.lastAttempt); showFailure(view, state.lastAttempt);
  }
  $('welcome').hidden = !!(state.history.length || state.active || state.lastAttempt);
  scrollToLatest();
}
function updateControls() {
  const busy = sending || !!state?.busy;
  $('sendButton').disabled = busy || importing || !(question.value.trim() || attachments.length);
  $('provider').disabled = busy;
  const selectedProvider = state?.settings.provider;
  const accountUnavailable = accountProvider(selectedProvider) && (!connectionReady() || !state?.modelCatalog?.[selectedProvider]?.length ||
    (selectedProvider === 'chatgpt' ? chatgptState().busy || chatgptActionPending : codexState().busy || codexActionPending));
  $('quickModel').disabled = busy || accountUnavailable;
  $('quickEffort').disabled = busy || accountUnavailable || !$('quickEffort').options.length || $('quickEffort').options.length === 1;
  $('newChatButton').disabled = busy || importing || !!state?.captureBusy;
  $('newChatButton').title = busy ? 'Stop the answer before starting a new chat' : 'Save this conversation and start a new one';
  $('openChatButton').disabled = busy || !$('chatSelect').value;
  $('deleteChatButton').disabled = !$('chatSelect').value;
  $('captureButton').disabled = !!state?.captureBusy || importing || attachments.length >= MAX_IMAGES;
  $('uploadButton').disabled = importing || attachments.length >= MAX_IMAGES;
  $('removeImages').disabled = importing || sending;
  document.querySelectorAll('.remove-image').forEach(button => { button.disabled = importing || sending; });
  $('requestStatus').hidden = !busy;
  $('footerStatus').textContent = busy ? 'Answering your question' : state?.passThrough ? 'Click-through enabled' : state?.panelBehavior?.typingRequiresActivation ? state.panelBehavior.keyboardFocus ? 'Typing in overlay · click browser to return' : 'Browser focus preserved · click question to type' : `Runs in your ${state?.platform.trayName || 'tray'}`;
  renderChatGPTConnection();
}
function renderChatGPTConnection() {
  const account = chatgptState(), profiles = account.profiles || [];
  const selected = selectedChatGPTProfile(account);
  const busy = !!state?.busy || !!account.busy || chatgptActionPending;
  const name = selected?.label || selected?.email || 'ChatGPT connection';
  $('chatgptConnection').hidden = $('settingsProvider').value !== 'chatgpt';
  $('chatgptAccountStrip').hidden = state?.settings.provider !== 'chatgpt';
  $('chatgptUsageLabel').textContent = `${chatgptNeedsSignIn(account) ? 'Reconnect ChatGPT' : connectionReady('chatgpt') ? 'Using ChatGPT plan' : account.connected ? 'ChatGPT plan usage not enabled' : 'Connect ChatGPT'}${selected ? ` · ${name}` : ''}`;
  $('chatgptAccountButton').title = $('chatgptUsageLabel').textContent;
  $('chatgptQuickUsage').hidden = !account.connected;
  $('chatgptProfile').replaceChildren(...profiles.map((profile, index) => new Option(profile.label || profile.email || `ChatGPT connection ${index + 1}`, profile.id)));
  $('chatgptProfile').value = account.activeProfileId || '';
  $('chatgptProfileLabel').hidden = !profiles.length;
  $('chatgptProfile').disabled = busy || profiles.length < 2;
  $('chatgptConnectionStatus').textContent = chatgptActionPending && !chatgptSigningIn ? 'Updating ChatGPT connection…'
    : chatgptSigningIn ? 'Complete sign-in in your browser. You can cancel here.'
      : account.busy ? 'Updating ChatGPT connection…'
    : chatgptNeedsSignIn(account) ? 'This connection needs a new sign-in.'
      : account.connected && account.sharing ? `Connected · ${name}. Using ChatGPT plan.`
        : account.connected ? `Signed in · ${name}. Enable ChatGPT plan usage to ask questions.` : 'Connect a ChatGPT account to use an eligible plan.';
  $('chatgptSignInButton').textContent = selected ? 'Reconnect with ChatGPT' : 'Continue with ChatGPT';
  $('chatgptSignInButton').disabled = busy;
  $('chatgptAddAccount').hidden = !profiles.length;
  $('chatgptAddAccount').disabled = busy;
  $('chatgptEnableUsage').hidden = !account.connected || account.sharing;
  $('chatgptEnableUsage').disabled = busy;
  $('chatgptCancelSignIn').hidden = !chatgptSigningIn;
  $('chatgptSignOut').hidden = !selected;
  $('chatgptSignOut').disabled = !!account.busy || chatgptActionPending;
  $('chatgptConnectionError').textContent = chatgptActionError || account.error || '';
  $('chatgptConnectionError').hidden = !$('chatgptConnectionError').textContent;
  $('saveButton').disabled = settingsSaving || ($('settingsProvider').value === 'chatgpt' && (!!account.busy || chatgptActionPending));
  renderCodexConnection();
}
function renderCodexConnection() {
  const account = codexState(), selected = $('settingsProvider').value === 'codex';
  const busy = account.busy || codexActionPending || state?.busy;
  $('codexConnection').hidden = !selected;
  $('codexAccountStrip').hidden = state?.settings.provider !== 'codex';
  const identity = [account.email, account.planType].filter(Boolean).join(' · ');
  $('codexUsageLabel').textContent = account.connected ? `Using Codex${identity ? ' · ' + identity : ''}` : 'Connect Codex';
  $('codexConnectionStatus').textContent = account.signingIn ? 'Complete Codex sign-in in your browser. You can cancel here.'
    : codexActionPending ? 'Updating Codex connection…' : account.connected ? `Connected to Codex${identity ? ' · ' + identity : ''}` : 'Sign in with your ChatGPT account to use Codex models.';
  $('codexSignIn').textContent = account.connected ? 'Reconnect Codex with ChatGPT' : 'Sign in to Codex with ChatGPT';
  $('codexSignIn').disabled = !!busy;
  $('codexCancelSignIn').hidden = !account.signingIn;
  $('codexSignOut').hidden = !account.connected;
  $('codexSignOut').disabled = !!account.busy || codexActionPending;
  $('codexConnectionError').textContent = codexActionError || account.error || '';
  $('codexConnectionError').hidden = !$('codexConnectionError').textContent;
  if (selected && (account.busy || codexActionPending)) $('saveButton').disabled = true;
}
async function codexAction(method) {
  if (codexActionPending) return;
  codexActionPending = true; codexActionError = ''; renderCodexConnection();
  try { const value = await call(method); applyState(value?.settings ? value : await call('state')); }
  catch (error) { codexActionError = error.message; }
  finally { codexActionPending = false; renderChatGPTConnection(); renderCatalogStatus(); updateControls(); }
}
async function chatgptAction(method, ...args) {
  if (chatgptActionPending) return;
  chatgptActionPending = true; chatgptSigningIn = method === 'chatgptSignIn'; chatgptActionError = ''; renderChatGPTConnection();
  try {
    const value = await call(method, ...args);
    applyState(value?.settings ? value : await call('state'));
  } catch (error) { chatgptActionError = error.message; }
  finally { chatgptActionPending = false; chatgptSigningIn = false; renderChatGPTConnection(); renderCatalogStatus(); updateControls(); }
}
function renderRecovery() {
  const recovery = state?.recovery;
  $('recoveryControl').hidden = !recovery?.available;
  $('recoveryEnabled').checked = !!recovery?.enabled;
  $('recoveryEnabled').disabled = !recovery?.available || !!recovery.busy || recoveryRequested !== null;
  $('quitButton').textContent = recovery?.available && recovery.enabled ? 'Quit and reopen' : 'Quit';
  $('quitCompletelyButton').hidden = !recovery?.available;
  $('quitButton').disabled = !!recovery?.busy;
  $('quitCompletelyButton').disabled = !!recovery?.busy;
  $('recoveryStatus').textContent = recoveryRequested !== null
    ? recoveryRequested ? 'Starting automatic reopening…' : 'Pausing automatic reopening…'
    : recovery?.busy ? 'Updating automatic reopening…'
      : !recovery?.available ? 'Available in the installed Windows app.'
        : recovery.enabled ? 'Automatic reopening is on.' : 'Automatic reopening is paused until the next launch.';
  const error = recoveryActionError || recovery?.error || '';
  $('recoveryError').textContent = error;
  $('recoveryError').hidden = !error;
}
function applyState(value) {
  state = value;
  const light = state.settings.theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('themeButton').setAttribute('aria-pressed', String(light));
  $('themeButton').title = `Switch to ${light ? 'dark' : 'light'} mode`;
  $('themeIcon').setAttribute('href', light ? '#moon' : '#sun');
  document.documentElement.style.setProperty('--app-opacity', String(state.settings.opacity));
  document.documentElement.style.setProperty('--code-box-opacity', String(state.settings.codeOpacity ?? 1));
  scheduleBackdrop();
  if (!composerInitialized) { attachments = value.draftImages || []; composerInitialized = true; renderAttachments(); }
  recoveryActionError = '';
  for (const shortcut of state.shortcuts) {
    document.querySelectorAll('[data-shortcut]').forEach(element => { if (element.dataset.shortcut === shortcut.label) element.textContent = shortcut.display; });
  }
  const shortcut = label => state.shortcuts.find(item => item.label === label)?.display || '';
  $('hideButton').title = `Hide to ${state.platform.trayName} · ${shortcut('Show / hide')}`;
  $('hideButton').setAttribute('aria-label', `Hide to ${state.platform.trayName}`);
  $('captureButton').title = `Capture selected display · ${shortcut('Screenshot')}`;
  $('passButton').title = `Click-through · ${shortcut('Click-through')}`;
  $('captureNote').textContent = state.platform.captureNote;
  Object.assign(models, state.settings.models);
  document.body.classList.toggle('compact', state.settings.compact);
  document.body.classList.toggle('pass-through', state.passThrough);
  $('passBanner').hidden = !state.passThrough;
  $('passButton').setAttribute('aria-pressed', String(state.passThrough));
  $('provider').value = state.settings.provider;
  fillModelOptions($('quickModel'), state.settings.provider, models[state.settings.provider]);
  fillEffortOptions($('quickEffort'), state.settings.provider, models[state.settings.provider]);
  if ($('settingsDialog').open) renderCatalogStatus();
  const selectedChat = $('chatSelect').value;
  $('chatSelect').replaceChildren(new Option('Choose a previous chat…', ''));
  for (const chat of state.archivedChats || []) $('chatSelect').append(new Option(chat.title, chat.id));
  if ((state.archivedChats || []).some(chat => chat.id === selectedChat)) $('chatSelect').value = selectedChat;
  const chatgptSelected = accountProvider(state.settings.provider);
  const accountName = state.settings.provider === 'codex' ? 'Codex' : 'ChatGPT';
  $('setupNote').hidden = connectionReady();
  $('setupLead').textContent = chatgptSelected ? `Connect your ${accountName} account in ` : 'Add your API key in ';
  $('setupTail').textContent = chatgptSelected ? ' to use your plan.' : ' to get started.';
  $('settingsWarnings').textContent = state.warnings.join('\n'); $('settingsWarnings').hidden = !state.warnings.length;
  renderTimeline(); updateControls(); renderRecovery(); window.overlaySelects?.refresh();
}
function renderAttachments() {
  $('attachment').hidden = !attachments.length;
  $('attachmentCount').textContent = `${attachments.length} / ${MAX_IMAGES} images`;
  $('attachmentList').replaceChildren();
  for (const image of attachments) {
    const row = document.createElement('div'); row.className = 'attachment'; row.dataset.imageId = image.id;
    const preview = document.createElement('img'); preview.src = image.preview; preview.alt = image.name;
    const info = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = image.name;
    const size = document.createElement('span'); size.textContent = `${image.width} × ${image.height}`;
    info.append(name, size);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button remove-image';
    remove.setAttribute('aria-label', `Remove ${image.name}`); remove.title = `Remove ${image.name}`; remove.append(icon('close'));
    remove.addEventListener('click', guard(() => removeAttachments(image.id)));
    row.append(preview, info, remove); $('attachmentList').append(row);
  }
}
async function setAttachments(next) {
  await call('setAttachments', next.map(image => image.id));
  const previous = attachments; attachments = next;
  renderAttachments(); updateControls();
  for (const image of previous) if (!next.some(item => item.id === image.id)) void call('releaseImage', image.id).catch(() => {});
}
async function removeAttachments(id = null) {
  if (importing || sending) return;
  importing = true; updateControls();
  try { await setAttachments(id ? attachments.filter(image => image.id !== id) : []); }
  finally { importing = false; updateControls(); }
}
async function loadAttachments(action) {
  if (importing || sending) return;
  if (attachments.length >= MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question. Remove one to add another.`);
  importing = true; updateControls();
  let added = [];
  try {
    const result = await action(MAX_IMAGES - attachments.length);
    added = (Array.isArray(result) ? result : result ? [result] : []).filter(image => !attachments.some(item => item.id === image.id));
    if (added.length + attachments.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question.`);
    if (added.length) { await setAttachments([...attachments, ...added]); focusQuestion(); }
  } catch (error) {
    for (const image of added) void call('releaseImage', image.id).catch(() => {});
    throw error;
  }
  finally { importing = false; updateControls(); }
}
async function submit(input = { text: question.value, imageIds: attachments.map(image => image.id) }) {
  if (sending || importing || state?.busy) return;
  if (!connectionReady()) { openSettings(); notify(accountProvider(state?.settings.provider) ? 'Connect the selected account in Settings to start answering questions.' : 'Add your API key to start answering questions.'); return; }
  if (accountProvider(state.settings.provider) && !selectedModelInfo(state.settings.provider, models[state.settings.provider])) { openSettings(); notify('Choose an available model for this connection in Settings before asking.'); return; }
  if (!input.text?.trim() && !input.imageId && !input.imageIds?.length) return;
  sending = true; updateControls(); autoScroll = true;
  try {
    await call('ask', input);
    question.value = ''; sessionStorage.removeItem('draft'); resizeQuestion(); await setAttachments([]);
  } finally { sending = false; updateControls(); }
}
function resizeQuestion() { question.style.height = 'auto'; question.style.height = `${Math.min(140, Math.max(40, question.scrollHeight))}px`; }
function populateKeyFields() {
  const scrollTop = $('settingsDialog').scrollTop;
  const provider = $('settingsProvider').value;
  fillModelOptions($('modelPreset'), provider, models[provider], true);
  $('model').value = models[provider] || ''; $('apiKey').value = '';
  updateCustomModel();
  $('openaiNote').hidden = provider !== 'openai';
  $('apiKey').placeholder = state?.keyStatus[provider] ? 'Leave blank to keep your saved key' : 'Paste your API key';
  $('keyBadge').textContent = state?.keyStatus[provider] ? 'Key saved' : 'No key yet';
  $('apiKeyLabel').hidden = accountProvider(provider);
  $('apiKey').disabled = accountProvider(provider);
  $('removeKey').hidden = accountProvider(provider) || !state?.keyStatus[provider];
  $('modelHint').textContent = provider === 'codex' ? 'Models reported by the Codex client. Account and workspace access still apply.' : provider === 'chatgpt' ? 'Models available to this ChatGPT plan connection. The ChatGPT website may offer a different list.' : 'Available chat models from your API account. Text-only models are marked.';
  renderChatGPTConnection();
  renderCatalogStatus();
  $('settingsDialog').scrollTop = scrollTop;
}
const effortLabels = { auto: 'Auto', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
function selectedModelInfo(provider, model) { return state?.modelCatalog?.[provider]?.find(item => item.id === model); }
function fillEffortOptions(select, provider, model, current = state?.settings.reasoningEfforts?.[provider]?.[model] || 'auto') {
  const levels = selectedModelInfo(provider, model)?.reasoningEfforts || [];
  const quick = select.id === 'quickEffort';
  select.replaceChildren(new Option(quick ? 'Effort: Auto' : levels.length ? 'Auto · provider default' : 'Auto · no adjustable effort', 'auto'),
    ...levels.map(value => new Option(`${quick ? 'Effort: ' : ''}${effortLabels[value] || value}`, value)));
  select.value = levels.includes(current) ? current : 'auto';
  select.disabled = !levels.length || (accountProvider(provider) && !connectionReady(provider)) || (quick && (sending || !!state?.busy));
  if (!quick) {
    const info = selectedModelInfo(provider, model);
    $('reasoningHint').textContent = !levels.length ? 'This model has no verified adjustable effort options. Auto uses its default behavior.'
      : info.reasoningMode === 'thinkingBudget' ? 'Low / Medium / High use thinking token budgets. Higher effort can take longer and cost more.'
        : 'Higher effort can take longer and cost more. Saved separately for each model.';
  }
}
let settingsCatalogSignature = '', settingsCatalogProfile = null;
function renderCatalogStatus() {
  const provider = $('settingsProvider').value, status = state?.modelStatus?.[provider];
  const count = state?.modelCatalog?.[provider]?.length || 0;
  const chatgpt = provider === 'chatgpt', account = chatgptState();
  $('refreshModels').disabled = !connectionReady(provider) || !!status?.refreshing || (chatgpt && (account.busy || chatgptActionPending));
  $('refreshModels').textContent = chatgpt ? 'Refresh ChatGPT models' : 'Refresh models / check key';
  $('keyBadge').textContent = !state?.keyStatus[provider] ? 'No key yet' : status?.source === 'live' && !status.error ? 'API access verified' : 'Key saved';
  const checked = status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : '';
  $('modelStatus').textContent = chatgpt ? status?.refreshing ? 'Refreshing models for this ChatGPT connection…'
    : !account.connected ? 'Continue with ChatGPT to load the models available to your account.'
      : !account.sharing ? 'Enable ChatGPT plan usage to load available models.'
        : status?.error ? `${status.error}${count ? ' Previously loaded models remain available.' : ''}`
          : status?.checkedAt ? `${count} models for this connection. ${status.source === 'cached' ? 'Cached' : 'Updated'} ${checked}.`
            : 'Refresh models to check what this connection can use.'
    : status?.refreshing ? 'Checking API access and refreshing models…'
    : status?.error ? `${status.error} Previous models remain available.`
      : status?.checkedAt ? `${count} chat models · ${status.total} total API models. ${status.source === 'cached' ? 'Cached' : 'Verified'} ${checked}.`
        : 'Save a key to load its available models. The starting list is shown until refreshed.';
  if (provider === 'codex') {
    $('refreshModels').disabled = !codexState().connected || !!status?.refreshing || codexState().busy || codexActionPending;
    $('refreshModels').textContent = 'Refresh Codex models';
    $('modelStatus').textContent = status?.refreshing ? 'Refreshing Codex models…' : status?.error ? status.error
      : !codexState().connected ? 'Sign in to Codex to load its model catalog.' : status?.checkedAt ? `${count} Codex models. ${status.source === 'cached' ? 'Cached' : 'Updated'} ${checked}.` : 'Refresh models for this Codex connection.';
  }
  const signature = `${provider}/${status?.checkedAt}/${status?.source}/${chatgpt ? account.activeProfileId : ''}/${(state?.modelCatalog?.[provider] || []).map(item => item.id).join(',')}`;
  if (settingsCatalogSignature !== signature) {
    settingsCatalogSignature = signature;
    const changedProfile = chatgpt && settingsCatalogProfile !== account.activeProfileId;
    const current = changedProfile ? models[provider] : $('model').value || models[provider], effort = changedProfile ? undefined : $('reasoningEffort').value;
    settingsCatalogProfile = chatgpt ? account.activeProfileId : null;
    fillModelOptions($('modelPreset'), provider, current, true);
    updateCustomModel();
    fillEffortOptions($('reasoningEffort'), provider, current, effort || undefined);
  }
  if (accountProvider(provider)) $('modelPreset').disabled = settingsSaving || !connectionReady(provider) || !count ||
    (chatgpt ? !!account.busy || chatgptActionPending : codexState().busy || codexActionPending);
}
function fillModelOptions(select, provider, current, settingsMenu = false) {
  const options = (state?.modelCatalog?.[provider] || []).map(model => new Option(model.name, model.id));
  const known = options.some(option => option.value === current);
  if (accountProvider(provider)) {
    if (!known) options.unshift(new Option(options.length ? 'Choose a model' : `Connect ${provider === 'codex' ? 'Codex' : 'ChatGPT'} to load models`, ''));
    select.replaceChildren(...options);
    select.value = known ? current : '';
    select.disabled = settingsSaving || !connectionReady(provider) || !state?.modelCatalog?.[provider]?.length || !!state?.busy ||
      (provider === 'chatgpt' ? !!chatgptState().busy || chatgptActionPending : codexState().busy || codexActionPending);
    return;
  }
  if (current && !known && !settingsMenu) options.unshift(new Option(`${current} · custom`, current));
  if (settingsMenu) options.push(new Option('Custom model ID…', '__custom__'));
  select.replaceChildren(...options);
  select.value = settingsMenu && !known ? '__custom__' : current;
  select.disabled = settingsSaving || (!settingsMenu && (sending || !!state?.busy));
}
function updateCustomModel() {
  const custom = !accountProvider($('settingsProvider').value) && $('modelPreset').value === '__custom__';
  $('customModelLabel').hidden = !custom;
  $('model').required = custom;
  if (!custom) $('model').value = $('modelPreset').value;
  fillEffortOptions($('reasoningEffort'), $('settingsProvider').value, $('model').value);
}
async function resetComposer() {
  question.value = ''; sessionStorage.removeItem('draft'); await setAttachments([]); resizeQuestion();
  autoScroll = true; $('settingsDialog').close(); focusQuestion();
}
function openSettings() {
  if (!state) return;
  if (state.settings.compact) { void call('compact').then(() => openSettings()).catch(error => notify(error.message)); return; }
  $('settingsProvider').value = state.settings.provider; populateKeyFields();
  $('opacity').value = Math.round(state.settings.opacity * 100); $('opacityValue').textContent = `${$('opacity').value}%`;
  $('codeOpacity').value = Math.round((state.settings.codeOpacity ?? 1) * 100); $('codeOpacityValue').textContent = `${$('codeOpacity').value}%`;
  $('launchAtLogin').checked = state.settings.launchAtLogin; $('rememberHistory').checked = state.settings.rememberHistory;
  $('protectFromQuit').checked = state.settings.protectFromQuit;
  $('hideFromCapture').checked = state.settings.hideFromCapture;
  $('launchAtLogin').disabled = !state.startupAvailable;
  $('launchAtLogin').parentElement.title = state.startupAvailable ? '' : state.platform.startupHint;
  $('launchAtLogin').nextElementSibling.textContent = `Start in ${state.platform.trayName} when I sign in`;
  $('displaySelect').replaceChildren(new Option('Display under the pointer', ''));
  for (const display of state.displays) $('displaySelect').append(new Option(`${display.name}${display.primary ? ' (primary)' : ''}`, display.id));
  if (selectedDisplay && !state.displays.some(display => display.id === selectedDisplay)) selectedDisplay = '';
  $('displaySelect').value = selectedDisplay;
  $('settingsError').hidden = true;
  if (!$('settingsDialog').open) $('settingsDialog').showModal();
  window.overlaySelects?.refresh();
}

api.onEvent(event => {
  if (event.type === 'state') applyState(event.value);
  else if (event.type === 'start') {
    state.busy = true; state.active = { ...event, text: '' }; state.lastAttempt = null;
    $('statusText').textContent = event.images?.length ? `Reading ${event.images.length} image${event.images.length === 1 ? '' : 's'} and your question…` : 'Thinking through your question…';
    renderTimeline(); updateControls();
  } else if (event.type === 'delta' && streamView?.id === event.id) {
    streamView.text += event.text;
    if (state.active?.id === event.id) state.active.text = streamView.text;
    if (!streamTimer) streamTimer = setTimeout(() => { streamTimer = null; if (streamView) { richText(streamView.body, streamView.text); scrollToLatest(); } }, 90);
    $('statusText').textContent = 'Answer is arriving…';
  } else if (event.type === 'done' && streamView?.id === event.id) {
    clearTimeout(streamTimer); streamTimer = null; richText(streamView.body, event.text); addCopy(streamView.card, event.text);
    if (event.truncated) notify('The answer reached the model output limit. Ask it to continue.');
    scrollToLatest();
  } else if (event.type === 'error' && streamView?.id === event.id) {
    clearTimeout(streamTimer); streamTimer = null; showFailure(streamView, event); scrollToLatest();
  } else if (event.type === 'status') $('statusText').textContent = event.text;
  else if (event.type === 'attach') {
    if (importing || sending || attachments.length >= MAX_IMAGES) { void call('releaseImage', event.image.id); notify('Remove an image or wait for the current operation before adding another.'); return; }
    void loadAttachments(() => event.image).catch(error => notify(error.message));
    if (state?.settings.compact) void call('compact').catch(error => notify(error.message));
  }
  else if (event.type === 'notice') notify(event.text);
  else if (event.type === 'open-settings') openSettings();
  else if (event.type === 'focus-input') focusQuestion();
});

$('questionForm').addEventListener('submit', guard(async event => { event.preventDefault(); await submit(); }));
question.addEventListener('input', () => { sessionStorage.setItem('draft', question.value); resizeQuestion(); updateControls(); });
question.addEventListener('keydown', guard(async event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); await submit(); } }));
$('uploadButton').addEventListener('click', guard(() => loadAttachments(limit => call('upload', limit))));
$('captureButton').addEventListener('click', guard(() => loadAttachments(() => call('capture', selectedDisplay || undefined))));
$('removeImages').addEventListener('click', guard(() => removeAttachments()));
$('hideButton').addEventListener('click', guard(() => call('hide')));
$('themeButton').addEventListener('click', guard(async () => {
  if (themeChanging || !state) return;
  themeChanging = true; $('themeButton').disabled = true;
  try { applyState(await call('setTheme', state.settings.theme === 'light' ? 'dark' : 'light')); }
  finally { themeChanging = false; $('themeButton').disabled = false; }
}));
$('compactButton').addEventListener('click', guard(() => call('compact')));
$('passButton').addEventListener('click', guard(() => call('passThrough')));
$('stopButton').addEventListener('click', guard(async () => { await call('cancel'); $('statusText').textContent = 'Stopping…'; }));
$('provider').addEventListener('change', guard(async () => { try { applyState(await call('saveSettings', { provider: $('provider').value })); } finally { $('provider').value = state.settings.provider; } }));
$('quickEffort').addEventListener('change', guard(async () => {
  const provider = state.settings.provider, model = models[provider];
  try { applyState(await call('saveSettings', { reasoningEfforts: { [provider]: { [model]: $('quickEffort').value } } })); }
  finally { fillEffortOptions($('quickEffort'), provider, model); }
}));
$('quickModel').addEventListener('change', guard(async () => {
  try { applyState(await call('saveSettings', { models: { [state.settings.provider]: $('quickModel').value } })); }
  finally { fillModelOptions($('quickModel'), state.settings.provider, models[state.settings.provider]); }
}));
$('newChatButton').addEventListener('click', guard(async () => { applyState(await call('newChat')); await resetComposer(); notify('New chat started. Previous conversation is in Settings → Previous chats.'); }));
$('chatSelect').addEventListener('change', updateControls);
$('openChatButton').addEventListener('click', guard(async () => { applyState(await call('openChat', $('chatSelect').value)); await resetComposer(); }));
$('deleteChatButton').addEventListener('click', () => {
  deletingChatId = $('chatSelect').value;
  $('deleteChatTitle').textContent = (state.archivedChats || []).find(chat => chat.id === deletingChatId)?.title || '';
  $('deleteChatDialog').showModal();
});
$('cancelDeleteChat').addEventListener('click', () => { deletingChatId = null; $('deleteChatDialog').close(); });
$('confirmDeleteChat').addEventListener('click', guard(async () => { applyState(await call('deleteChat', deletingChatId)); deletingChatId = null; $('deleteChatDialog').close(); notify('Saved chat deleted.'); }));
$('settingsButton').addEventListener('click', openSettings); $('setupButton').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { $('apiKey').value = ''; $('settingsDialog').close(); });
$('settingsDialog').addEventListener('close', () => { $('apiKey').value = ''; });
$('settingsProvider').addEventListener('change', populateKeyFields);
$('chatgptAccountButton').addEventListener('click', openSettings);
$('codexAccountButton').addEventListener('click', openSettings);
$('codexSignIn').addEventListener('click', () => codexAction('codexSignIn'));
$('codexCancelSignIn').addEventListener('click', guard(async () => { const value = await call('codexCancelSignIn'); applyState(value?.settings ? value : await call('state')); }));
$('codexSignOut').addEventListener('click', () => $('codexSignOutDialog').showModal());
$('cancelCodexSignOut').addEventListener('click', () => $('codexSignOutDialog').close());
$('confirmCodexSignOut').addEventListener('click', () => { $('codexSignOutDialog').close(); void codexAction('codexSignOut'); });
$('codexManageUsage').addEventListener('click', guard(() => call('chatgptManageUsage')));
$('chatgptSignInButton').addEventListener('click', () => chatgptAction('chatgptSignIn', { ...(chatgptState().activeProfileId ? { profileId: chatgptState().activeProfileId } : { newProfile: true }) }));
$('chatgptAddAccount').addEventListener('click', () => chatgptAction('chatgptSignIn', { newProfile: true }));
$('chatgptEnableUsage').addEventListener('click', () => chatgptAction('chatgptSignIn', { profileId: chatgptState().activeProfileId, consent: true }));
$('chatgptCancelSignIn').addEventListener('click', guard(async () => {
  const value = await call('chatgptCancelSignIn');
  applyState(value?.settings ? value : await call('state'));
}));
$('chatgptProfile').addEventListener('change', () => chatgptAction('chatgptSelectProfile', $('chatgptProfile').value));
for (const id of ['chatgptManageUsage', 'chatgptQuickUsage']) $(id).addEventListener('click', guard(() => call('chatgptManageUsage')));
$('chatgptSignOut').addEventListener('click', () => {
  signingOutProfile = chatgptState().activeProfileId;
  const profile = (chatgptState().profiles || []).find(item => item.id === signingOutProfile);
  if (!profile) return;
  $('chatgptSignOutLabel').textContent = profile.label || profile.email || 'This ChatGPT connection';
  $('chatgptSignOutDialog').showModal();
});
$('cancelChatGPTSignOut').addEventListener('click', () => { signingOutProfile = null; $('chatgptSignOutDialog').close(); });
$('confirmChatGPTSignOut').addEventListener('click', async () => {
  const profile = signingOutProfile; signingOutProfile = null; $('chatgptSignOutDialog').close();
  if (profile) await chatgptAction('chatgptSignOut', profile);
});
$('modelPreset').addEventListener('change', updateCustomModel);
$('model').addEventListener('input', updateCustomModel);
$('refreshModels').addEventListener('click', guard(async () => {
  applyState(await call('refreshModels', $('settingsProvider').value));
  renderCatalogStatus();
}));
$('opacity').addEventListener('input', () => { $('opacityValue').textContent = `${$('opacity').value}%`; });
$('codeOpacity').addEventListener('input', () => { $('codeOpacityValue').textContent = `${$('codeOpacity').value}%`; });
$('recoveryEnabled').addEventListener('change', async () => {
  if (recoveryRequested !== null || !state?.recovery?.available || state.recovery.busy) { renderRecovery(); return; }
  recoveryRequested = $('recoveryEnabled').checked;
  recoveryActionError = '';
  renderRecovery();
  try { applyState(await call('setRecoveryEnabled', recoveryRequested)); }
  catch (error) {
    try { applyState(await call('state')); } catch { /* Keep the last known recovery state if the refresh fails. */ }
    recoveryActionError = error.message;
  } finally { recoveryRequested = null; renderRecovery(); }
});
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('saveButton').disabled) return;
  $('settingsError').hidden = true;
  settingsSaving = true;
  const controls = [...$('settingsForm').querySelectorAll('input, select, button')].map(control => [control, control.disabled]);
  try {
    const provider = $('settingsProvider').value;
    const model = $('model').value.trim();
    const input = { provider, models: { [provider]: model }, reasoningEfforts: { [provider]: { [model]: $('reasoningEffort').value } }, opacity: Number($('opacity').value) / 100, codeOpacity: Number($('codeOpacity').value) / 100, launchAtLogin: $('launchAtLogin').checked, rememberHistory: $('rememberHistory').checked, hideFromCapture: $('hideFromCapture').checked, protectFromQuit: $('protectFromQuit').checked };
    if (accountProvider(provider) && !model) { delete input.models; delete input.reasoningEfforts; }
    if (!accountProvider(provider) && $('apiKey').value.trim()) input.apiKey = $('apiKey').value.trim();
    controls.forEach(([control]) => { control.disabled = true; });
    $('saveButton').textContent = input.apiKey ? 'Verifying and saving key…' : 'Saving…';
    applyState(await call('saveSettings', input));
    selectedDisplay = $('displaySelect').value; sessionStorage.setItem('display', selectedDisplay);
    $('apiKey').value = ''; $('settingsDialog').close(); notify(input.apiKey ? 'Key verified and saved on this device.' : 'Settings saved.');
  } catch (error) { $('settingsError').textContent = error.message; $('settingsError').hidden = false; }
  finally { settingsSaving = false; controls.forEach(([control, disabled]) => { control.disabled = disabled; }); $('saveButton').textContent = 'Save settings'; renderChatGPTConnection(); }
});
$('removeKey').addEventListener('click', guard(async () => { if (accountProvider($('settingsProvider').value)) return; applyState(await call('saveSettings', { provider: $('settingsProvider').value, removeKey: true })); populateKeyFields(); notify('Saved key removed.'); }));
$('exportButton').addEventListener('click', guard(async () => { if (await call('export')) notify('Conversation exported.'); }));
$('clearButton').addEventListener('click', () => { $('clearDialog').showModal(); });
$('cancelClear').addEventListener('click', () => $('clearDialog').close());
$('confirmClear').addEventListener('click', guard(async () => { await call('clear'); await setAttachments([]); $('clearDialog').close(); $('settingsDialog').close(); notify('Conversation cleared.'); }));
$('quitButton').addEventListener('click', guard(() => call('quit')));
$('quitCompletelyButton').addEventListener('click', guard(() => call('quitCompletely')));
content.addEventListener('scroll', () => { scheduleBackdrop(); autoScroll = content.scrollHeight - content.scrollTop - content.clientHeight < 65; $('jumpButton').hidden = autoScroll || !(state?.history.length || state?.active); });
$('jumpButton').addEventListener('click', () => { autoScroll = true; scrollToLatest(true); });

async function attachFile(file) {
  if (!file || !['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a PNG or JPEG up to 10 MB.');
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('The image could not be read.')); reader.readAsDataURL(file); });
  return call('importImage', { name: file.name || 'Pasted image', data });
}
async function attachFiles(files, limit) {
  if (files.length > limit) throw new Error(`Choose up to ${limit} more image${limit === 1 ? '' : 's'}.`);
  const added = [];
  try { for (const file of files) added.push(await attachFile(file)); return added; }
  catch (error) { for (const image of added) void call('releaseImage', image.id); throw error; }
}
document.addEventListener('paste', guard(async event => {
  if ($('settingsDialog').open) return;
  const images = [...event.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile());
  if (images.length) { event.preventDefault(); await loadAttachments(limit => attachFiles(images, limit)); }
}));
document.addEventListener('dragenter', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; $('dropZone').hidden = false; } });
document.addEventListener('dragover', event => { event.preventDefault(); });
document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropZone').hidden = true; });
document.addEventListener('drop', guard(async event => { event.preventDefault(); dragDepth = 0; $('dropZone').hidden = true; await loadAttachments(limit => attachFiles([...event.dataTransfer.files], limit)); }));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) void call('hide').catch(error => notify(error.message)); });
window.addEventListener('error', () => notify('A display error occurred. Reopen the overlay from the tray.'));
window.addEventListener('unhandledrejection', () => notify('An action could not finish. Please try again.'));
question.value = sessionStorage.getItem('draft') || ''; resizeQuestion();
const backdropResize = new ResizeObserver(scheduleBackdrop);
for (const element of [$('shell'), content, messageContainer]) backdropResize.observe(element);
new MutationObserver(scheduleBackdrop).observe(messageContainer, { childList: true, subtree: true, characterData: true });
window.addEventListener('resize', scheduleBackdrop);
void call('state').then(applyState).catch(error => notify(error.message));
