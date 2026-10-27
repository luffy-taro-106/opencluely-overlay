'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel, ...args) => ipcRenderer.invoke(`overlay:${channel}`, ...args);
contextBridge.exposeInMainWorld('overlay', {
  state: () => invoke('state'),
  focusField: field => invoke('focus-field', field),
  ask: question => invoke('ask', question),
  newChat: () => invoke('new-chat'),
  openChat: id => invoke('open-chat', id),
  deleteChat: id => invoke('delete-chat', id),
  cancel: () => invoke('cancel'),
  upload: limit => invoke('upload', limit),
  setAttachments: ids => invoke('set-attachments', ids),
  pasteImage: () => invoke('paste-image'),
  importImage: image => invoke('import-image', image),
  capture: displayId => invoke('capture', displayId),
  releaseImage: id => invoke('release-image', id),
  saveSettings: settings => invoke('save-settings', settings),
  refreshModels: provider => invoke('refresh-models', provider),
  chatgptSignIn: options => invoke('chatgpt-sign-in', options),
  chatgptCancelSignIn: () => invoke('chatgpt-cancel-sign-in'),
  chatgptSelectProfile: id => invoke('chatgpt-select-profile', id),
  chatgptSignOut: id => invoke('chatgpt-sign-out', id),
  chatgptManageUsage: () => invoke('chatgpt-manage-usage'),
  codexSignIn: () => invoke('codex-sign-in'),
  codexCancelSignIn: () => invoke('codex-cancel-sign-in'),
  codexSignOut: () => invoke('codex-sign-out'),
  setRecoveryEnabled: enabled => invoke('set-recovery-enabled', enabled),
  openScreenSettings: () => invoke('screen-settings'),
  clear: () => invoke('clear'),
  export: () => invoke('export'),
  setDiagnosticsRecording: enabled => invoke('set-diagnostics-recording', enabled),
  exportDiagnostics: () => invoke('export-diagnostics'),
  hide: () => invoke('hide'),
  passThrough: () => invoke('pass-through'),
  compact: () => invoke('compact'),
  copy: text => invoke('copy', text),
  quit: () => invoke('quit'),
  quitCompletely: () => invoke('quit-completely'),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('overlay:event', listener);
    return () => ipcRenderer.removeListener('overlay:event', listener);
  }
});
