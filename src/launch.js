// Getting recon running with no setup: a stable local install under ~/.recon,
// a `recon` shim, and a hub started in the background that outlives whichever
// agent or terminal started it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DEFAULT_PORT } from './config.js';

export const GITHUB_SPEC = 'github:devIykee/recon';

export function reconHome(env = process.env) {
  return path.resolve(env.RECON_HOME || path.join(os.homedir(), '.recon'));
}

const COPY = ['package.json', 'LICENSE', 'bin', 'src', 'web'];

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p).sort()) walk(path.join(p, f), out);
  else out.push(p);
  return out;
}

function treeHash(root) {
  const h = crypto.createHash('sha1');
  for (const top of COPY) {
    const p = path.join(root, top);
    if (!fs.existsSync(p)) continue;
    for (const f of walk(p)) { h.update(path.relative(root, f)); h.update(fs.readFileSync(f)); }
  }
  return h.digest('hex');
}

// Copy recon to ~/.recon/app so agent configs point at a stable, fast, offline
// path instead of an npx cache. Re-running refreshes it, except that a copy that
// `recon update` installed is never replaced by whatever an npx cache holds,
// which may be older: only `recon update` (force) replaces it.
export function installCopy({ home = reconHome(), from = ROOT, force = false, stamp = null } = {}) {
  const app = path.join(home, 'app');
  const bin = path.join(app, 'bin', 'recon.js');
  if (path.resolve(from) === path.resolve(app)) return { app, bin, updated: false, shim: writeShim(home, bin) };
  const marker = path.join(app, '.version.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* none yet */ }
  if (!force && current.source === 'update' && fs.existsSync(bin)) return { app, bin, updated: false, kept: current, shim: writeShim(home, bin) };
  const want = treeHash(from);
  const hashFile = path.join(app, '.hash');
  if (fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === want && fs.existsSync(bin)) {
    if (stamp) fs.writeFileSync(marker, JSON.stringify(stamp, null, 2));
    return { app, bin, updated: false, shim: writeShim(home, bin) };
  }
  const tmp = `${app}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const top of COPY) {
    const src = path.join(from, top);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, top), { recursive: true });
  }
  fs.writeFileSync(path.join(tmp, '.version.json'), JSON.stringify(stamp || { source: 'copy', installedAt: new Date().toISOString() }, null, 2));
  // written last: running MCP servers watch this file and switch over when it changes
  const old = `${app}.old-${process.pid}`;
  if (fs.existsSync(app)) fs.renameSync(app, old);
  fs.renameSync(tmp, app);
  fs.rmSync(old, { recursive: true, force: true });
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(hashFile, want);
  return { app, bin, updated: true, shim: writeShim(home, bin) };
}

// The hash running MCP servers compare against to know the install changed.
export function installHash(home = reconHome()) {
  try { return fs.readFileSync(path.join(home, 'app', '.hash'), 'utf8'); } catch { return null; }
}

// ~/.recon/bin/recon (and recon.cmd on windows) so humans and agents can type `recon`.
function writeShim(home, bin) {
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  if (process.platform === 'win32') {
    const p = path.join(dir, 'recon.cmd');
    fs.writeFileSync(p, `@echo off\r\n"${node}" "${bin}" %*\r\n`);
    return p;
  }
  const p = path.join(dir, 'recon');
  fs.writeFileSync(p, `#!/bin/sh\nexec "${node}" "${bin}" "$@"\n`, { mode: 0o755 });
  return p;
}

async function healthy(url, key) {
  try {
    const res = await fetch(`${url}/api/health`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.name === 'recon' ? body : null;
  } catch {
    return null;
  }
}

export function isLocalUrl(url) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url);
}

// Make sure a hub is answering at `url`. For the default local address, start one
// in the background if needed. Returns { url, started }.
export async function ensureHub({ url = `http://127.0.0.1:${DEFAULT_PORT}`, key, bin, home = reconHome(), log = () => {} } = {}) {
  url = url.replace(/\/$/, '');
  if (await healthy(url, key)) return { url, started: false };
  if (!isLocalUrl(url)) throw new Error(`no recon hub answering at ${url}`);
  const port = Number(new URL(url).port || DEFAULT_PORT);
  fs.mkdirSync(home, { recursive: true });
  const logFile = path.join(home, 'hub.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [bin || path.join(ROOT, 'bin', 'recon.js'), 'serve', '--port', String(port), '--data', path.join(home, 'data')], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, RECON_QUIET: '1' },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(fd);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await healthy(url, key)) { log(`recon: started the hub at ${url} (log: ${logFile})`); return { url, started: true, pid: child.pid }; }
  }
  throw new Error(`the hub did not start; see ${logFile}`);
}

export function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(opener, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}
