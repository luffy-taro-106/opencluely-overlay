'use strict';

const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');

// Real trusted renderer mouse events. Unlike setting a select's value in JS,
// this checks the first pointer click on a passive, nonfocusable overlay.
exports.run = async ({ runtime, js, until, test }) => {
  const win = runtime.getWindow();
  const original = structuredClone(runtime.currentState().settings);
  const browser = new BrowserWindow({ show: false, width: 500, height: 350, webPreferences: { sandbox: true } });
  async function click(selector) {
    const point = await js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing dropdown test target');element.scrollIntoView({block:'nearest'});const rect=element.getBoundingClientRect();if(!rect.width||!rect.height)throw Error('Dropdown target is not visible');return{x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  try {
    await browser.loadURL('data:text/html,<title>Passive dropdown browser fixture</title><input><script>window.blurs=0;addEventListener("blur",()=>blurs++)</script>');
    runtime.hideOverlay(); browser.show(); browser.focus(); browser.webContents.focus();
    await until(() => browser.isFocused());
    runtime.showOverlay(false);
    await test('passive dropdown opens on the first trusted click and changes the selected provider', async () => {
      await click('#settingsButton');
      await until(async () => await js('document.getElementById("settingsDialog").open'));
      await until(async () => await js('!!document.getElementById("settingsProvider-picker")'));
      const before = await browser.webContents.executeJavaScript('({focused:document.hasFocus(),blurs})');
      await click('#settingsProvider-picker');
      await until(async () => await js('document.getElementById("settingsProvider-picker").getAttribute("aria-expanded")==="true"'));
      assert.equal(await js('document.querySelector(".overlay-select-list").closest("dialog").id'), 'settingsDialog');
      assert.equal(await js('document.querySelectorAll(".overlay-select-list [role=option]").length'), 4);
      // The fourth Settings provider is the separate ChatGPT account connection.
      await click('#settingsProvider-picker-option-3');
      await until(async () => await js('document.getElementById("settingsProvider").value==="chatgpt"&&!document.getElementById("chatgptConnection").hidden'));
      assert.equal(await js('document.getElementById("chatgptSignInButton").textContent'), 'Continue with ChatGPT');
      assert.equal(await js('document.querySelector(".overlay-select-list")===null'), true);
      if (process.platform === 'win32') {
        assert.equal(win.isFocusable(), false);
        assert.deepEqual(await browser.webContents.executeJavaScript('({focused:document.hasFocus(),blurs})'), before);
      }
    });
    await test('dropdown survives unrelated state refreshes and mirrors native model options and disabled state', async () => {
      await click('#closeSettings');
      await until(async () => await js('!document.getElementById("settingsDialog").open'));
      await click('#quickModel-picker');
      await until(async () => await js('document.getElementById("quickModel-picker").getAttribute("aria-expanded")==="true"'));
      await runtime.saveSettings({ opacity: original.opacity });
      await until(async () => await js('document.getElementById("quickModel-picker").getAttribute("aria-expanded")==="true"'));
      const expected = await js('[...document.getElementById("quickModel").options].map(option=>option.textContent)');
      assert.deepEqual(await js('[...document.querySelectorAll(".overlay-select-list [role=option]")].map(option=>option.textContent)'), expected);
      assert.equal(await js('(()=>{const rect=document.querySelector(".overlay-select-list").getBoundingClientRect();return rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight})()'), true);
      await click('#quickModel-picker-option-0');
      await until(() => !runtime.currentState().busy);
      await js('document.getElementById("quickModel").disabled=true;window.overlaySelects.refresh()');
      assert.equal(await js('document.getElementById("quickModel-picker").disabled'), true);
      await js('document.getElementById("quickModel").disabled=false;window.overlaySelects.refresh();window.overlaySelects.close()');
    });
  } finally {
    await js('window.overlaySelects.close();for(const dialog of document.querySelectorAll("dialog[open]"))dialog.close()');
    await runtime.saveSettings(original);
    runtime.hideOverlay(); browser.destroy();
  }
};
