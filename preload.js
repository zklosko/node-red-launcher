const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getState: () => ipcRenderer.invoke('get-state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  restart: () => ipcRenderer.invoke('restart'),
  install: () => ipcRenderer.invoke('install'),
  openEditor: () => ipcRenderer.invoke('open-editor'),
  openFolder: (which) => ipcRenderer.invoke('open-folder', which),
  clearLog: () => ipcRenderer.invoke('clear-log'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});
