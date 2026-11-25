import https from 'node:https';
import { execFile, ExecFileOptions } from 'node:child_process';
import { IncomingMessage } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { NodeRuntime } from './shared/types.js';

const USER_AGENT = 'nodered-launcher'
const REQUEST_TIMEOUT_MS = 30000
const MAX_REDIRECTS = 5
const MAX_TEXT_BYTES = 10 * 1024 * 1024

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function run(cmd: string, args: string[], opts: ExecFileOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve(stdout.toString());
    });
  });
}

function fetchHttpsText(url: string, maxBytes: number, redirects = 0): Promise<string> {
  if (redirects > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects'))
  if (!url.startsWith('https://')) return Promise.reject(new Error('Only HTTPS URLs are supported'))

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': USER_AGENT}, timeout: REQUEST_TIMEOUT_MS}, (res: IncomingMessage) => {
      if ([301, 302, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume()
        const next = res.headers.location
        if (!next) return reject(new Error('Redirect without Location header'))
        return fetchHttpsText(new URL(next, url).toString(), maxBytes, redirects + 1).then(resolve).catch(reject)
      }

      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }

      let data = ''
      let size = 0
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        size += Buffer.byteLength(c, 'utf8')
        if (size > maxBytes) {
          req.destroy()
          return reject(new Error('Response exceeded maximum size'))
        }
        data += c
      })
      res.on('end', () => resolve(data))
    })

    req.on('timeout', () => req.destroy(new Error('Request timed out')))
    req.on('error', reject)
  })
}

export function getJSON<T>(url: string): Promise<T> {
  return fetchHttpsText(url, MAX_TEXT_BYTES).then((text) => JSON.parse(text))
}

export function getText(url: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
  return fetchHttpsText(url, maxBytes)
}

export function download(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
  const tmp = `${dest}.tmp`
  fs.rmSync(tmp, {force: true})

  return downloadToFile(url, tmp, onProgress)
    .then(() => fs.renameSync(tmp, dest))
    .catch((e) => {
      fs.rmSync(tmp, {force: true})
    })
}

function downloadToFile(url: string, dest: string, onProgress: (pct: number) => void, redirects = 0): Promise<void> {
  if (redirects > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects'))
  if (!url.startsWith('https://')) return Promise.reject(new Error('Only HTTPS downloads are allowed'))

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT }, timeout: REQUEST_TIMEOUT_MS },
      (res: IncomingMessage) => {
        if ([301, 302, 307, 308].includes(res.statusCode ?? 0)) {
          res.resume();
          const next = res.headers.location;
          if (!next) return reject(new Error('Redirect without Location header'));
          return downloadToFile(new URL(next, url).toString(), dest, onProgress, redirects + 1)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const file = fs.createWriteStream(dest);

        res.on('data', (c: Buffer) => {
          got += c.length;
          if (total) {
            try { onProgress(Math.round((got / total) * 100)); } catch { /* ignore */ }
          }
        });

        res.pipe(file);

        file.on('finish', () => file.close((e) => (e ? reject(e) : resolve())));
        file.on('error', (e) => {
          fs.rmSync(dest, { force: true });
          reject(e);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
      fs.rmSync(dest, { force: true });
    });
    req.on('error', (e) => {
      fs.rmSync(dest, { force: true });
      reject(e);
    });
  });
}

/** rt stands for runtime */
export function envWith(rt: NodeRuntime): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = rt.dir + path.delimiter + (env[key] || '');
  return env;
}