import https from 'node:https';
import { execFile, ExecFileOptions } from 'node:child_process';
import { IncomingMessage } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { NodeRuntime } from './shared/types.js';

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

export function getJSON<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nodered-launcher' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

export function download(url: string, dest: string, onProgress: (pct: number) => void) {
  return new Promise((resolve, reject) => {
    https.get(url, (res: IncomingMessage) => {
      if ([301, 302, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        const next = res.headers.location
        if (!next) return reject(new Error('Redirect without a location'))
        return resolve(download(new URL(next, url).toString(), dest, onProgress));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (total) onProgress(Math.round((got / total) * 100)); });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
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