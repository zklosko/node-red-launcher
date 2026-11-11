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
