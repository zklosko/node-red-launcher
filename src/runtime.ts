import path from 'node:path';
import fs from 'node:fs';
import { NodeRelease, RuntimeSource } from './shared/types.js';
import { download, errorMessage, getJSON, run } from './helpers.js';
import { log, setBusy } from './main.js';

const minNodeVersion = 22;
const fallbackLTSVersion = 'v22.23.5';

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

export async function resolveRuntime(runtimeDir: string) {
  const managed = path.join(runtimeDir, 'node', 'node.exe');
  if (fs.existsSync(managed)) return makeRuntime(managed, 'managed');
  try {
    const where: string = (await run(lookupCommand(), ['node'])).split(/\r?\n/)[0].trim();
    const major = parseInt((await run(where, ['-v'])).trim().replace('v', ''), 10);
    if (where && major >= minNodeVersion) return makeRuntime(where, 'system');
  } catch { /* no system node */ }
  return null;
}

// This whole function needs to be reworked. Too many variables are hardcoded
async function downloadRuntime(runtimeDir: string) {
  if (process.platform !== 'win32') throw new Error('Automatic Node.js download is only supported on Windows. Install Node.js 22+ manually.');
  setBusy('Finding the latest Node.js 22 LTS…');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let version = fallbackLTSVersion;  // hardcoding fallback version
  try {
    const index = await getJSON<NodeRelease[]>('https://nodejs.org/dist/index.json');
    const hit = index.find((r) => r.lts && r.version.startsWith(fallbackLTSVersion.substring(0, 4)));
    if (hit) version = hit.version;
  } catch (e) { log(`Could not read the Node.js release index (${errorMessage(e)}). Falling back to ${version}.`); }

  fs.mkdirSync(runtimeDir, { recursive: true });
  const zip = path.join(runtimeDir, 'node.zip');
  const url = `https://nodejs.org/dist/${version}/node-${version}-win-${arch}.zip`;
  log(`Downloading Node.js ${version} (${arch})…`);
  let last = -1;
  await download(url, zip, (pct: number) => {
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

export async function ensureRuntime(runtimeDir: string) {
  let rt = await resolveRuntime(runtimeDir);
  if (rt) return rt;
  await downloadRuntime(runtimeDir);
  rt = await resolveRuntime(runtimeDir);
  if (!rt) throw new Error('Node.js runtime could not be set up.');
  return rt;
}
