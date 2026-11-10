export type RedStatus = 'stopped' | 'starting' | 'running' | 'stopping'
export type RuntimeSource = 'managed' | 'system'
export interface Settings {
    port: number
    userDir: string
    autoStartNodeRed: boolean
    launchAtLogin: boolean
    closeToTray: boolean
}
export interface LauncherState {
    redStatus: RedStatus
    busy: string | null
    installedVersion: string | null
    latestVersion: string | null
    port: number,
    settings: Settings
    paths: { 
        userDir: string,
        installDir: string
    }
}

export interface NodeRuntime {
    nodeExe: string;
    npmCli: string;
    dir: string;
    source: 'managed' | 'system';
}

export interface NodeRelease {
  version: string;        // e.g. "v20.18.0"
  lts: string | false;    // codename like "Iron" for LTS releases, otherwise false
}

export interface GetStateResult {
  state: LauncherState
  logs: string[]
}

export interface LauncherAPI {
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