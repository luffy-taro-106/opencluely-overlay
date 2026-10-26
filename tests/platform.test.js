'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { platformInfo, shortcutLabel, loginOptions, startHidden, startupAvailable } = require('../overlay/platform');

test('Mac login registration uses the bundle and login launches remain hidden', () => {
  assert.deepEqual(loginOptions(true, '/Applications/OpenCluely Overlay.app/Contents/MacOS/OpenCluely Overlay', 'darwin'), { openAtLogin: true });
  assert.equal(startHidden([], { wasOpenedAtLogin: true }, 'darwin'), true);
  assert.equal(startHidden([], { openAtLogin: true, wasOpenedAtLogin: false }, 'darwin'), false, 'Manually opening a startup-enabled app must still show it');
  assert.equal(startHidden(['--background'], {}, 'darwin'), true);
  assert.equal(startupAvailable(true, false, false, 'darwin'), false, 'Temporary/translocated app paths cannot register startup');
  assert.equal(startupAvailable(true, true, false, 'darwin'), true);
  assert.equal(startupAvailable(false, true, false, 'darwin'), false);
});
test('Windows startup arguments and portable behavior are preserved', () => {
  assert.deepEqual(loginOptions(false, 'C:\\Apps\\OpenCluely.exe', 'win32'), { openAtLogin: false, path: 'C:\\Apps\\OpenCluely.exe', args: ['--background'] });
  assert.equal(startHidden(['--background'], {}, 'win32'), true);
  assert.equal(startHidden([], { wasOpenedAtLogin: true }, 'win32'), false);
  assert.equal(startupAvailable(true, false, true, 'win32'), false);
  assert.equal(startupAvailable(true, false, false, 'win32'), true);
});
test('platform copy describes real shortcuts and capture limits', () => {
  assert.equal(shortcutLabel('CommandOrControl+Alt+Space', 'darwin'), '⌘+⌥+Space');
  assert.equal(shortcutLabel('CommandOrControl+Alt+I', 'win32'), 'Ctrl+Alt+I');
  assert.equal(platformInfo('darwin').trayName, 'menu bar');
  assert.match(platformInfo('darwin').captureNote, /ScreenCaptureKit can still record/);
  assert.equal(platformInfo('win32').trayName, 'tray');
});
