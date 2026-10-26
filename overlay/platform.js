'use strict';

function platformInfo(platform = process.platform) {
  const mac = platform === 'darwin';
  return {
    mac,
    trayName: mac ? 'menu bar' : 'tray',
    startupHint: mac ? 'Move the app to Applications to enable launch at sign-in.' : 'Install the Windows setup to enable launch at sign-in.',
    captureNote: mac
      ? 'macOS capture protection is best effort. Apps using ScreenCaptureKit can still record this overlay and its Settings. Share a specific app window, or hide this overlay before sharing your whole screen.'
      : 'Capture protection covers this overlay and its Settings. Capture methods vary; check your meeting’s sharing preview before relying on it. File picker dialogs may still appear.'
  };
}

function shortcutLabel(accelerator, platform = process.platform) {
  return accelerator.replace('CommandOrControl', platform === 'darwin' ? '⌘' : 'Ctrl').replace('Alt', platform === 'darwin' ? '⌥' : 'Alt');
}

function loginOptions(enabled, executable, platform = process.platform) {
  // macOS registers the app bundle; Windows registers its executable and arguments.
  return platform === 'darwin' ? { openAtLogin: enabled } : { openAtLogin: enabled, path: executable, args: ['--background'] };
}

function startHidden(argv, login, platform = process.platform) {
  return argv.includes('--background') || (platform === 'darwin' && login.wasOpenedAtLogin === true);
}

function startupAvailable(packaged, installedInApplications, portable, platform = process.platform) {
  return packaged && (platform === 'darwin' ? installedInApplications : !portable);
}

module.exports = { platformInfo, shortcutLabel, loginOptions, startHidden, startupAvailable };
