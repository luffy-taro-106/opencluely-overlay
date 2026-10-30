'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');

function luminance(rgb) {
  const values = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }

exports.run = async ({ runtime, win, js, until, test, work }) => {
  await test('theme toggle covers conversation, code, settings and menus, persists and preserves background focus', async () => {
    const browser = new BrowserWindow({ show: false, width: 400, height: 250, webPreferences: { sandbox: true } });
    const config = structuredClone(runtime.currentState().settings), keys = runtime.currentState().keyStatus;
    try {
      runtime.hideOverlay();
      await browser.loadURL('data:text/html,<title>Theme focus fixture</title><input><script>window.blurs=0;addEventListener("blur",()=>blurs++)</script>');
      browser.show(); browser.focus(); browser.webContents.focus(); await until(() => browser.isFocused());
      const before = await browser.webContents.executeJavaScript('({ focused: document.hasFocus(), blurs })');
      runtime.showOverlay(false);
      await js('document.getElementById("themeButton").click()');
      await until(() => runtime.currentState().settings.theme === 'light');
      await until(async () => await js('document.documentElement.dataset.theme === "light"'));
      assert.deepEqual(await browser.webContents.executeJavaScript('({ focused: document.hasFocus(), blurs })'), before);
      assert.equal(runtime.store.read('preferences.json', {}).theme, 'light');
      assert.equal(await js('document.getElementById("themeButton").getAttribute("aria-pressed")'), 'true');
      assert.deepEqual(runtime.currentState().keyStatus, keys);
      assert.equal(runtime.currentState().settings.provider, config.provider);
      assert.deepEqual(runtime.currentState().settings.models, config.models);
      const palette = await js(`(() => {
        const css = id => getComputedStyle(document.querySelector(id));
        return { surface: css('#appBackdrop').backgroundColor, text: css('.message.assistant .message-body').color,
          muted: css('.message-header').color, accent: css('.setup-note button').color,
          code: css('.message-body pre').backgroundColor, codeText: css('.message-body pre').color };
      })()`);
      assert.equal(palette.surface, 'rgb(255, 255, 255)');
      for (const pair of [[palette.text, palette.surface], [palette.muted, palette.surface], [palette.accent, palette.surface], [palette.codeText, palette.code]]) assert.ok(contrast(...pair) >= 4.5, 'Light palette must keep readable foreground contrast');
      fs.writeFileSync(path.join(work, 'theme-contrast.json'), JSON.stringify({ palette, contrast: { text: contrast(palette.text, palette.surface), muted: contrast(palette.muted, palette.surface), accent: contrast(palette.accent, palette.surface), code: contrast(palette.codeText, palette.code) } }, null, 2));
      win.setContentProtection(false); await js('document.getElementById("toast").hidden = true'); await delay(200);
      fs.writeFileSync(path.join(work, 'Theme-light.png'), (await win.webContents.capturePage()).toPNG());
      await js('document.querySelector("[data-select-id=quickModel]").click()');
      assert.equal(await js('document.querySelector("[data-select-id=quickModel]").getAttribute("aria-expanded")'), 'true');
      assert.equal(await js('getComputedStyle(document.querySelector(".overlay-select-list:popover-open")).backgroundColor'), 'rgb(255, 255, 255)');
      fs.writeFileSync(path.join(work, 'Theme-light-menu.png'), (await win.webContents.capturePage()).toPNG());
      await js('document.querySelector("[data-select-id=quickModel]").click()');
      await js('document.getElementById("settingsButton").click()'); await delay(100);
      assert.equal(await js('getComputedStyle(document.getElementById("settingsDialog")).backgroundColor'), 'rgb(255, 255, 255)');
      fs.writeFileSync(path.join(work, 'Theme-light-settings.png'), (await win.webContents.capturePage()).toPNG());
      await js('document.getElementById("closeSettings").click()');
      const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded;
      await until(async () => await js('document.documentElement.dataset.theme === "light"'));
      assert.equal(runtime.getHistory().length, 2);
      await js('document.getElementById("themeButton").click()');
      await until(async () => await js('document.documentElement.dataset.theme === "dark"'));
      win.setContentProtection(false); await delay(100);
      fs.writeFileSync(path.join(work, 'Theme-dark.png'), (await win.webContents.capturePage()).toPNG());
    } finally { win.setContentProtection(true); browser.destroy(); runtime.hideOverlay(); }
  });
  await test('invalid appearance and failed appearance writes leave saved state intact', async () => {
    const before = fs.readFileSync(path.join(runtime.store.directory, 'preferences.json'));
    assert.equal((await js('window.overlay.setTheme("invalid")')).ok, false);
    const originalWrite = runtime.store.write;
    try {
      runtime.store.write = function(name, ...args) { if (name === 'preferences.json') throw new Error('Appearance write failed'); return originalWrite.call(this, name, ...args); };
      assert.equal((await js('window.overlay.setTheme("light")')).ok, false);
      assert.equal(runtime.currentState().settings.theme, 'dark');
      assert.equal(await js('document.documentElement.dataset.theme'), 'dark');
    } finally { runtime.store.write = originalWrite; }
    assert.deepEqual(fs.readFileSync(path.join(runtime.store.directory, 'preferences.json')), before);
  });
};
