'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async ({ runtime, js, until, test, imageBytes }) => {
  const initial = structuredClone(runtime.currentState().settings);
  const credentials = fs.readFileSync(path.join(runtime.store.directory, 'credentials.enc'));
  let connected = false, loginPending = null, loginStarted = false, calls = [], defer = false, slow = false;
  const catalog = [{ id: 'codex-fixture-vision', name: 'Codex vision fixture', vision: true, reasoningEfforts: ['low', 'high'], reasoningMode: 'effort', thinking: null },
    { id: 'codex-fixture-text', name: 'Codex text fixture', vision: false, reasoningEfforts: [], reasoningMode: null, thinking: null }];
  const fake = {
    publicState: () => ({ connected, email: connected ? 'codex-owner@example.test' : '', planType: 'plus', busy: loginStarted, signingIn: loginStarted, error: '' }),
    async signIn() {
      loginStarted = true;
      try { if (defer) await new Promise((_resolve, reject) => { loginPending = reject; }); connected = true; }
      finally { loginStarted = false; loginPending = null; }
    },
    async cancelSignIn() { loginPending?.(new Error('Codex sign-in was canceled.')); },
    async signOut() { connected = false; },
    async listModels() { assert.ok(connected); return { models: structuredClone(catalog), total: 2, checkedAt: new Date().toISOString() }; },
    async answer(options) {
      calls.push(options); options.onDelta('Codex fixture answer');
      if (slow) await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
      return { text: 'Codex fixture answer', truncated: false };
    },
    stop() {}
  };
  const previous = runtime.setCodexController(fake);
  try {
    await test('separate Codex sign-in populates only its own catalog and keeps API fields hidden', async () => {
      await js('document.getElementById("settingsButton").click();document.getElementById("settingsProvider").value="codex";document.getElementById("settingsProvider").dispatchEvent(new Event("change"))');
      assert.deepEqual(await js('[document.getElementById("codexConnection").hidden,document.getElementById("chatgptConnection").hidden,document.getElementById("apiKeyLabel").hidden]'), [false, true, true]);
      assert.equal(await js('[...document.getElementById("modelPreset").options].some(option=>option.value==="__custom__")'), false);
      await js('document.getElementById("codexSignIn").click()');
      await until(() => runtime.currentState().settings.provider === 'codex' && runtime.currentState().modelStatus.codex?.source === 'live');
      await until(async () => await js('!document.getElementById("codexSignIn").disabled'));
      assert.equal(runtime.currentState().settings.models.codex, catalog[0].id);
      assert.deepEqual(runtime.currentState().modelCatalog.codex.map(item => item.id), catalog.map(item => item.id));
      await assert.rejects(runtime.saveSettings({ provider: 'codex', apiKey: 'fixture-api-key-1234' }), /account sign-in/);
      await assert.rejects(runtime.saveSettings({ models: { codex: 'unavailable-model' } }), /available/);
      await runtime.saveSettings({ reasoningEfforts: { codex: { [catalog[0].id]: 'high' } } });
      await js('document.getElementById("closeSettings").click()');
    });
    await test('Codex text and image questions use the selected Codex connection and reasoning', async () => {
      await runtime.ask({ text: 'Codex text question' }); await until(() => !runtime.currentState().busy);
      const image = runtime.importImage({ name: 'codex-question.png', data: imageBytes.toString('base64') });
      await runtime.ask({ text: 'Codex image question', imageId: image.id }); await until(() => !runtime.currentState().busy);
      assert.equal(calls.length, 2); assert.equal(calls[1].messages.at(-1).images.length, 1);
      assert.equal(calls[1].reasoningEffort, 'high'); assert.equal(calls[1].apiKey, undefined);
      assert.equal(runtime.getHistory().at(-1).provider, 'codex');
      await until(async () => await js('document.querySelector(".message:last-child .message-header").textContent.includes("CODEX")'));
      await runtime.saveSettings({ models: { codex: catalog[1].id } });
      await assert.rejects(runtime.ask({ text: 'Unavailable image', imageId: image.id }), /text only/);
      await runtime.saveSettings({ models: { codex: catalog[0].id } });
    });
    await test('Codex sign-out cancels its answer and preserves other connections and API keys', async () => {
      slow = true; await runtime.ask({ text: 'Cancelable Codex question' });
      await until(() => runtime.currentState().busy);
      await js('document.getElementById("settingsButton").click();document.getElementById("codexSignOut").click();document.getElementById("confirmCodexSignOut").click()');
      await until(() => !runtime.currentState().codex.connected && !runtime.currentState().busy);
      await until(async () => await js('!document.getElementById("codexSignIn").disabled'));
      assert.equal(calls.at(-1).signal.aborted, true); assert.deepEqual(runtime.currentState().modelCatalog.codex, []);
      assert.deepEqual(fs.readFileSync(path.join(runtime.store.directory, 'credentials.enc')), credentials);
      assert.equal(JSON.stringify(runtime.currentState()).includes('fixture-oauth-secret'), false);
    });
    await test('Codex canceled login restores controls without changing the ChatGPT account', async () => {
      const chatgptBefore = structuredClone(runtime.currentState().chatgpt);
      defer = true;
      await js('document.getElementById("codexSignIn").click()');
      await until(() => loginPending);
      runtime.setCodexController(fake);
      await until(async () => await js('!document.getElementById("codexCancelSignIn").hidden'));
      await js('document.getElementById("codexCancelSignIn").click()');
      await until(() => !loginStarted);
      await until(async () => await js('!document.getElementById("codexSignIn").disabled'));
      assert.deepEqual(runtime.currentState().chatgpt, chatgptBefore);
      assert.equal(runtime.currentState().codex.connected, false);
      await js('document.getElementById("closeSettings").click()');
    });
  } finally {
    await fake.cancelSignIn(); runtime.cancel(); await until(() => !runtime.currentState().busy);
    await js('for(const dialog of document.querySelectorAll("dialog[open]"))dialog.close()');
    runtime.setCodexController(previous); await runtime.saveSettings(initial);
    runtime.clear();
  }
};
