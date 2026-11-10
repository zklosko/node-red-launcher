import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } from 'electron';
import { spawn, ChildProcess, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { LauncherState, RedStatus, RuntimeSource, Settings, NodeRelease } from './shared/types.js';
import { download, envWith, errorMessage, getJSON, run } from './helpers.js';
const __dirname = import.meta.dirname

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths & settings
// Everything lives under %APPDATA%\Node-RED Launcher so no admin rights needed.
// ---------------------------------------------------------------------------
const baseDir = app.getPath('userData');
const runtimeDir = path.join(baseDir, 'runtime');            // portable Node.js (if no system Node)
const installDir = path.join(baseDir, 'node-red');           // npm --prefix target
const redJs = path.join(installDir, 'node_modules', 'node-red', 'red.js');
const settingsFile = path.join(baseDir, 'launcher-settings.json');

const defaults: Settings = {
  port: 1880,
  userDir: path.join(baseDir, 'userdir'),   // flows, credentials, settings.js, installed palette nodes
  autoStartNodeRed: false,
  launchAtLogin: false,
  closeToTray: true,
};
let settings = { ...defaults };

function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } catch { /* first run */ }
}
function saveSettings() {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

let redProc: ChildProcess | null = null;
let redStatus: RedStatus = 'stopped';      // stopped | starting | running | stopping
let busy: string | null = null;                // null | string describing a long task (installing, downloading...)
let latestVersion: string | null = null;
const logBuffer: string[] = [];
const MAX_LOG = 2000;

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(installDir, 'node_modules', 'node-red', 'package.json'), 'utf8')).version;
  } catch { return null; }
}

function getState(): LauncherState {
  return {
    redStatus,
    busy,
    installedVersion: installedVersion(),
    latestVersion,
    port: settings.port,
    settings,
    paths: { userDir: settings.userDir, installDir },
  };
}

function emitState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', getState());
  buildTrayMenu();
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
function log(text: string) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(ANSI, '');
    if (!line.trim()) continue;
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOG) logBuffer.shift();
    if (win && !win.isDestroyed()) win.webContents.send('log', line);
  }
}

function setBusy(msg: string | null) {
  busy = msg;
  emitState();
}

// ---------------------------------------------------------------------------
// Node.js runtime: use the managed copy, else a system Node >= 18, else null
// ---------------------------------------------------------------------------
function makeRuntime(nodeExe: string, source: RuntimeSource) {
  const dir = path.dirname(nodeExe);
  const npmCli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) return null;
  return { nodeExe, npmCli, dir, source };
}

function lookupCommand(): string {
  switch(process.platform) {
    case 'win32': return 'where';
    case 'darwin':
    case 'linux': return 'which';
    default: throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

async function resolveRuntime() {
  const managed = path.join(runtimeDir, 'node', 'node.exe');
  if (fs.existsSync(managed)) return makeRuntime(managed, 'managed');
  try {
    const where: string = (await run(lookupCommand(), ['node'])).split(/\r?\n/)[0].trim();
    const major = parseInt((await run(where, ['-v'])).trim().replace('v', ''), 10);
    if (where && major >= 18) return makeRuntime(where, 'system');
  } catch { /* no system node */ }
  return null;
}

async function downloadRuntime() {
  if (process.platform !== 'win32') throw new Error('Automatic Node.js download is only supported on Windows. Install Node.js 18+ manually.');
  setBusy('Finding the latest Node.js 20 LTS…');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let version = 'v20.18.0';
  try {
    const index = await getJSON<NodeRelease[]>('https://nodejs.org/dist/index.json');
    const hit = index.find((r) => r.lts && r.version.startsWith('v20.'));
    if (hit) version = hit.version;
  } catch (e) { log(`Could not read the Node.js release index (${errorMessage(e)}). Falling back to ${version}.`); }

  fs.mkdirSync(runtimeDir, { recursive: true });
  const zip = path.join(runtimeDir, 'node.zip');
  const url = `https://nodejs.org/dist/${version}/node-${version}-win-${arch}.zip`;
  log(`Downloading Node.js ${version} (${arch})…`);
  let last = -1;
  await download(url, zip, (pct) => {
    if (pct !== last && pct % 5 === 0) { last = pct; setBusy(`Downloading Node.js ${version}… ${pct}%`); }
  });

  setBusy('Unpacking Node.js…');
  log('Unpacking Node.js…');
  await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${runtimeDir}' -Force`]);
  const target = path.join(runtimeDir, 'node');
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(path.join(runtimeDir, `node-${version}-win-${arch}`), target);
  fs.rmSync(zip, { force: true });
  log(`Node.js ${version} is ready.`);
}

async function ensureRuntime() {
  let rt = await resolveRuntime();
  if (rt) return rt;
  await downloadRuntime();
  rt = await resolveRuntime();
  if (!rt) throw new Error('Node.js runtime could not be set up.');
  return rt;
}

// ---------------------------------------------------------------------------
// Install / update Node-RED
// ---------------------------------------------------------------------------
function spawnLogged(cmd: string, args: string[], opts: SpawnOptions) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    p.stdout?.on('data', (d) => log(d));
    p.stderr?.on('data', (d) => log(d));
    p.on('error', (e) => { log(`Error: ${e.message}`); resolve(-1); });
    p.on('exit', (code) => resolve(code));
  });
}

async function checkLatest(): Promise<void> {
  try {
    const info = await getJSON<{ version: string}>('https://registry.npmjs.org/node-red/latest');
    latestVersion = info.version;
  } catch { /* offline is fine */ }
  emitState();
}

