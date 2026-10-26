'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Runs inside the existing disposable Electron desktop suite. No browser or
// real OAuth/API request is used; the real renderer, preload and IPC are used.
exports.run = async ({ runtime, js, until, test, imageBytes }) => {
  const initial = structuredClone(runtime.currentState().settings);
  const model = (id, name) => ({ id, name, vision: true, reasoningEfforts: ['low', 'high'], reasoningMode: 'effort', thinking: null });
  const catalogs = {
    a: [model('chatgpt-fixture-a1', 'Fixture A first'), model('chatgpt-fixture-a2', 'Fixture A second')],
    b: [model('chatgpt-fixture-b1', 'Fixture B')]
  };
  const preferences = {
    a: { model: 'chatgpt-fixture-a2', reasoningEfforts: { 'chatgpt-fixture-a2': 'high' }, models: catalogs.a, total: 2, checkedAt: new Date().toISOString() },
    b: { model: 'chatgpt-fixture-b1', reasoningEfforts: { 'chatgpt-fixture-b1': 'low' }, models: catalogs.b, total: 1, checkedAt: new Date().toISOString() }
  };
  let activeProfileId = null, pendingLogin = null, pendingSignOut = null, deferLogin = false, expired = false, calls = 0, activeSignal;
  const profiles = ['a', 'b'];
  const fake = {
    publicState: () => ({ profiles: profiles.map(id => ({ id, label: `Workspace ${id.toUpperCase()}`, email: 'fixture@example.invalid', sharing: true, needsSignIn: expired && id === activeProfileId })), activeProfileId, connected: !!activeProfileId, sharing: !!activeProfileId, busy: !!pendingLogin || !!pendingSignOut, error: '' }),
    async signIn() {
      if (deferLogin) return new Promise((_resolve, reject) => { pendingLogin = reject; });
      activeProfileId = 'a'; return this.publicState();
    },
    cancelSignIn() { const reject = pendingLogin; pendingLogin = null; reject?.(new Error('Sign-in cancelled.')); },
    async selectProfile(id) { assert.ok(profiles.includes(id)); activeProfileId = id; return this.publicState(); },
    async signOut(id) { assert.equal(id, activeProfileId); await new Promise(resolve => { pendingSignOut = resolve; }); pendingSignOut = null; activeProfileId = null; return this.publicState(); },
    async accessToken() { assert.ok(activeProfileId); return `fixture-oauth-secret-${activeProfileId}`; },
    getProfilePreferences() { return structuredClone(preferences[activeProfileId] || {}); },
    setProfilePreferences(value, id = activeProfileId) { preferences[id] = { ...preferences[id], ...structuredClone(value) }; }
  };
  const previousController = runtime.setChatGPTController(fake);
  const previousLister = runtime.setModelLister(async (provider, token) => {
    assert.equal(provider, 'chatgpt'); assert.equal(token, `fixture-oauth-secret-${activeProfileId}`);
    return { models: structuredClone(catalogs[activeProfileId]), total: catalogs[activeProfileId].length, checkedAt: new Date().toISOString() };
  });
  const previousAnswer = runtime.setAnswerFunction(async options => {
    calls++; assert.equal(options.provider, 'chatgpt'); assert.equal(options.apiKey, `fixture-oauth-secret-${activeProfileId}`);
    assert.equal(options.model, 'chatgpt-fixture-a1');
    assert.equal(options.reasoningEffort, 'low');
    if (calls === 2) assert.equal(options.messages.at(-1).images.length, 1);
    options.onDelta('ChatGPT fixture answer'); return { text: 'ChatGPT fixture answer', truncated: false };
  });
  try {
    await test('ChatGPT browser sign-in controls keep API keys and account credentials separate', async () => {
      await js('document.getElementById("settingsButton").click();document.getElementById("settingsProvider").value="chatgpt";document.getElementById("settingsProvider").dispatchEvent(new Event("change"))');
      assert.deepEqual(await js('[document.getElementById("chatgptConnection").hidden,document.getElementById("apiKeyLabel").hidden,document.getElementById("chatgptSignInButton").textContent]'), [false, true, 'Continue with ChatGPT']);
      assert.equal(await js('[...document.getElementById("modelPreset").options].some(option=>option.value==="__custom__")'), false);
      await js('document.getElementById("chatgptSignInButton").click()');
      await until(() => runtime.currentState().settings.provider === 'chatgpt' && runtime.currentState().modelStatus.chatgpt?.source === 'live');
      await until(async () => await js('!document.getElementById("chatgptSignInButton").disabled'));
      assert.equal(runtime.currentState().settings.models.chatgpt, 'chatgpt-fixture-a2');
      assert.equal(JSON.stringify(runtime.currentState()).includes('fixture-oauth-secret'), false);
      assert.equal(await js('document.getElementById("chatgptUsageLabel").textContent.includes("Using ChatGPT plan")'), true);
      await js('document.getElementById("settingsDialog").scrollTop=0;document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      const win = runtime.getWindow(), protectedWindow = win.isContentProtected();
      try {
        win.setContentProtection(false);
        fs.writeFileSync(path.join(__dirname, '..', '.test-output', 'ChatGPT-settings.png'), (await win.webContents.capturePage()).toPNG());
      } finally { win.setContentProtection(protectedWindow); }
      await js('document.getElementById("closeSettings").click();document.getElementById("quickModel").value="chatgpt-fixture-a1";document.getElementById("quickModel").dispatchEvent(new Event("change"))');
      await until(() => runtime.currentState().settings.models.chatgpt === 'chatgpt-fixture-a1');
      await js('document.getElementById("quickEffort").value="low";document.getElementById("quickEffort").dispatchEvent(new Event("change"))');
      await until(() => runtime.currentState().settings.reasoningEfforts.chatgpt['chatgpt-fixture-a1'] === 'low');
    });
    await test('ChatGPT account switching restores each connection’s model and reasoning choices', async () => {
      await js('document.getElementById("settingsButton").click();document.getElementById("chatgptProfile").value="b";document.getElementById("chatgptProfile").dispatchEvent(new Event("change"))');
      await until(() => activeProfileId === 'b' && runtime.currentState().settings.models.chatgpt === 'chatgpt-fixture-b1');
      await until(async () => await js('!document.getElementById("chatgptProfile").disabled'));
      assert.equal(runtime.currentState().settings.reasoningEfforts.chatgpt['chatgpt-fixture-b1'], 'low');
      assert.deepEqual(await js('[...document.getElementById("quickModel").options].map(option=>option.value)'), ['chatgpt-fixture-b1']);
      await js('document.getElementById("chatgptProfile").value="a";document.getElementById("chatgptProfile").dispatchEvent(new Event("change"))');
      await until(() => activeProfileId === 'a' && runtime.currentState().settings.models.chatgpt === 'chatgpt-fixture-a1');
      await until(async () => await js('!document.getElementById("chatgptProfile").disabled'));
      assert.equal(runtime.currentState().settings.reasoningEfforts.chatgpt['chatgpt-fixture-a1'], 'low');
      await js('document.getElementById("closeSettings").click()');
    });
    await test('expired ChatGPT connections require reconnecting before model changes or submission', async () => {
      expired = true; runtime.setChatGPTController(fake);
      await until(async () => await js('document.getElementById("chatgptUsageLabel").textContent.startsWith("Reconnect ChatGPT")'));
      assert.deepEqual(await js('[document.getElementById("quickModel").disabled,document.getElementById("quickEffort").disabled,document.getElementById("setupNote").hidden]'), [true, true, false]);
      await js('document.getElementById("question").value="Expired connection must not generate";document.getElementById("questionForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
      await until(async () => await js('document.getElementById("settingsDialog").open'));
      assert.equal(calls, 0);
      assert.equal(await js('document.getElementById("modelPreset").disabled'), true);
      assert.match(await js('document.getElementById("chatgptConnectionStatus").textContent'), /needs a new sign-in/);
      expired = false; runtime.setChatGPTController(fake);
      await until(async () => await js('!document.getElementById("quickModel").disabled'));
      await js('document.getElementById("closeSettings").click();document.getElementById("question").value="";document.getElementById("question").dispatchEvent(new Event("input"))');
    });
    await test('ChatGPT text and image requests use only the selected account through the renderer bridge', async () => {
      await js('document.getElementById("question").value="ChatGPT fixture text";document.getElementById("question").dispatchEvent(new Event("input"));document.getElementById("questionForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
      await until(() => calls === 1 && !runtime.currentState().busy);
      await until(async () => await js('!document.getElementById("question").value'));
      await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(imageBytes.toString('base64'))}),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'chatgpt-fixture.png',{type:'image/png'}));document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
      await until(async () => await js('!document.getElementById("attachment").hidden'));
      await js('document.getElementById("question").value="ChatGPT fixture image";document.getElementById("question").dispatchEvent(new Event("input"));document.getElementById("questionForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
      await until(() => calls === 2 && !runtime.currentState().busy);
      await until(async () => await js('document.getElementById("attachment").hidden'));
      assert.equal(runtime.getHistory().at(-1).provider, 'chatgpt');
      assert.equal(await js('[...document.querySelectorAll(".message-header")].at(-1).textContent.includes("CHATGPT PLAN")'), true);
      assert.equal(JSON.stringify(await js('window.overlay.state()')).includes('fixture-oauth-secret'), false);
    });
    await test('cancelled ChatGPT sign-in preserves the selected account', async () => {
      deferLogin = true;
      await js('document.getElementById("settingsButton").click();document.getElementById("chatgptAddAccount").click()');
      await until(() => !!pendingLogin);
      await until(async () => await js('!document.getElementById("chatgptCancelSignIn").hidden'));
      await js('document.getElementById("chatgptCancelSignIn").click()');
      await until(() => !pendingLogin);
      await until(async () => await js('!document.getElementById("chatgptProfile").disabled'));
      assert.equal(runtime.currentState().chatgpt.activeProfileId, 'a');
      await js('document.getElementById("closeSettings").click()');
    });
    await test('ChatGPT sign-out stops an active answer and never falls back to API-key billing', async () => {
      runtime.setAnswerFunction(async options => {
        calls++; assert.equal(options.provider, 'chatgpt'); activeSignal = options.signal; options.onDelta('Partial account answer');
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
      });
      await runtime.ask({ text: 'Hold ChatGPT account answer' });
      await until(() => !!activeSignal);
      await js('document.getElementById("settingsButton").click()');
      assert.equal(await js('document.getElementById("chatgptSignOut").disabled'), false);
      await js('document.getElementById("chatgptSignOut").click();document.getElementById("confirmChatGPTSignOut").click()');
      await until(() => !!pendingSignOut);
      runtime.setChatGPTController(fake);
      await until(async () => await js('document.getElementById("chatgptConnectionStatus").textContent === "Updating ChatGPT connection…"'));
      assert.equal(await js('document.getElementById("chatgptCancelSignIn").hidden'), true, 'Sign-out must not offer a sign-in cancellation action');
      pendingSignOut();
      await until(() => activeSignal.aborted && !runtime.currentState().busy && !runtime.currentState().chatgpt.connected);
      await until(async () => await js('!document.getElementById("chatgptSignInButton").disabled'));
      assert.equal(runtime.currentState().settings.provider, 'chatgpt');
      await assert.rejects(runtime.ask({ text: 'No fallback allowed' }), /Continue with ChatGPT/);
      assert.equal(calls, 3);
    });
  } finally {
    fake.cancelSignIn(); pendingSignOut?.(); runtime.cancel();
    await until(() => !runtime.currentState().busy);
    await js('for(const dialog of document.querySelectorAll("dialog[open]"))dialog.close()');
    runtime.setChatGPTController(previousController);
    runtime.setModelLister(previousLister); runtime.setAnswerFunction(previousAnswer);
    await runtime.saveSettings(initial);
    runtime.clear();
  }
};
