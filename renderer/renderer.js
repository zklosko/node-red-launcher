const $ = (id) => document.getElementById(id);
const logEl = $('log');
const MAX_LINES = 2000;

function appendLog(line) {
  const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 24;
  logEl.append(line + '\n');
  while (logEl.childNodes.length > MAX_LINES) logEl.removeChild(logEl.firstChild);
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function render(s) {
  const installed = !!s.installedVersion;
  const running = s.redStatus === 'running';
  const active = s.redStatus === 'running' || s.redStatus === 'starting';
  const working = !!s.busy || s.redStatus === 'starting' || s.redStatus === 'stopping';
  const updateAvailable = installed && s.latestVersion && s.latestVersion !== s.installedVersion;

  // Headline
  let title, sub;
  if (s.busy) {
    title = s.busy; sub = 'Please keep the launcher open.';
  } else if (!installed) {
    title = 'Node-RED is not installed'; sub = 'Click Install Node-RED to set it up. No admin rights needed.';
  } else if (s.redStatus === 'starting') {
    title = 'Starting Node-RED…'; sub = `Version ${s.installedVersion}`;
  } else if (s.redStatus === 'stopping') {
    title = 'Stopping Node-RED…'; sub = `Version ${s.installedVersion}`;
  } else if (running) {
    title = 'Node-RED is running'; sub = `Version ${s.installedVersion} · http://localhost:${s.port}`;
  } else {
    title = 'Node-RED is stopped'; sub = `Version ${s.installedVersion}`;
  }
  if (updateAvailable && !s.busy) sub += ` · ${s.latestVersion} is available`;
  $('statusText').textContent = title;
  $('subText').textContent = sub;
  $('dot').className = 'status-dot ' + (running ? 'running' : working ? 'working' : '');

  // Buttons
  const install = $('btnInstall');
  install.textContent = !installed ? 'Install Node-RED' : updateAvailable ? `Update to ${s.latestVersion}` : 'Reinstall / update';
  install.className = !installed || updateAvailable ? 'primary' : '';
  install.disabled = !!s.busy;
  $('btnStart').disabled = !installed || active || working;
  $('btnRestart').disabled = !active || working;
  $('btnStop').disabled = !active || s.redStatus === 'stopping';
  $('btnEditor').disabled = !running;

  // Settings (don't overwrite a field the user is typing in)
  if (document.activeElement !== $('port')) $('port').value = s.settings.port;
  $('autoStart').checked = s.settings.autoStartNodeRed;
  $('loginItem').checked = s.settings.launchAtLogin;
  $('closeToTray').checked = s.settings.closeToTray;
}

$('btnInstall').onclick = () => window.launcher.install();
$('btnStart').onclick = () => window.launcher.start();
$('btnRestart').onclick = () => window.launcher.restart();
$('btnStop').onclick = () => window.launcher.stop();
$('btnEditor').onclick = () => window.launcher.openEditor();
$('btnClear').onclick = () => { logEl.textContent = ''; window.launcher.clearLog(); };
$('btnUserDir').onclick = () => window.launcher.openFolder('user');
$('btnInstallDir').onclick = () => window.launcher.openFolder('install');

$('port').onchange = (e) => window.launcher.setSettings({ port: parseInt(e.target.value, 10) || 1880 });
$('autoStart').onchange = (e) => window.launcher.setSettings({ autoStartNodeRed: e.target.checked });
$('loginItem').onchange = (e) => window.launcher.setSettings({ launchAtLogin: e.target.checked });
$('closeToTray').onchange = (e) => window.launcher.setSettings({ closeToTray: e.target.checked });

window.launcher.onState(render);
window.launcher.onLog(appendLog);

window.launcher.getState().then(({ state, logs }) => {
  logs.forEach(appendLog);
  render(state);
});