async function installNodeRed() {
  if (busy) return;
  const wasRunning = redStatus === 'running' || redStatus === 'starting';
  try {
    if (wasRunning) await stopRed();
    setBusy('Preparing Node.js…');
    const rt = await ensureRuntime();
    log(`Using Node.js (${rt.source}): ${rt.nodeExe}`);

    fs.mkdirSync(installDir, { recursive: true });
    const pkg = path.join(installDir, 'package.json');
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'nodered-launcher-install', private: true }));

    setBusy('Installing Node-RED… this can take a few minutes');
    log('Running: npm install node-red@latest');
    const code = await spawnLogged(
      rt.nodeExe,
      [rt.npmCli, 'install', '--prefix', installDir, 'node-red@latest', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: installDir, env: envWith(rt) }
    );
    if (code !== 0) throw new Error(`npm exited with code ${code}`);
    log(`Node-RED ${installedVersion()} installed.`);
  } catch (e) {
    log(`Install failed: ${errorMessage(e)}`);
    dialog.showErrorBox('Install failed', `${errorMessage(e)}\n\nSee the log for details.`);
  } finally {
    setBusy(null);
    checkLatest();
  }
  if (wasRunning && installedVersion()) startRed();
}

// ---------------------------------------------------------------------------
// Start / stop / restart Node-RED
// ---------------------------------------------------------------------------
async function startRed() {
  if (redProc || busy) return;
  if (!installedVersion()) { log('Node-RED is not installed yet.'); return; }
  const rt = await resolveRuntime();
  if (!rt) { log('No Node.js runtime found. Click "Install Node-RED" to set one up.'); return; }

  fs.mkdirSync(settings.userDir, { recursive: true });
  redStatus = 'starting';
  emitState();
  log(`Starting Node-RED on port ${settings.port}…`);

  const proc = spawn(
    rt.nodeExe,
    [redJs, '--userDir', settings.userDir, '-p', String(settings.port)],
    { cwd: settings.userDir, env: envWith(rt), windowsHide: true }
  );
  redProc = proc;

  const onData = (d: any) => {
    const text = d.toString();
    log(text);
    if (redStatus === 'starting' && /Server now running at/i.test(text)) {
      redStatus = 'running';
      emitState();
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => log(`Failed to launch: ${e.message}`));
  proc.on('exit', (code, signal) => {
    log(`Node-RED stopped (${signal || 'exit code ' + code}).`);
    if (redProc === proc) redProc = null;
    redStatus = 'stopped';
    emitState();
  });
}

function stopRed() {
  return new Promise<void>((resolve) => {
    const proc = redProc;
    if (proc?.pid === undefined) return resolve();
    redStatus = 'stopping';
    emitState();
    proc.once('exit', () => resolve());
    if (process.platform === 'win32') {
      // /T kills the whole process tree (Exec nodes, child scripts, etc.)
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
    setTimeout(resolve, 10000); // never hang the UI
  });
}

async function restartRed() {
  if (busy) return;
  log('Restarting Node-RED…');
  await stopRed();
  await startRed();
}

function openEditor() {
  shell.openExternal(`http://localhost:${settings.port}`);
}

// ---------------------------------------------------------------------------
// Window & tray
// ---------------------------------------------------------------------------
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 680,
    minWidth: 640,
    minHeight: 520,
    title: 'Node-RED Launcher',
    icon: iconPath,
    backgroundColor: '#f3f1ee',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) { e.preventDefault(); win?.hide(); }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win?.show();
  win?.focus();
}

function buildTrayMenu() {
  if (!tray) return;
  const running = redStatus === 'running' || redStatus === 'starting';
  const installed = !!installedVersion();
  tray.setToolTip(`Node-RED Launcher — ${busy ? 'working…' : redStatus}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show launcher', click: showWindow },
    { label: 'Open editor', enabled: redStatus === 'running', click: openEditor },
    { type: 'separator' },
    { label: 'Start', enabled: installed && !running && !busy, click: startRed },
    { label: 'Restart', enabled: running && !busy, click: restartRed },
    { label: 'Stop', enabled: running, click: stopRed },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  buildTrayMenu();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('get-state', () => ({ state: getState(), logs: logBuffer }));
ipcMain.handle('start', () => startRed());
ipcMain.handle('stop', () => stopRed());
ipcMain.handle('restart', () => restartRed());
ipcMain.handle('install', () => installNodeRed());
ipcMain.handle('open-editor', () => openEditor());
ipcMain.handle('open-folder', (_e, which) => {
  const target = which === 'install' ? installDir : settings.userDir;
  fs.mkdirSync(target, { recursive: true });
  shell.openPath(target);
});
ipcMain.handle('clear-log', () => { logBuffer.length = 0; });
ipcMain.handle('set-settings', (_e, patch: Settings) => {
  const portChanged = patch.port !== undefined && patch.port !== settings.port;
  settings = { ...settings, ...patch };
  settings.port = Math.min(65535, Math.max(1, Math.trunc(Number(settings.port)) || 1880));
  saveSettings();
  app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin });
  emitState();
  if (portChanged && redProc) log('Port changed. Restart Node-RED to apply it.');
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  log('Launcher was already running in system tray; showing the existing window.')
  showWindow()
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();
  checkLatest();
  if (settings.autoStartNodeRed) startRed();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  if (redProc) {
    e.preventDefault();
    stopRed().then(() => app.quit());
  }
});

// Keep running in the tray when the window closes.
app.on('window-all-closed', () => {});
