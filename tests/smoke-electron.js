'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, nativeImage, desktopCapturer, screen, safeStorage, systemPreferences, dialog, clipboard, ClipboardItem, globalShortcut } = require('electron');
const { Store } = require('../overlay/storage');
const { setTimeout: delay } = require('node:timers/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

async function until(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (!(await predicate())) { if (Date.now() - started > timeoutMs) throw new Error('Desktop test timed out'); await delay(25); }
}
exports.run = async runtime => {
  const results = [], consoleErrors = [];
  const skip = (name, reason) => { results.push({ name, skipped: true, reason }); console.log(`SKIP ${name}: ${reason}`); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); throw error; }
  };
  const work = path.resolve(__dirname, '..', '.test-output');
  fs.mkdirSync(work, { recursive: true });
  const win = runtime.getWindow();
  win.webContents.on('console-message', details => { if (details.level === 'error') consoleErrors.push(details.message); });
  const js = code => Promise.race([win.webContents.executeJavaScript(code), delay(2000).then(() => { throw new Error('Renderer evaluation timed out'); })]);
  const watchdog = setTimeout(() => { console.error('Desktop suite timed out'); runtime.app.exit(1); }, 60000);
  const key = 'test-only-not-a-real-api-key';
  runtime.setKeyValidator(async () => true);
  try {
    await until(async () => await js('!!window.overlay && !!document.getElementById("provider") && document.getElementById("provider").value === "anthropic"'));
    await delay(120);
    await test('sandboxed renderer loads the interface and safe Markdown libraries', async () => {
      assert.deepEqual(await js('[typeof require, typeof window.overlay.ask, typeof marked.parse, typeof DOMPurify.sanitize]'), ['undefined','function','function','function']);
      assert.equal(win.webContents.session.isPersistent(),false, 'Renderer drafts and caches must stay in memory');
      const result = await js('window.overlay.state()'); assert.equal(result.ok,true); assert.equal(result.value.keyStatus.anthropic,false);
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true);
      assert.equal(await js('document.getElementById("welcome").hidden'),false);
      // Chromium can refuse renderer snapshots for a capture-protected window.
      win.setContentProtection(false); runtime.showOverlay(false); win.setContentProtection(false);
      try {
        await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
        await delay(350);
        const capture = await win.webContents.capturePage();
        fs.writeFileSync(path.join(work,'Overlay-preview.png'), capture.toPNG());
      } finally { win.setContentProtection(true); runtime.hideOverlay(); }
    });
    await test('native topmost, close-to-tray, click-through and compact restoration', async () => {
      assert.equal(win.isAlwaysOnTop(),true);
      const other = new BrowserWindow({show:false,width:500,height:400});
      other.destroy(); assert.equal(win.isDestroyed(),false);
      runtime.showOverlay(false); assert.equal(win.isVisible(),true);
      win.close(); assert.equal(win.isDestroyed(),false); assert.equal(win.isVisible(),false);
      runtime.showOverlay(true);
      await until(() => win.isFocused());
      runtime.togglePassThrough(); assert.equal(runtime.currentState().passThrough,true); assert.equal(win.isFocusable(),false);
      if (process.platform === 'darwin') assert.equal(win.isFocused(), false, 'Click-through must release keyboard focus on macOS');
      runtime.togglePassThrough(); assert.equal(win.isFocusable(),process.platform !== 'win32', 'Leaving click-through preserves the browser until typing is requested');
      if (process.platform === 'win32') runtime.requestKeyboardFocus('question');
      const height = win.getBounds().height;
      runtime.toggleCompact(); assert.ok(Math.abs(win.getBounds().height - 122) <= 2, 'Native border may add two pixels');
      runtime.toggleCompact(); assert.equal(win.getBounds().height,height);
      runtime.hideOverlay();
    });
    if (process.platform === 'win32') await test('Windows passive panel preserves browser focus and requests typing only for its own fields', async () => {
      const browser = new BrowserWindow({ show: false, width: 500, height: 350, webPreferences: { sandbox: true } });
      try {
        await browser.loadURL('data:text/html,<title>Windows browser focus fixture</title><input id="browser"><script>window.blurs=0;addEventListener("blur",()=>blurs++)</script>');
        runtime.hideOverlay(); browser.show(); browser.focus(); browser.webContents.focus();
        await until(() => browser.isFocused());
        const before = await browser.webContents.executeJavaScript('({ focused: document.hasFocus(), blurs })');
        runtime.showOverlay(false); await delay(100);
        assert.deepEqual(await browser.webContents.executeJavaScript('({ focused: document.hasFocus(), blurs })'), before);
        assert.equal(win.isFocusable(), false); assert.equal(runtime.currentState().panelBehavior.preventsActivation, true);
        assert.throws(() => runtime.requestKeyboardFocus('other-window'), /editable overlay field/);
        runtime.requestKeyboardFocus('question');
        await until(() => win.isFocused()); await js('document.getElementById("question").focus()');
        for (const character of 'Windows focus verification') win.webContents.sendInputEvent({ type: 'char', keyCode: character });
        await until(async () => await js('document.getElementById("question").value === "Windows focus verification"'));
        assert.equal(await browser.webContents.executeJavaScript('document.getElementById("browser").value'), '');
        assert.equal(runtime.currentState().panelBehavior.keyboardFocus, true);
        runtime.hideOverlay(); browser.show(); browser.focus(); browser.webContents.focus(); await until(() => browser.isFocused());
        runtime.showOverlay(false); await delay(100); assert.equal(await browser.webContents.executeJavaScript('document.hasFocus()'), true);
        assert.equal(win.isFocusable(), false); assert.equal(await js('document.getElementById("question").readOnly'), false);
        await js('document.getElementById("question").value="";document.getElementById("question").dispatchEvent(new Event("input"))');
      } finally { runtime.hideOverlay(); browser.destroy(); }
    });
    if (process.platform === 'win32') await test('capture protection excludes a visible overlay from native screen capture', async () => {
      assert.equal(win.isContentProtected(), true); assert.equal(runtime.currentState().captureProtectionActive, true);
      const display = screen.getPrimaryDisplay(), previous = win.getBounds();
      const bounds = { x: display.workArea.x + 50, y: display.workArea.y + 50, width: 460, height: Math.min(600,display.workArea.height-80) };
      const backdrop = new BrowserWindow({ ...bounds, frame:false, show:false, backgroundColor:'#20eb40', webPreferences:{sandbox:true} });
      try {
        await backdrop.loadURL('data:text/html,<body style="margin:0;background:%2320eb40;height:100vh"></body>');
        // Keep the fixture above unrelated desktop apps and the overlay above it.
        backdrop.setAlwaysOnTop(true, 'screen-saver');
        win.setBounds(bounds); backdrop.showInactive(); runtime.showOverlay(false); win.moveTop();
        const isGreen = async () => {
          const sources = await desktopCapturer.getSources({ types:['screen'], thumbnailSize:{ width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor) } });
          const shot = sources.find(source => source.display_id === String(display.id)).thumbnail;
          const size = shot.getSize(), actual = win.getBounds();
          const pixel = shot.crop({ x:Math.round((actual.x+80-display.bounds.x)*size.width/display.bounds.width), y:Math.round((actual.y+220-display.bounds.y)*size.height/display.bounds.height), width:1,height:1 }).toBitmap();
          return pixel[1] > 170 && pixel[0] < 110 && pixel[2] < 110;
        };
        await runtime.saveSettings({hideFromCapture:false}); assert.equal(win.isContentProtected(), false);
        await delay(300); await until(async () => !(await isGreen()));
        await runtime.saveSettings({hideFromCapture:true}); assert.equal(win.isContentProtected(), true);
        await delay(300); await until(isGreen);
        assert.equal(runtime.store.read('preferences.json',{}).hideFromCapture,true);
        runtime.togglePassThrough(); assert.equal(win.isContentProtected(), true); runtime.togglePassThrough();
        await js('document.getElementById("settingsButton").click()');
        assert.equal(await js('document.getElementById("hideFromCapture").checked'), true);
        await until(isGreen); await js('document.getElementById("closeSettings").click()');
      } finally { backdrop.destroy(); win.setBounds(previous); runtime.hideOverlay(); }
    });
    if (process.platform === 'darwin') await test('Mac workspaces, shortcut labels, capture limitation and permission recovery', async () => {
      assert.equal(win.isVisibleOnAllWorkspaces(), true);
      assert.equal(win.isContentProtected(), true);
      assert.equal(runtime.currentState().platform.trayName, 'menu bar');
      assert.ok(runtime.currentState().shortcuts.every(item => item.display.startsWith('⌘+⌥+')));
      await js('document.getElementById("settingsButton").click()');
      assert.equal(await js('document.getElementById("screenPermission").hidden'), false);
      assert.match(await js('document.getElementById("captureNote").textContent'), /ScreenCaptureKit can still record/);
      await js('document.getElementById("closeSettings").click()');
      try {
        for (const permission of ['denied', 'restricted']) {
          runtime.setScreenPermissionFunction(() => permission);
          await assert.rejects(runtime.capture(), /System Settings/);
          assert.equal(runtime.currentState().captureBusy, false);
        }
      } finally { runtime.setScreenPermissionFunction(() => systemPreferences.getMediaAccessStatus('screen')); }
    });
    await test('native encryption protects saved keys and IPC state omits secrets', async () => {
      assert.equal(runtime.store.available(),true);
      await runtime.saveSettings({provider:'anthropic',apiKey:key});
      const disk = fs.readFileSync(path.join(runtime.app.getPath('userData'),'credentials.enc'));
      assert.equal(disk.includes(Buffer.from(key)),false);
      assert.equal(runtime.store.read('credentials.enc',{},true).anthropic,key);
      assert.equal(JSON.stringify(runtime.currentState()).includes(key),false);
      await assert.rejects(runtime.ask({text:''}),/Type a question/);
    });
    await test('verified key replacement persists, preserves the other provider, and failed saves retain the old key', async () => {
      await runtime.saveSettings({provider:'gemini',apiKey:'first-gemini-test-key'});
      runtime.setKeyValidator(async (provider, candidate) => {
        assert.equal(provider,'gemini'); assert.equal(candidate,'rejected-gemini-test-key');
        throw new Error('The new API key was rejected.');
      });
      const before = fs.readFileSync(path.join(runtime.store.directory,'credentials.enc'));
      await assert.rejects(runtime.saveSettings({provider:'gemini',apiKey:'rejected-gemini-test-key',opacity:0.7}),/rejected/);
      assert.deepEqual(fs.readFileSync(path.join(runtime.store.directory,'credentials.enc')),before);
      assert.equal(runtime.currentState().settings.opacity,0.98);
      await runtime.saveSettings({apiKey:'  '});
      assert.equal(runtime.store.read('credentials.enc',{},true).gemini,'first-gemini-test-key');
      runtime.setKeyValidator(async () => { await delay(60); return true; });
      await js('document.getElementById("settingsButton").click();document.getElementById("apiKey").value="replacement-gemini-test-key";document.getElementById("settingsForm").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))');
      await until(async()=>await js('document.getElementById("saveButton").disabled'));
      await assert.rejects(runtime.saveSettings({provider:'anthropic'}),/already being saved/);
      await until(async()=>await js('!document.getElementById("settingsDialog").open'));
      const reopened = new Store(runtime.store.directory,safeStorage);
      assert.deepEqual(reopened.read('credentials.enc',{},true),{anthropic:key,gemini:'replacement-gemini-test-key'});
      assert.equal(await js('document.getElementById("apiKey").value'),'');
      assert.ok(!JSON.stringify(runtime.currentState()).includes('replacement-gemini-test-key'));
      const originalWrite = runtime.store.write.bind(runtime.store);
      runtime.store.write = (name,...args) => { if (name === 'preferences.json') throw new Error('Simulated disk failure'); return originalWrite(name,...args); };
      try { await assert.rejects(runtime.saveSettings({apiKey:'another-verified-test-key'}),/disk failure/); }
      finally { runtime.store.write = originalWrite; }
      assert.equal(reopened.read('credentials.enc',{},true).gemini,'replacement-gemini-test-key');
      assert.equal(reopened.read('credentials.enc',{},true).anthropic,key);
      await runtime.saveSettings({provider:'anthropic'});
    });
    const imageBytes = fs.readFileSync(path.resolve(__dirname,'..','overlay','assets','icon.png'));
    let received;
    runtime.setAnswerFunction(async options => {
      received = options;
      await delay(30); options.onDelta('The answer is **42**.\n\n');
      await delay(40); options.onDelta('```python\nprint(42)\n```\n\n<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>');
      return { text:'The answer is **42**.\n\n```python\nprint(42)\n```\n\n<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>', truncated:false };
    });
    await test('image paste, preview and question submission work through the real UI and IPC', async () => {
      await js(`(() => { const bytes=Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}), char=>char.charCodeAt(0)); const data=new DataTransfer(); data.items.add(new File([bytes], 'question.png', {type:'image/png'})); document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()`);
      await until(async()=>await js('!document.getElementById("attachment").hidden'));
      await js('document.getElementById("question").value="Read and answer the question in this image";document.getElementById("question").dispatchEvent(new Event("input"));document.getElementById("questionForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
      await until(()=>runtime.getHistory().length===2 && !runtime.currentState().busy);
      if (process.platform === 'win32') assert.equal(win.isFocusable(), !runtime.currentState().panelBehavior.preventsActivation, 'Sending a question preserves the current native focus policy');
      assert.equal(await js('document.getElementById("question").readOnly'), false);
      assert.equal(received.messages.at(-1).image.mime,'image/jpeg'); assert.ok(received.messages.at(-1).image.data.length>100);
      await until(async()=>await js('document.getElementById("attachment").hidden'));
      await until(async()=>await js('document.querySelectorAll(".message").length===2'));
      assert.equal(await js('!!document.querySelector(".message-body strong")'),true);
      assert.equal(await js('!!document.querySelector(".message-body pre code")'),true);
      assert.equal(await js('!!window.pwned || !!document.querySelector(".message-body img") || !!document.querySelector(".message-body script")'),false);
      assert.equal(consoleErrors.length,0,consoleErrors.join('\n'));
      await js('document.querySelector(".copy-code").click()');
    });
    await test('successful history is encrypted and follow-ups keep image context in memory', async () => {
      const disk=fs.readFileSync(path.join(runtime.app.getPath('userData'),'conversation.enc'));
      assert.equal(disk.includes(Buffer.from('answer is')),false);
      const decoded=runtime.store.read('conversation.enc',[],true); assert.equal(decoded.length,2); assert.ok(!JSON.stringify(decoded).includes('base64'));
      await runtime.ask({text:'Explain why'}); await until(()=>runtime.getHistory().length===4 && !runtime.currentState().busy);
      assert.equal(received.messages.length,3); assert.ok(received.messages[0].image);
    });
    await test('duplicate requests are blocked and cancellation does not commit incomplete turns', async () => {
      runtime.setAnswerFunction(async ({signal,onDelta})=>{onDelta('Partial answer');await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));});
      await runtime.ask({text:'long request'});
      await assert.rejects(runtime.ask({text:'duplicate'}),/already running/);
      await assert.rejects(runtime.saveSettings({provider:'gemini'}),/Stop the current/);
      runtime.cancel(); await until(()=>!runtime.currentState().busy);
      assert.equal(runtime.getHistory().length,4); assert.match(runtime.currentState().lastAttempt.error,/stopped/i);
    });
    await test('normal Quit attempts and cancelled explicit Quit preserve the running answer', async () => {
      assert.equal(runtime.currentState().settings.protectFromQuit, true);
      runtime.showOverlay(false);
      const visible = win.isVisible(), processId = process.pid;
      let confirmations = 0;
      runtime.setQuitConfirmationFunction(async () => { confirmations++; return false; });
      await runtime.ask({ text: 'Keep this unfinished answer running during a normal Quit request' });
      runtime.app.quit();
      await delay(120);
      assert.equal(runtime.currentState().busy, true, 'Blocked Quit must not cancel a running answer');
      assert.equal(win.isVisible(), visible, 'Blocked Quit must not hide, show or refocus the window');
      assert.equal(await js('window.overlay.quit().then(result => result.value)'), false);
      assert.equal(confirmations, 1);
      assert.equal(runtime.currentState().busy, true);
      assert.equal(process.pid, processId);
      assert.equal(runtime.getHistory().length, 4);
      assert.equal(await js('window.overlay.state().then(result => result.ok)'), true);
      runtime.cancel(); await until(() => !runtime.currentState().busy);
      runtime.hideOverlay();
    });
    if (process.platform === 'win32') await test('a separate Windows process can only hide the test overlay with WM_CLOSE', async () => {
      runtime.showOverlay(false);
      await runtime.ask({ text: 'Keep answering while the test helper requests a normal close' });
      const handle=win.getNativeWindowHandle();
      const hwnd=handle.length===8?handle.readBigUInt64LE(0).toString():String(handle.readUInt32LE(0));
      const helper=path.join(work,'normal-close-request.exe');
      const {stdout}=await runFile(helper,[String(process.pid),hwnd],{timeout:7000,windowsHide:true});
      assert.match(stdout,/WM_CLOSE delivered/);
      await until(()=>!win.isVisible());
      assert.equal(win.isDestroyed(),false); assert.equal(runtime.currentState().busy,true);
      assert.equal(win.isContentProtected(),true); assert.equal(win.isAlwaysOnTop(),true);
      assert.equal(runtime.getHistory().length,4);
      runtime.cancel(); await until(()=>!runtime.currentState().busy);
    });
    if (process.platform === 'win32') await test('a canceled Windows shutdown restores quit protection and prior reopening', async () => {
      const fake={available:true,enabled:true,busy:false,
        status(){return{available:true,enabled:this.enabled,busy:false,error:''};},
        disarmForSessionEnd({terminal}){this.enabled=false;this.terminal=terminal;},
        async enable(){this.enabled=true;},async disable(){this.enabled=false;}};
      const original=runtime.setRecoveryController(fake);
      try {
        win.emit('query-session-end',{});
        assert.equal(fake.enabled,false); assert.equal(fake.terminal,false);
        runtime.cancelSessionEnd(); await until(()=>fake.enabled);
        runtime.app.quit(); await delay(80);
        assert.equal(win.isDestroyed(),false);
        assert.equal(await js('window.overlay.state().then(result=>result.ok)'),true);
        // The helper may receive the broadcast and exit before the overlay does.
        fake.enabled=false; fake.shouldResumeAfterSessionEnd=()=>true;
        win.emit('query-session-end',{}); runtime.cancelSessionEnd();
        await until(()=>fake.enabled);
      } finally { runtime.cancelSessionEnd(); runtime.setRecoveryController(original); }
    });
    await test('automatic reopening can be paused during an answer and rearmed by an explicit app open', async () => {
      const fake = {
        available: true, enabled: true, busy: false,
        status() { return { available: this.available, enabled: this.enabled, busy: false, error: '' }; },
        async enable() { this.enabled = true; }, async disable() { this.enabled = false; }
      };
      const original = runtime.setRecoveryController(fake);
      try {
        await runtime.ask({ text: 'Keep answering while reopening is paused' });
        await js('document.getElementById("settingsButton").click()');
        assert.equal(await js('typeof window.overlay.setRecoveryEnabled'), 'function');
        assert.equal(await js('document.getElementById("recoveryEnabled").checked'), true);
        assert.equal(await js('document.getElementById("recoveryEnabled").disabled'), false);
        await js('document.getElementById("recoveryEnabled").click()');
        await until(() => !fake.enabled);
        await until(async () => await js('document.getElementById("recoveryStatus").textContent.includes("paused")'));
        assert.equal(runtime.currentState().busy, true, 'Pausing recovery must not stop an active answer');
        assert.equal(runtime.store.read('preferences.json', {}).recoveryEnabled, undefined, 'Recovery is a session control');
        await js('document.getElementById("closeSettings").click()');
        runtime.app.emit('activate');
        await until(() => fake.enabled);
        const bad = await js('window.overlay.setRecoveryEnabled("yes")');
        assert.equal(bad.ok, false);
      } finally {
        runtime.cancel(); await until(() => !runtime.currentState().busy);
        runtime.setRecoveryController(original); runtime.hideOverlay();
      }
      assert.equal(runtime.currentState().recovery.available, false, 'Development must not register a production service');
    });
    if (process.platform === 'darwin') {
      const helper = path.join(work, 'normal-quit-request');
      if (fs.existsSync(helper)) await test('a separate native Mac process cannot close the protected app with normal terminate()', async () => {
        runtime.hideOverlay();
        const { stdout } = await runFile(helper, [String(process.pid)], { timeout: 5000 });
        assert.match(stdout, /Normal native quit request sent/);
        await delay(250);
        assert.equal(win.isDestroyed(), false);
        assert.equal(win.isVisible(), false, 'An external quit must not bring the hidden app to the foreground');
        assert.equal(await js('window.overlay.state().then(result => result.ok)'), true);
        assert.equal(runtime.getHistory().length, 4);
      });
      else skip('a separate native Mac process cannot close the protected app with normal terminate()', 'Native fixture needs Xcode Command Line Tools');
    }
    await test('close protection is visible in Settings and persists when toggled', async () => {
      await js('document.getElementById("settingsButton").click()');
      assert.equal(await js('document.getElementById("protectFromQuit").checked'), true);
      await js('document.getElementById("closeSettings").click()');
      await runtime.saveSettings({ protectFromQuit: false });
      assert.equal(runtime.store.read('preferences.json', {}).protectFromQuit, false);
      await runtime.saveSettings({ protectFromQuit: true });
      assert.equal(runtime.store.read('preferences.json', {}).protectFromQuit, true);
    });
    await test('main frame IPC rejects a different window', async () => {
      const stranger = new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'..','overlay','preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
      await stranger.loadFile(path.resolve(__dirname,'..','overlay','ui','index.html'));
      const result=await stranger.webContents.executeJavaScript('window.overlay.state()'); assert.equal(result.ok,false); assert.match(result.error,/Unauthorized/);
      stranger.destroy();
    });
    await test('renderer crash recovers without losing completed conversation', async () => {
      win.webContents.forcefullyCrashRenderer();
      await until(async()=>{try{return await js('document.querySelectorAll(".message").length>=4');}catch{return false;}},12000);
      assert.equal(runtime.getHistory().length,4); assert.equal(win.isAlwaysOnTop(),true); assert.equal(win.isContentProtected(),true);
      assert.equal(await js('document.getElementById("provider").value'),'anthropic');
      assert.equal(win.isFocusable(), process.platform !== 'win32', 'Renderer recovery must not steal browser focus');
      assert.equal(await js('document.getElementById("question").readOnly'), false);
      if (process.platform === 'darwin') assert.equal(runtime.currentState().panelBehavior.preventsActivation, true);
    });
    await test('renderer crash preserves an active provider request and its encrypted checkpoint', async () => {
      let pendingSignal;
      runtime.setAnswerFunction(async ({ signal, onDelta }) => {
        pendingSignal = signal; onDelta('Answer surviving display reload');
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
      });
      await runtime.ask({ text: 'Keep generating through display recovery' });
      win.webContents.forcefullyCrashRenderer();
      await until(async () => { try { return await js('document.getElementById("messages").textContent.includes("Answer surviving display reload")'); } catch { return false; } }, 12000);
      assert.equal(pendingSignal.aborted, false); assert.equal(runtime.currentState().busy, true);
      runtime.interruptedWork.flush();
      assert.equal(runtime.store.read('interrupted-work.enc', null, true).text, 'Answer surviving display reload');
      runtime.cancel(); await until(() => !runtime.currentState().busy);
    });
    if (runtime.currentState().screenPermission === 'granted') await test('native display capture returns a bounded JPEG preview', async () => {
      const displays=runtime.currentState().displays;
      const image=await runtime.capture(displays.find(display=>display.primary).id);
      assert.ok(image.width<=2560 && image.height<=2560); assert.ok(image.preview.startsWith('data:image/'));
      assert.equal(nativeImage.createFromDataURL(image.preview).isEmpty(),false);
    });
    else skip('native display capture returns a bounded JPEG preview', 'Screen Recording permission has not been granted to this test app');
    await test('all providers have model dropdowns, per-provider defaults, and a working custom model option', async () => {
      const initial = runtime.currentState().settings;
      for (const provider of ['openai','gemini','anthropic']) {
        await runtime.saveSettings({ provider });
        await until(async () => await js('document.getElementById("provider").value') === provider);
        const options = await js('[...document.getElementById("quickModel").options].map(option=>option.value)');
        assert.ok(options.length >= 4);
        for (const model of runtime.currentState().modelCatalog[provider]) assert.ok(options.includes(model.id));
        await js(`document.getElementById("quickModel").value=${JSON.stringify(options[1])};document.getElementById("quickModel").dispatchEvent(new Event("change"))`);
        await until(() => runtime.currentState().settings.models[provider] === options[1]);
        await runtime.saveSettings({ models: { [provider]: initial.models[provider] } });
      }
      await js('document.getElementById("settingsButton").click();document.getElementById("modelPreset").value="__custom__";document.getElementById("modelPreset").dispatchEvent(new Event("change"));document.getElementById("model").value="claude-custom-test";document.getElementById("settingsForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
      await until(() => runtime.currentState().settings.models.anthropic === 'claude-custom-test');
      await until(async () => await js('!document.getElementById("settingsDialog").open'));
      assert.equal(await js('document.getElementById("quickModel").value'),'claude-custom-test');
      await runtime.saveSettings({ provider:'anthropic', models: initial.models });
      assert.equal(consoleErrors.length,0,consoleErrors.join('\n'));
    });
    await test('OpenAI key is encrypted and text plus image follow-ups route to the selected provider', async () => {
      runtime.setKeyValidator(async () => true);
      await runtime.saveSettings({provider:'openai',apiKey:'test-openai-not-a-real-api-key'});
      assert.equal(runtime.currentState().keyStatus.openai,true);
      assert.equal(JSON.stringify(runtime.currentState()).includes('test-openai-not-a-real-api-key'),false);
      assert.equal(fs.readFileSync(path.join(runtime.app.getPath('userData'),'credentials.enc')).includes(Buffer.from('test-openai')),false);
      runtime.setAnswerFunction(async options => {
        assert.equal(options.provider,'openai'); assert.equal(options.model,'gpt-6.1-sol');
        assert.ok(options.messages.at(-1).image); options.onDelta('OpenAI test answer');
        return {text:'OpenAI test answer',truncated:false};
      });
      const image=runtime.importImage({name:'openai-vision.png',data:imageBytes.toString('base64')});
      await runtime.ask({text:'OpenAI image test',imageId:image.id});
      await until(()=>!runtime.currentState().busy);
      await until(async()=>await js('document.querySelector(".message:last-child .message-header").textContent.includes("CHATGPT")'));
      assert.equal(runtime.getHistory().at(-1).provider,'openai');
      await runtime.saveSettings({provider:'anthropic'});
    });
    await test('live catalogs refresh through IPC, preserve failed refreshes, and per-model effort reaches generation', async () => {
      const { modelDetails } = require('../overlay/models');
      const initial = runtime.currentState().settings;
      const catalogs = structuredClone(runtime.currentState().modelCatalog);
      let calls = 0;
      runtime.setModelLister(async provider => { calls++; return { models: catalogs[provider], total: catalogs[provider].length + 10, checkedAt: new Date().toISOString() }; });
      await runtime.refreshModels();
      assert.equal(calls, 3);
      for (const provider of ['anthropic', 'gemini', 'openai']) assert.equal(runtime.currentState().modelStatus[provider].source, 'live');
      assert.ok(!fs.readFileSync(path.join(runtime.app.getPath('userData'), 'model-catalog.json'), 'utf8').includes('test-key'));
      await runtime.saveSettings({ provider: 'openai', models: { openai: 'gpt-6.1-sol' } });
      await until(async () => await js('document.getElementById("quickEffort").options.length > 1'));
      await js('document.getElementById("quickEffort").value="high";document.getElementById("quickEffort").dispatchEvent(new Event("change"))');
      await until(() => runtime.currentState().settings.reasoningEfforts.openai?.['gpt-6.1-sol'] === 'high');
      runtime.setAnswerFunction(async options => { assert.equal(options.reasoningEffort, 'high'); assert.equal(options.modelInfo.id, 'gpt-6.1-sol'); options.onDelta('Effort reached provider'); return { text: 'Effort reached provider', truncated: false }; });
      await runtime.ask({ text: 'Check selected effort' }); await until(() => !runtime.currentState().busy);
      runtime.getHistory().splice(-2);
      await runtime.saveSettings({ models: { openai: 'chat-latest' } });
      await until(async () => await js('document.getElementById("quickEffort").disabled && document.getElementById("quickEffort").value === "auto"'));
      await runtime.saveSettings({ models: { openai: 'gpt-6.1-sol' } });
      await until(async () => await js('document.getElementById("quickEffort").value === "high"'));
      await assert.rejects(runtime.saveSettings({ reasoningEfforts: { openai: { 'chat-latest': 'high' } } }), /does not support/);
      await js('document.getElementById("settingsButton").click();document.getElementById("modelPreset").value="gpt-6-luna";document.getElementById("modelPreset").dispatchEvent(new Event("change"));document.getElementById("reasoningEffort").value="medium"');
      catalogs.openai.push(modelDetails('openai', 'gpt-6-sol'));
      await js('document.getElementById("refreshModels").click()');
      await until(() => calls === 4);
      await until(async () => await js('[...document.getElementById("modelPreset").options].some(option=>option.value === "gpt-6-sol")'));
      assert.equal(await js('document.getElementById("modelPreset").value'), 'gpt-6-luna');
      assert.equal(await js('document.getElementById("reasoningEffort").value'), 'medium');
      await js('document.getElementById("settingsForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
      await until(() => runtime.currentState().settings.reasoningEfforts.openai?.['gpt-6-luna'] === 'medium');
      await until(async () => await js('!document.getElementById("settingsDialog").open'));
      const previous = structuredClone(runtime.currentState().modelCatalog.openai);
      runtime.setModelLister(async () => { throw new Error('Simulated provider unavailable'); });
      await runtime.refreshModels('openai');
      assert.deepEqual(runtime.currentState().modelCatalog.openai, previous);
      assert.match(runtime.currentState().modelStatus.openai.error, /unavailable/);
      let finish;
      calls = 0;
      runtime.setModelLister(provider => { calls++; return new Promise(resolve => { finish = () => resolve({ models: catalogs[provider], total: 20, checkedAt: new Date().toISOString() }); }); });
      const first = runtime.refreshModels('anthropic'), second = runtime.refreshModels('anthropic');
      assert.equal(calls, 1); finish(); await Promise.all([first, second]);
      runtime.setModelLister(async provider => ({ models: catalogs[provider], total: catalogs[provider].length, checkedAt: new Date().toISOString() }));
      await runtime.saveSettings({ provider: initial.provider, models: initial.models });
      assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'));
    });
    await test('file upload, drag and drop, copy, export and rejected files use the real renderer bridge', async () => {
      const imageFile=path.join(work,'upload-fixture.png'); fs.writeFileSync(imageFile,imageBytes);
      const originalOpen=dialog.showOpenDialog, originalSave=dialog.showSaveDialog;
      try {
        dialog.showOpenDialog=async()=>({canceled:false,filePaths:[imageFile]});
        await js('document.getElementById("uploadButton").click()');
        await until(async()=>await js('document.querySelector("#attachmentList strong")?.textContent === "upload-fixture.png"'));
        await js('document.getElementById("removeImages").click()');
        await until(async()=>await js('document.getElementById("attachment").hidden'));
        await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'drop.png',{type:'image/png'}));document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`);
        await until(async()=>await js('document.querySelector("#attachmentList strong")?.textContent === "drop.png"'));
        await js('document.getElementById("removeImages").click()');
        const invalid=await js('window.overlay.importImage({name:"bad.png",data:btoa("not an image")})');
        assert.equal(invalid.ok,false);
        await js('document.querySelector(".message:last-child .message-actions button").click()');
        await until(async()=>await clipboard.readText()==='OpenAI test answer');
        await clipboard.write([new ClipboardItem({'image/png':new Blob([imageBytes],{type:'image/png'})})]);
        assert.ok((await js('window.overlay.pasteImage()')).value[0].preview.startsWith('data:image/'));
        const exportFile=path.join(work,'export-fixture.md');
        dialog.showSaveDialog=async()=>({canceled:false,filePath:exportFile});
        const exported=await js('window.overlay.export()'); assert.equal(exported.value,true);
        assert.match(fs.readFileSync(exportFile,'utf8'),/OpenAI test answer/);
        dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
        assert.deepEqual((await js('window.overlay.upload()')).value,[]);
      } finally {dialog.showOpenDialog=originalOpen;dialog.showSaveDialog=originalSave;}
    });
    await test('plain interface accepts ten images, rejects overflow, restores queued previews and sends every image', async () => {
      assert.equal(await js('!!document.querySelector(".brand,.logo,.welcome-symbol,.welcome-kicker,#welcome h1,.eyebrow")'), false);
      assert.equal(await js('document.title'), 'Chat');
      const files = Array.from({ length: 11 }, (_value, index) => path.join(work, `multi-${index + 1}.png`));
      for (const file of files) fs.writeFileSync(file, imageBytes);
      const originalOpen = dialog.showOpenDialog;
      try {
        dialog.showOpenDialog = async (_window, options) => {
          assert.ok(options.properties.includes('multiSelections'));
          return { canceled: false, filePaths: files.slice(0, 10) };
        };
        await js('document.getElementById("uploadButton").click()');
        await until(async () => await js('document.querySelectorAll("#attachmentList .attachment").length === 10'));
        assert.equal(await js('document.getElementById("attachmentCount").textContent'), '10 / 10 images');
        assert.equal(await js('document.getElementById("uploadButton").disabled'), true);
        const pinned = runtime.currentState().draftImages.map(image => image.id);
        for (let i = 0; i < 24; i++) runtime.importImage({ name: `cache-${i}.png`, data: imageBytes.toString('base64') });
        assert.ok(pinned.every(id => runtime.images.has(id)), 'Queued images must survive cache eviction');
        assert.ok(runtime.images.size <= 20);
        win.webContents.forcefullyCrashRenderer();
        await until(async () => { try { return await js('document.querySelectorAll("#attachmentList .attachment").length === 10'); } catch { return false; } }, 12000);
        assert.deepEqual(runtime.currentState().draftImages.map(image => image.id), pinned, 'Renderer recovery must restore all queued previews');
        const overflow = await js(`window.overlay.ask({text:'Overflow',imageIds:${JSON.stringify([...pinned, pinned[0]])}})`);
        assert.equal(overflow.ok, false); assert.match(overflow.error, /up to 10/);
        await js('document.querySelectorAll("#attachmentList .remove-image")[2].click()');
        await until(async () => await js('document.querySelectorAll("#attachmentList .attachment").length === 9'));
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files.slice(9, 11) });
        await js('document.getElementById("uploadButton").click()');
        await until(async () => await js('document.getElementById("toast").textContent.includes("up to 1 more image")'));
        assert.equal(await js('document.querySelectorAll("#attachmentList .attachment").length'), 9);
        await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'multi-11.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
        await until(async () => await js('document.querySelectorAll("#attachmentList .attachment").length === 10'));
        const expected = [...Array.from({ length: 10 }, (_value, i) => `multi-${i + 1}.png`).filter(name => name !== 'multi-3.png'), 'multi-11.png'];
        assert.deepEqual(await js('[...document.querySelectorAll("#attachmentList strong")].map(item=>item.textContent)'), expected);
        const count = runtime.getHistory().length;
        runtime.setAnswerFunction(async options => {
          assert.deepEqual(options.messages.at(-1).images.map(image => image.name), expected);
          options.onDelta('Compared ten images'); return { text: 'Compared ten images', truncated: false };
        });
        await js('document.getElementById("question").value="Compare all ten images";document.getElementById("questionForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
        await until(() => !runtime.currentState().busy && runtime.getHistory().length === count + 2);
        await until(async () => await js('document.getElementById("attachment").hidden'));
        assert.deepEqual(runtime.getHistory().at(-2).imageNames, expected);
        assert.deepEqual(runtime.store.read('chats.enc', null, true).current.at(-2).imageNames, expected);
        assert.equal(await js('[...document.querySelectorAll(".message.user")].at(-1).querySelectorAll(".image-reference").length'), 10);
        runtime.setAnswerFunction(async options => {
          const previous = options.messages.find(message => message.text === 'Compare all ten images');
          assert.deepEqual(previous.images.map(image => image.name), expected);
          return { text: 'Ten-image follow-up', truncated: false };
        });
        await runtime.ask({ text: 'Follow up on those ten images' });
        await until(() => !runtime.currentState().busy);
        assert.equal(runtime.getHistory().at(-1).text, 'Ten-image follow-up');
        await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}),c=>c.charCodeAt(0));const dt=new DataTransfer();for(let i=0;i<5;i++)dt.items.add(new File([bytes],'paste-'+i+'.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));})()`);
        await until(async () => await js('document.querySelectorAll("#attachmentList .attachment").length === 5'));
        await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}),c=>c.charCodeAt(0));const dt=new DataTransfer();for(let i=0;i<5;i++)dt.items.add(new File([bytes],'drop-'+i+'.png',{type:'image/png'}));document.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`);
        await until(async () => await js('document.querySelectorAll("#attachmentList .attachment").length === 10'));
        assert.deepEqual(await js('[...document.querySelectorAll("#attachmentList strong")].map(item=>item.textContent)'), [...Array.from({length:5},(_value,i)=>`paste-${i}.png`), ...Array.from({length:5},(_value,i)=>`drop-${i}.png`)]);
        await js('document.getElementById("removeImages").click()');
        await until(async () => await js('document.getElementById("attachment").hidden'));
      } finally { dialog.showOpenDialog = originalOpen; }
    });
    await test('app and code-box opacity render independently, including nested, scrolling and streamed code', async () => {
      const original = { ...runtime.currentState().settings }, wasVisible = win.isVisible();
      const saveOpacity = async (entireApp, codeBox) => {
        await js('document.getElementById("settingsButton").click()');
        await until(async () => await js('document.getElementById("settingsDialog").open'));
        assert.deepEqual(await js('["opacity","codeOpacity"].map(id=>{const input=document.getElementById(id);return [input.type,input.min,input.max];})'), [['range','10','100'],['range','10','100']]);
        await js(`for(const [id,value] of ${JSON.stringify([['opacity',entireApp],['codeOpacity',codeBox]])}){const input=document.getElementById(id);input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));}`);
        assert.deepEqual(await js('[document.getElementById("opacityValue").textContent,document.getElementById("codeOpacityValue").textContent]'), [`${entireApp}%`,`${codeBox}%`]);
        await js('document.getElementById("settingsForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
        await until(() => runtime.currentState().settings.opacity === entireApp / 100 && runtime.currentState().settings.codeOpacity === codeBox / 100);
        await until(async () => await js('!document.getElementById("settingsDialog").open'));
        const saved = new Store(runtime.store.directory, safeStorage).read('preferences.json', {});
        assert.equal(saved.opacity, entireApp / 100); assert.equal(saved.codeOpacity, codeBox / 100);
        assert.equal(win.getOpacity(), 1, 'Native window opacity must remain full so it cannot multiply code transparency');
        assert.equal(Number(await js('getComputedStyle(document.documentElement).getPropertyValue("--app-opacity")')), entireApp / 100);
        assert.equal(Number(await js('getComputedStyle(document.documentElement).getPropertyValue("--code-box-opacity")')), codeBox / 100);
      };
      const assertCodeOpacity = async (expectedCode, expectedApp) => {
        const actual = await js('[...document.querySelectorAll(".message-body pre")].map(pre=>{let inherited=1;for(let parent=pre.parentElement;parent;parent=parent.parentElement)inherited*=Number(getComputedStyle(parent).opacity);return [Number(getComputedStyle(pre).opacity),inherited];})');
        assert.ok(actual.length > 0, 'The conversation must include a rendered code box');
        assert.ok(actual.every(([own, inherited]) => own === expectedCode && inherited === 1), `Code boxes must have opacity ${expectedCode} without fading ancestors: ${JSON.stringify(actual)}`);
        const prose = await js('(()=>{let result=1;for(let node=document.querySelector(".message.assistant:last-child .message-body p");node;node=node.parentElement)result*=Number(getComputedStyle(node).opacity);return result;})()');
        assert.ok(Math.abs(prose - expectedApp) < 0.001, `Ordinary answer text must follow app opacity ${expectedApp}, got ${prose}`);
      };
      const assertAlpha = async (point, expected, label) => {
        let actual;
        const sample = async () => {
          const shot = await win.webContents.capturePage({ x: Math.floor(point.x), y: Math.floor(point.y), width: 2, height: 2 });
          const pixels = shot.toBitmap(), alphas = [];
          for (let i = 3; i < pixels.length; i += 4) alphas.push(pixels[i]);
          actual = alphas.reduce((sum, value) => sum + value, 0) / alphas.length;
          return Math.abs(actual - expected) <= 4;
        };
        try { await until(sample, 4000); }
        catch {
          const details = await js(`(()=>{const content=document.getElementById('content');return {point:${JSON.stringify(point)},clip:getComputedStyle(document.getElementById('appBackdrop')).clipPath,scrollTop:content.scrollTop,viewport:content.getBoundingClientRect().toJSON(),code:[...document.querySelectorAll('.message.assistant:last-child pre')].map(pre=>({rect:pre.getBoundingClientRect().toJSON(),opacity:getComputedStyle(pre).opacity,visibility:getComputedStyle(pre).visibility})),dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.id)};})()`);
          assert.fail(`${label} pixel alpha must be ${expected} ±4; got ${actual}; renderer ${JSON.stringify(details)}`);
        }
      };
      const codePoint = () => js(`(()=>{const pre=document.querySelector('.message.assistant:last-child .message-body pre');pre.scrollIntoView({block:'center'});const r=pre.getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-5};})()`);
      const assertConversationHidden = async point => {
        assert.deepEqual(await js('[...document.querySelectorAll("#shell, #shell .message-body, #shell .message-body pre, #shell .copy-code")].map(node=>getComputedStyle(node).visibility).filter(value=>value!=="hidden")'), [], 'Every conversation element, including independently opaque code, must be hidden while a modal is open');
        assert.equal(await js('getComputedStyle(document.getElementById("appBackdrop")).clipPath'), 'none', 'Hidden code must not leave transparent cutouts in the Settings backdrop');
        win.setContentProtection(false);
        let alphas;
        try { await until(async () => {
          const shot = await win.webContents.capturePage({ x:Math.floor(point.x), y:Math.floor(point.y), width:2, height:2 });
          const pixels = shot.toBitmap(); alphas = [];
          for (let i=3; i<pixels.length; i+=4) alphas.push(pixels[i]);
          return alphas.length > 0 && alphas.every(alpha => alpha < 128);
        }, 2000); }
        catch { assert.fail(`A previously opaque code pixel must disappear behind Settings at app opacity 10%; got alpha ${alphas.join(',')}`); }
      };
      const assertConversationRestored = async () => {
        await until(async () => await js('!document.querySelector("dialog[open]")'));
        assert.equal(await js('getComputedStyle(document.getElementById("shell")).visibility'), 'visible');
        await assertCodeOpacity(1, 0.1);
        win.setContentProtection(false);
        await assertAlpha(await codePoint(), 255, 'Restored independently opaque code box');
      };
      const checkPixels = async (appOpacity, codeOpacity) => {
        // This checks the actual renderer output. CSS opacity alone can look independent
        // while an opaque parent or app backdrop still prevents real transparency.
        await delay(200);
        for (let index = 0; index < 3; index++) {
          const point = await js(`(()=>{const pre=document.querySelectorAll('.message.assistant:last-child .message-body pre')[${index}];pre.scrollIntoView({block:'center'});const r=pre.getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-5};})()`);
          await assertAlpha(point, Math.round(codeOpacity * 255), `Code box ${index + 1} at app opacity ${appOpacity}`);
        }
        await assertAlpha({ x: 15, y: 15 }, Math.round(appOpacity * 255), 'Blank app chrome');
        // A short final answer otherwise cannot scroll its first code box to the
        // viewport edge: scrollTop clamps at the conversation's bottom.
        const padding = await js('document.getElementById("messages").style.paddingBottom');
        try {
          const clipped = await js(`(()=>{const content=document.getElementById('content'),messages=document.getElementById('messages'),pre=document.querySelector('.message.assistant:last-child .message-body pre');messages.style.paddingBottom=content.clientHeight+'px';pre.scrollIntoView({block:'start'});const r=pre.getBoundingClientRect(),c=content.getBoundingClientRect();content.scrollTop+=r.top-c.top+1;const p=pre.getBoundingClientRect();return {top:p.top,bottom:p.bottom,visible:{x:p.left+p.width/2,y:c.top+5},outside:{x:p.left+p.width/2,y:c.top-3}};})()`);
          assert.ok(clipped.top < clipped.visible.y && clipped.bottom > clipped.visible.y, 'Clipped-code pixel must actually lie inside the code box');
          await assertAlpha(clipped.visible, Math.round(codeOpacity * 255), 'Visible portion of a clipped code box');
          await assertAlpha(clipped.outside, Math.round(appOpacity * 255), 'App chrome above the scrolling code cutout');
        } finally { await js(`document.getElementById('messages').style.paddingBottom=${JSON.stringify(padding)}`); }
      };
      let finishAnswer;
      try {
        assert.equal(original.codeOpacity, 1, 'Code boxes start fully opaque');
        await saveOpacity(60, 40); await assertCodeOpacity(0.4, 0.6);
        await saveOpacity(80, 40); await assertCodeOpacity(0.4, 0.8);
        await saveOpacity(80, 10); await assertCodeOpacity(0.1, 0.8);
        const answer = 'Ordinary paragraph remains readable.\n\n```javascript\nconsole.log("independent-opacity");\n```\n\n- List paragraph.\n\n  ```javascript\n  console.log("list-opacity");\n  ```\n\n> Quote paragraph.\n>\n> ```javascript\n> console.log("quote-opacity");\n> ```';
        runtime.setAnswerFunction(async ({ onDelta }) => {
          onDelta(answer);
          await new Promise(resolve => { finishAnswer = resolve; });
          return { text: answer, truncated: false };
        });
        await runtime.ask({ text: 'Render new top-level, list and quote code boxes while opacity settings are active' });
        await until(async () => await js('document.querySelectorAll(".message:last-child .message-body pre").length === 3'));
        await delay(200); // Let the incoming-message animation finish before checking ancestor opacity.
        assert.equal(runtime.currentState().busy, true);
        await assertCodeOpacity(0.1, 0.8);
        finishAnswer(); await until(() => !runtime.currentState().busy);
        await until(async () => await js('document.querySelectorAll(".message:last-child .copy-code").length === 3'));
        assert.equal(await js('!!document.querySelector(".message:last-child li pre") && !!document.querySelector(".message:last-child blockquote pre")'), true, 'Nested Markdown fixtures must really contain code inside both list and quote ancestors');
        await assertCodeOpacity(0.1, 0.8);
        assert.equal(await js('document.querySelector(".message:last-child .copy-code").closest("pre") === document.querySelector(".message:last-child .message-body pre")'), true, 'The code copy control must share its code box opacity');
        runtime.showOverlay(false); win.setContentProtection(false);
        await saveOpacity(100, 10); win.setContentProtection(false);
        await assertCodeOpacity(0.1, 1); await checkPixels(1, 0.1);
        await saveOpacity(10, 100); win.setContentProtection(false);
        await assertCodeOpacity(1, 0.1); await checkPixels(0.1, 1);
        let point = await codePoint();
        await assertAlpha(point, 255, 'Code box before opening Settings');
        await js('document.getElementById("settingsButton").click()');
        assert.deepEqual(await js('[document.getElementById("opacity").value,document.getElementById("codeOpacity").value]'), ['10','100'], 'Opening Settings must restore each saved slider value');
        await assertConversationHidden(point);
        await js('document.getElementById("closeSettings").click()');
        await assertConversationRestored();
        point = await codePoint();
        await js('document.getElementById("settingsButton").click()');
        await assertConversationHidden(point);
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await assertConversationRestored();
        point = await codePoint();
        await js('document.getElementById("settingsButton").click()');
        await assertConversationHidden(point);
        await js('document.getElementById("settingsForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
        await assertConversationRestored();
        await js('document.getElementById("settingsButton").click();document.getElementById("clearButton").click()');
        assert.equal(await js('document.getElementById("settingsDialog").open && document.getElementById("clearDialog").open'), true);
        await assertConversationHidden(point);
        await js('document.getElementById("settingsDialog").close()');
        assert.equal(await js('document.getElementById("clearDialog").open'), true);
        await assertConversationHidden(point);
        await js('document.getElementById("cancelClear").click()');
        await assertConversationRestored();
        let appendAnswer;
        const firstPart = 'A streamed conversation stays hidden behind Settings.\n\n```javascript\nconsole.log("before-settings");\n```';
        const secondPart = '\n\n```javascript\nconsole.log("during-settings");\n```';
        runtime.setAnswerFunction(async ({onDelta}) => {
          appendAnswer = onDelta; onDelta(firstPart);
          await new Promise(resolve => { finishAnswer = resolve; });
          return {text:firstPart+secondPart,truncated:false};
        });
        await runtime.ask({text:'Continue streaming code while Settings is open'});
        await until(async () => await js('document.querySelectorAll(".message:last-child .message-body pre").length === 1'));
        point = await codePoint();
        await js('document.getElementById("settingsButton").click()');
        await assertConversationHidden(point);
        appendAnswer(secondPart);
        await until(async () => await js('document.querySelectorAll(".message:last-child .message-body pre").length === 2'));
        await assertConversationHidden(point);
        finishAnswer(); await until(() => !runtime.currentState().busy);
        await until(async () => await js('document.querySelectorAll(".message:last-child .copy-code").length === 2'));
        await assertConversationHidden(point);
        await js('document.getElementById("closeSettings").click()');
        await assertConversationRestored();
      } finally {
        if (finishAnswer) finishAnswer();
        if (runtime.currentState().busy) { runtime.cancel(); await until(() => !runtime.currentState().busy); }
        if (await js('document.getElementById("settingsDialog").open')) await js('document.getElementById("closeSettings").click()');
        await saveOpacity(Math.round(original.opacity * 100), Math.round(original.codeOpacity * 100));
        win.setContentProtection(original.hideFromCapture);
        if (!wasVisible) runtime.hideOverlay();
      }
    });
    await test('New chat archives encrypted history, resets draft and context, and restores previous chats', async () => {
      const original=runtime.getHistory().map(message=>message.text);
      await js('document.getElementById("question").value="unsent draft";document.getElementById("question").dispatchEvent(new Event("input"));document.getElementById("newChatButton").click()');
      await until(()=>runtime.getHistory().length===0);
      await until(async()=>await js('document.getElementById("question").value === ""'));
      assert.equal(runtime.currentState().archivedChats.length,1);
      assert.equal(runtime.currentState().lastAttempt,null); assert.equal(runtime.images.size,0);
      assert.equal(fs.readFileSync(path.join(runtime.app.getPath('userData'),'chats.enc')).includes(Buffer.from('OpenAI test answer')),false);
      const id=runtime.currentState().archivedChats[0].id;
      runtime.setAnswerFunction(async options=>{assert.equal(options.messages.length,1,'New chat must not send old context');options.onDelta('Fresh answer');return{text:'Fresh answer',truncated:false};});
      await runtime.ask({text:'Fresh question'});await until(()=>!runtime.currentState().busy);
      await js('document.getElementById("settingsButton").click()');
      await js(`document.getElementById("chatSelect").value=${JSON.stringify(id)};document.getElementById("chatSelect").dispatchEvent(new Event("change"));document.getElementById("openChatButton").click()`);
      await until(()=>runtime.getHistory().length===original.length);
      assert.deepEqual(runtime.getHistory().map(message=>message.text),original);
      const saved=runtime.store.read('chats.enc',null,true);assert.deepEqual(saved.current.map(message=>message.text),original);
      assert.equal(saved.archive[0].history[0].text,'Fresh question');
      const savedState=JSON.stringify(runtime.currentState());
      const write=runtime.store.write.bind(runtime.store);runtime.store.write=()=>{throw new Error('simulated archive disk failure');};
      try {assert.throws(()=>runtime.changeConversation(),/disk failure/);}
      finally{runtime.store.write=write;}
      assert.equal(JSON.stringify(runtime.currentState()),savedState,'A failed New chat must preserve the conversation');
      await js('document.getElementById("settingsButton").click()');
      const archived=runtime.currentState().archivedChats[0].id;
      await js(`document.getElementById("chatSelect").value=${JSON.stringify(archived)};document.getElementById("chatSelect").dispatchEvent(new Event("change"));document.getElementById("deleteChatButton").click();document.getElementById("cancelDeleteChat").click()`);
      assert.equal(runtime.currentState().archivedChats.length,1);
      await js('document.getElementById("deleteChatButton").click();document.getElementById("confirmDeleteChat").click()');
      await until(()=>runtime.currentState().archivedChats.length===0);
      await js('document.getElementById("closeSettings").click()');
    });
    await test('New chat rejects active answers; retry, cancel, clear and history opt-out behave consistently', async () => {
      let calls=0;
      runtime.setAnswerFunction(async({onDelta})=>{calls++;if(calls===1)throw new Error('Temporary test failure');onDelta('Retried answer');return{text:'Retried answer',truncated:false};});
      await runtime.ask({text:'Retry me'});await until(()=>!runtime.currentState().busy);
      await until(async()=>await js('!!document.querySelector(".retry-button")'));
      await js('document.querySelector(".retry-button").click()');await until(()=>!runtime.currentState().busy&&calls===2);
      runtime.setAnswerFunction(async({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})));
      await runtime.ask({text:'Hold answer'});
      assert.throws(()=>runtime.changeConversation(),/Stop the current answer/);
      assert.equal(await js('document.getElementById("newChatButton").disabled'),true);
      await js('document.getElementById("stopButton").click()');await until(()=>!runtime.currentState().busy);
      await runtime.saveSettings({opacity:0.67});assert.equal(win.getOpacity(),1);await until(async()=>Number(await js('getComputedStyle(document.documentElement).getPropertyValue("--app-opacity")'))===0.67);
      await runtime.saveSettings({opacity:0.98,rememberHistory:false});
      assert.equal(fs.existsSync(path.join(runtime.app.getPath('userData'),'chats.enc')),false);
      assert.equal(fs.existsSync(path.join(runtime.app.getPath('userData'),'conversation.enc')),false);
      assert.equal(fs.existsSync(path.join(runtime.app.getPath('userData'),'interrupted-work.enc')),false);
      await runtime.saveSettings({rememberHistory:true});
      await js('document.getElementById("settingsButton").click();document.getElementById("clearButton").click();document.getElementById("cancelClear").click()');
      assert.ok(runtime.getHistory().length>0);
      await js('document.getElementById("clearButton").click();document.getElementById("confirmClear").click()');
      await until(()=>runtime.getHistory().length===0);
      assert.equal(runtime.store.read('chats.enc',null,true).current.length,0);
      for (const shortcut of runtime.currentState().shortcuts) {
        if (shortcut.registered) assert.equal(globalShortcut.isRegistered(shortcut.accelerator),true);
        else assert.ok(runtime.currentState().warnings.some(message=>message.includes(shortcut.label+' shortcut is unavailable')));
      }
    });
    await require('./chatgpt-desktop').run({ runtime, js, until, test, imageBytes });
    await require('./dropdowns-desktop').run({ runtime, js, until, test });
    await test('deleting a key takes effect and image cache is bounded', async () => {
      runtime.setAnswerFunction(async({onDelta})=>{onDelta('Persisted test answer');return{text:'Persisted test answer',truncated:false};});
      await runtime.ask({text:'Archived chat after restart'});await until(()=>!runtime.currentState().busy);
      runtime.changeConversation();
      await runtime.ask({text:'Current chat after restart'});await until(()=>!runtime.currentState().busy);
      for(let i=0;i<25;i++) runtime.importImage({name:`image${i}.png`,data:imageBytes.toString('base64')});
      assert.ok(runtime.images.size<=20);
      await runtime.saveSettings({provider:'anthropic',removeKey:true}); assert.equal(runtime.currentState().keyStatus.anthropic,false);
      await assert.rejects(runtime.ask({text:'hello'}),/API key/);
    });
    console.log(`Desktop tests passed: ${results.filter(result => result.passed).length}; skipped: ${results.filter(result => result.skipped).length}`);
  } catch (error) { if (!results.some(result=>!result.passed)) results.push({name:'desktop suite setup or completion',passed:false,error:error.message}); console.error(error.stack); }
  finally {
    clearTimeout(watchdog);
    fs.writeFileSync(path.join(work,'desktop-test-results.json'),JSON.stringify({results,consoleErrors,profile:runtime.app.getPath('userData')},null,2));
    runtime.app.exit(results.some(result=>!result.passed && !result.skipped)?1:0);
  }
};
