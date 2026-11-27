// `recon update`: fetch the latest recon from GitHub, install it over
// ~/.recon/app, and restart the background board. The CLI shim and every MCP
// entry point at ~/.recon/app, so the next CLI command runs the new code, and
// running MCP servers switch to it on their own (see mcpsup.js).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { installCopy, reconHome, ensureHub, isLocalUrl } from './launch.js';
import { ROOT, DEFAULT_PORT } from './config.js';

export const REPO = 'devIykee/recon';
const BRANCH = 'main';
const UA = { 'user-agent': 'recon-updater', accept: 'application/vnd.github+json' };

// What is installed now: { sha, date, installedAt, source } or {}.
export function installed(home = reconHome()) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'app', '.version.json'), 'utf8')); } catch { return {}; }
}

// The newest commit on the default branch.
export async function latest({ repo = REPO, branch = BRANCH, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`could not reach GitHub (${res.status}); check your connection and try again`);
  const c = await res.json();
  return { sha: c.sha, date: c.commit?.committer?.date || c.commit?.author?.date || null, message: (c.commit?.message || '').split('\n')[0] };
}

// A minimal reader for the gzipped tarballs GitHub serves (ustar + pax headers).
export function untar(gz, dest) {
  const buf = zlib.gunzipSync(gz);
  let off = 0;
  let longName = null;
  const files = [];
  const str = (b, s, n) => b.subarray(s, s + n).toString('utf8').replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((x) => x === 0)) break;
    const size = parseInt(str(hdr, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const prefix = str(hdr, 345, 155);
    let name = longName || (prefix ? `${prefix}/${str(hdr, 0, 100)}` : str(hdr, 0, 100));
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); longName = m ? m[1] : null; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    longName = null;
    // GitHub wraps everything in "<repo>-<sha>/"
    name = name.split('/').slice(1).join('/');
    if (!name || name.split('/').includes('..') || path.isAbsolute(name)) continue;
    const out = path.join(dest, name);
    if (type === '5') { fs.mkdirSync(out, { recursive: true }); continue; }
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    files.push(name);
  }
  return files;
}

async function download(sha, dest, { repo = REPO, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://codeload.github.com/${repo}/tar.gz/${sha}`, { headers: { 'user-agent': UA['user-agent'] }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const files = untar(Buffer.from(await res.arrayBuffer()), dest);
  if (!fs.existsSync(path.join(dest, 'bin', 'recon.js'))) throw new Error('the download does not look like recon');
  return files.length;
}

// Ask the local board to save and stop, then start it again from the new code.
async function restartHub({ url, key, bin, log }) {
  if (!isLocalUrl(url)) return { restarted: false, why: 'the board is not on this machine' };
  const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  let was = false;
  try {
    const res = await fetch(`${url}/api/shutdown`, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000) });
    was = res.ok;
    if (!res.ok && res.status !== 404) log(`recon: the board did not stop (${res.status}); restart it yourself to load the update`);
  } catch { /* not running */ }
  if (was) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try { await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) }); } catch { break; }
    }
  }
  if (!was) return { restarted: false, why: 'no board was running' };
  await ensureHub({ url, key, bin });
  return { restarted: true };
}

export async function runUpdate({ from = null, check = false, url = `http://127.0.0.1:${DEFAULT_PORT}`, key, out = process.stdout, home = reconHome(), fetchImpl = fetch } = {}) {
  const say = (s = '') => out.write(`${s}\n`);
  const cur = installed(home);
  const short = (s) => (s ? s.slice(0, 7) : 'unknown');
  say('');
  say('  recon update');
  say('');
  say(`  installed  ${cur.sha ? `${short(cur.sha)}${cur.date ? ` (${cur.date.slice(0, 10)})` : ''}` : cur.source === 'local' ? `from ${cur.from}` : 'a copy from before updates were tracked'}`);
  let target = null;
  if (!from) {
    target = await latest({ fetchImpl });
    say(`  latest     ${short(target.sha)}${target.date ? ` (${target.date.slice(0, 10)})` : ''}${target.message ? `  ${target.message.slice(0, 60)}` : ''}`);
    if (cur.sha === target.sha) { say(''); say('  ✓ already up to date'); say(''); return { updated: false, sha: target.sha }; }
    if (check) { say(''); say('  an update is available: run `recon update`'); say(''); return { updated: false, available: true, sha: target.sha }; }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-update-'));
  try {
    let src = from ? path.resolve(from) : tmp;
    if (!from) { const n = await download(target.sha, tmp, { fetchImpl }); say(`  ✓ downloaded ${n} files`); }
    if (!fs.existsSync(path.join(src, 'bin', 'recon.js'))) throw new Error(`${src} is not a recon checkout`);
    const stamp = from
      ? { source: 'local', from: src, installedAt: new Date().toISOString() }
      : { source: 'update', sha: target.sha, date: target.date, installedAt: new Date().toISOString() };
    const r = installCopy({ home, from: src, force: true, stamp });
    say(`  ✓ installed ${r.app}${r.updated ? '' : ' (no file changed)'}`);
    const hub = await restartHub({ url, key, bin: r.bin, log: (m) => say(`  ${m}`) });
    say(hub.restarted ? '  ✓ board restarted on the new version (your hunts are saved)' : `  · board not restarted: ${hub.why}`);
    say('  ✓ the recon CLI uses the new version from its next command');
    say('  ✓ agents connected over MCP switch to it within a few seconds, without restarting');
    say('    (an MCP server started before this kind of update existed needs one restart of its agent)');
    say('');
    return { updated: true, sha: target?.sha, hub };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void ROOT;
