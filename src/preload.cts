import { contextBridge, ipcRenderer } from 'electron';
import type { GetStateResult, LauncherState, Settings } from './shared/types.js';

interface LauncherAPI {
  getState(): Promise<GetStateResult>
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  install(): Promise<void>
  openEditor(): Promise<void>
  openFolder(which: 'user' | 'install'): Promise<void>
  clearLog(): Promise<void>
  setSettings(patch: Partial<Settings>): Promise<void>
  onState(cb: (state: LauncherState) => void): void
  onLog(cb: (line: string) => void): void
}

const api: LauncherAPI = {
  getState: () => ipcRenderer.invoke('get-state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  restart: () => ipcRenderer.invoke('restart'),
  install: () => ipcRenderer.invoke('install'),
  openEditor: () => ipcRenderer.invoke('open-editor'),
  openFolder: (which) => ipcRenderer.invoke('open-folder', which),
  clearLog: () => ipcRenderer.invoke('clear-log'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  onState: (cb) => {
    ipcRenderer.on('state', (_e, s: LauncherState) => cb(s));
  },
  onLog: (cb) => {
    ipcRenderer.on('log', (_e, line: string) => cb(line));
  },
};

contextBridge.exposeInMainWorld('launcher', api);