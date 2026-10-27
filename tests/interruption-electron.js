'use strict';
// Used only by the disposable profile harness. Never contact a real provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { FILE } = require('../overlay/interrupted-work');

exports.run = async runtime => {
  const watchdog = setTimeout(() => runtime.app.exit(1), 20000);
  try {
    const phase = process.argv.at(-2);
    runtime.setKeyValidator(async () => true);
    const win = runtime.getWindow();
    while (win.webContents.isLoading()) await delay(25);
    if (phase === 'bootstrap') {
      await runtime.saveSettings({ provider: 'anthropic', apiKey: 'interruption-fixture-key' });
      clearTimeout(watchdog); runtime.app.exit(0); return;
    }
    if (phase === 'write') {
      await runtime.saveSettings({ provider: 'anthropic', apiKey: 'interruption-fixture-key' });
      runtime.setAnswerFunction(async () => ({ text: 'Previously completed answer', truncated: false }));
      await runtime.ask({ text: 'Previously completed question' });
      while (runtime.currentState().busy) await delay(10);
      assert.equal(runtime.currentState().history.length, 2, JSON.stringify({ warnings: runtime.currentState().warnings, error: runtime.currentState().lastAttempt?.error }));
      assert.equal(runtime.store.read('chats.enc', null, true)?.current.length, 2);
      runtime.setAnswerFunction(async ({ onDelta, signal }) => {
        onDelta('Saved partial answer');
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
      });
      const data = fs.readFileSync(path.join(__dirname, '../overlay/assets/icon.png')).toString('base64');
      const images = Array.from({ length: 10 }, (_value, i) => runtime.importImage({ name: `fixture-${i}.png`, data }));
      await runtime.ask({ text: 'Interrupted image question', imageIds: images.map(image => image.id) });
      assert.equal(runtime.interruptedWork.flush(), true);
      assert.equal(fs.readFileSync(path.join(runtime.store.directory, FILE)).includes(Buffer.from('Saved partial answer')), false);
      assert.equal(runtime.currentState().busy, true);
      process.send({ ready: true }); // Parent kills only this disposable Electron process.
      return;
    }
    assert.equal(phase, 'read');
    runtime.setAnswerFunction(async () => { throw new Error('Restoration must never submit a request'); });
    const state = runtime.currentState();
    assert.equal(state.busy, false);
    assert.equal(state.history.length, 2, JSON.stringify({ warnings: state.warnings, secureStorage: state.secureStorage, profileFiles: fs.readdirSync(runtime.store.directory) }));
    assert.equal(state.history[1].text, 'Previously completed answer');
    assert.equal(state.lastAttempt.text, 'Saved partial answer');
    assert.equal(state.lastAttempt.needsAttachment, true);
    assert.equal(state.lastAttempt.question.imageId, null);
    assert.deepEqual(state.lastAttempt.question.imageIds, []);
    assert.deepEqual(state.lastAttempt.imageNames, Array.from({ length: 10 }, (_value, i) => `fixture-${i}.png`));
    await delay(200);
    const text = await win.webContents.executeJavaScript('document.getElementById("messages").textContent');
    assert.match(text, /Saved partial answer/); assert.match(text, /has not resumed/);
    await win.webContents.executeJavaScript('document.querySelector(".retry-button").click()');
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("question").value'), 'Interrupted image question');
    assert.equal(runtime.currentState().busy, false, 'Missing image retry must not send an incomplete request');
    await runtime.saveSettings({ rememberHistory: false });
    assert.equal(fs.existsSync(path.join(runtime.store.directory, FILE)), false);
    assert.equal(fs.existsSync(path.join(runtime.store.directory, 'chats.enc')), false);
    console.log('PASS actual Electron SIGKILL restores encrypted partial answer and completed history without resending');
    clearTimeout(watchdog); runtime.app.exit(0);
  } catch (error) {
    console.error(error.stack); clearTimeout(watchdog); runtime.app.exit(1);
  }
};
