'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

exports.run = async runtime => {
  const file = path.resolve(__dirname, '..', '.test-output', 'desktop-test-results.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reopening = process.argv.includes('--quit-reopen-smoke-test');
  const external = process.argv.includes('--quit-external-smoke-test'), sessionEnd = process.argv.includes('--quit-session-end-smoke-test');
  const result = { name: sessionEnd ? 'Windows session end exits without confirmation or reopening' : external ? 'allowed external cooperative Quit preserves verified reopening' : reopening ? 'ordinary Quit exits normally while preserving automatic reopening' : 'Quit completely through renderer IPC stops automatic reopening and exits', passed: false };
  const watchdog = setTimeout(() => {
    result.error = 'Confirmed Quit did not reach will-quit';
    report.results.push(result); fs.writeFileSync(file, JSON.stringify(report, null, 2));
    runtime.app.exit(1);
  }, 10000);
  try {
    const win = runtime.getWindow();
    while (win.webContents.isLoading()) await delay(25);
    assert.equal(runtime.currentState().settings.protectFromQuit, true);
    let confirmations = 0;
    let stops = 0, disarms = 0, keeps = 0;
    const fake = { available: true, enabled: true, busy: false,
      status() { return { available: true, enabled: this.enabled, busy: this.busy, error: '' }; },
      async keepForQuit() { keeps++; return true; },
      async stopForQuit() { stops++; this.enabled = false; },
      disarmForSessionEnd() { disarms++; this.enabled = false; } };
    runtime.setRecoveryController(fake);
    runtime.setQuitConfirmationFunction(async () => { confirmations++; return true; });
    if (external) await runtime.saveSettings({ protectFromQuit: false });
    runtime.app.once('will-quit', () => {
      clearTimeout(watchdog);
      result.passed = sessionEnd ? confirmations === 0 && keeps === 0 && stops === 0 && disarms >= 1 && !fake.enabled
        : external ? confirmations === 0 && keeps === 1 && stops === 0 && disarms === 0 && fake.enabled
          : confirmations === 1 && (reopening ? keeps === 1 && stops === 0 && disarms === 0 && fake.enabled : keeps === 0 && stops === 1 && disarms === 1 && !fake.enabled);
      if (!result.passed) result.error = `Quit lifecycle mismatch: ${JSON.stringify({ confirmations, keeps, stops, disarms, enabled: fake.enabled })}`;
      report.results.push(result); fs.writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
      if (!result.passed) runtime.app.exit(1);
    });
    // The renderer can disappear before invoke() returns; will-quit is the exit evidence.
    if (sessionEnd) { runtime.allowSessionEnd(); runtime.app.quit(); }
    else if (external) runtime.app.quit();
    else void win.webContents.executeJavaScript(reopening ? 'window.overlay.quit()' : 'window.overlay.quitCompletely()').catch(() => {});
  } catch (error) {
    clearTimeout(watchdog);
    result.error = error.message;
    report.results.push(result); fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.error(error.message); runtime.app.exit(1);
  }
};
