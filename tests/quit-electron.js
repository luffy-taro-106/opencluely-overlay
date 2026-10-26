'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

exports.run = async runtime => {
  const file = path.resolve(__dirname, '..', '.test-output', 'desktop-test-results.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = { name: 'explicitly confirmed Quit through renderer IPC exits normally despite close protection', passed: false };
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
    runtime.setQuitConfirmationFunction(async () => { confirmations++; return true; });
    runtime.app.once('will-quit', () => {
      clearTimeout(watchdog);
      result.passed = confirmations === 1;
      if (!result.passed) result.error = 'Quit bypassed its confirmation';
      report.results.push(result); fs.writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
      if (!result.passed) runtime.app.exit(1);
    });
    // The renderer can disappear before invoke() returns; will-quit is the exit evidence.
    void win.webContents.executeJavaScript('window.overlay.quit()').catch(() => {});
  } catch (error) {
    clearTimeout(watchdog);
    result.error = error.message;
    report.results.push(result); fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.error(error.message); runtime.app.exit(1);
  }
};
