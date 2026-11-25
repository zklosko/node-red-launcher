import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import extractZip from 'extract-zip'
import { NodeRelease, RuntimeSource } from './shared/types.js';
import { download, errorMessage, getJSON, getText, run } from './helpers.js';
import type { Logger } from './logger.js';

const nodeMajor = 22;
const fallbackLTSVersion = 'v22.15.0';

/** Returns runtime path for Node on Windows */
function managedNode(runtimeDir: string) {
  return path.resolve(runtimeDir, 'node', 'node.exe')
}

function makeRuntime(nodeExe: string, source: RuntimeSource) {
  const dir = path.dirname(nodeExe);
  const npmCli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) return null;
  return { nodeExe, npmCli, dir, source };
}

export async function resolveRuntime(runtimeDir: string) {
  const managed = path.join(runtimeDir, 'node', 'node.exe');
  if (fs.existsSync(managed)) return makeRuntime(managed, 'managed');

  try {
    const whichCmd = process.platform === "win32" ? "where" : "which"
    const sys = (await run(whichCmd, ['node'])).split(/\r?\n/)[0].trim();
    const major = parseInt((await run(sys, ['-v'])).trim().replace('v', ''), 10);
    if (sys && major >= nodeMajor) return makeRuntime(sys, 'system');
  } catch { /* no system node */ }
  return null;
}

function cachedVersion(runtimeDir: string): string | null {
  try {
    return fs.readFileSync(path.join(runtimeDir, '.node-version'), 'utf8').trim()
  } catch { return null }
}

function setCachedVersion(runtimeDir: string, version: string) {
  fs.mkdirSync(runtimeDir, {recursive: true})
  fs.writeFileSync(path.join(runtimeDir, '.node-version'), version)
}

/** Calculates hash of downloaded file */
async function sha256File(filepath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filepath)
      .on('data', (d) => hash.update(d))
      .on('end', resolve)
      .on('error', reject)
  })
  return hash.digest('hex')
}

let downloadPromise: Promise<void> | null = null

async function downloadRuntimeImpl(runtimeDir: string, logger: Logger) {
  if (process.platform !== 'win32') throw new Error('Automatic Node.js download is only supported on Windows. Install Node.js 22+ manually.');

  logger.setBusy('Finding the latest Node.js 22 LTS…');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let version = cachedVersion(runtimeDir) ?? fallbackLTSVersion;
  
  try {
    const index = await getJSON<NodeRelease[]>('https://nodejs.org/dist/index.json');
    const hit = index.find((r) => r.lts && r.version.startsWith(`v${nodeMajor}`));
    if (hit) {
      version = hit.version;
      setCachedVersion(runtimeDir, version)
    }
  } catch (e) { logger.log(`Could not read the Node.js release index (${errorMessage(e)}). Falling back to ${version}.`); }

  fs.mkdirSync(runtimeDir, { recursive: true });
  const zip = path.join(runtimeDir, 'node.zip');
  const fileName = `node-${version}-win-${arch}.zip`
  const url = `https://nodejs.org/dist/${version}/${fileName}`;

  logger.log(`Downloading Node.js ${version} (${arch})…`);
  let last = -1;
  await download(url, zip, (pct: number) => {
    if (pct !== last && pct % 5 === 0) { last = pct; logger.setBusy(`Downloading Node.js ${version}… ${pct}%`); }
  });

  logger.setBusy('Verifying Node.js download...')
  const expected = await (async () => {
    try {
      const sums = await getText(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)
      const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(fileName))
      return line?.split(/\s+/)[0] ?? null
    } catch { return null }
  })()

  if (expected) {
    const actual = await sha256File(zip)
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Node.js download checksum mismatch. Expected ${expected}, got ${actual}.`)
    }
    logger.log('SHA-256 checksum verified.')
  } else {
    logger.log('Could not fetch SHA-256 checksum; continuing without verification.')
  }

  logger.setBusy('Unpacking Node.js…');
  logger.log('Unpacking Node.js…');
  const target = path.join(runtimeDir, 'node');
  let extracted: string | null = null
  try {
      await extractZip(zip, { dir: runtimeDir})
      const entries = fs.readdirSync(runtimeDir).filter(
        (e) => fs.statSync(path.join(runtimeDir, e)).isDirectory() && e.startsWith('node-')
      )
      if (entries.length !== 1) throw new Error('Unexpected contents in Node.js archive')
      extracted = path.join(runtimeDir, entries[0])
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(extracted, target);
  } catch (e) {
    if (extracted) fs.rmSync(extracted, { recursive: true, force: true })
    throw e
  } finally {
    fs.rmSync(zip, { force: true });
  }

  const rt = makeRuntime(managedNode(runtimeDir), 'managed')
  if (!rt) throw new Error('Node.js runtime unpacked, but npm-cli.js is missing')
  
  const reported = (await run (rt.nodeExe, ['-v'])).trim()
  if (reported !== version) {
    throw new Error(`Runtime reports ${reported}, expected ${version}`)
  }

  logger.log(`Node.js ${reported} is ready.`)
}

export async function downloadRuntime(runtimeDir: string, logger: Logger) {
  if (!downloadPromise) {
    downloadPromise = downloadRuntimeImpl(runtimeDir, logger).finally(() => { downloadPromise = null })
  }
  return downloadPromise
}

export async function ensureRuntime(runtimeDir: string, logger: Logger) {
  let rt = await resolveRuntime(runtimeDir);
  if (rt) return rt;
  await downloadRuntime(runtimeDir, logger);
  const final = await resolveRuntime(runtimeDir);
  if (!final) throw new Error('Node.js runtime could not be set up.');
  return final;
}
