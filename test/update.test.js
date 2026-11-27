import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHub } from '../src/hub.js';
import { installCopy } from '../src/launch.js';
import { untar, runUpdate, installed } from '../src/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// a GitHub-style tarball of this checkout: everything under "recon-<sha>/"
function tarball(sha) {
  const dir = tmp('tb-');
  const top = path.join(dir, `recon-${sha}`);
  fs.mkdirSync(top);
  for (const f of ['package.json', 'LICENSE', 'bin', 'src', 'web']) fs.cpSync(path.join(ROOT, f), path.join(top, f), { recursive: true });
  const deep = path.join(top, 'src', 'a'.repeat(60), 'b'.repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'long.txt'), 'long path');
  const out = path.join(dir, 'x.tar.gz');
  const r = spawnSync('tar', ['-czf', out, '-C', dir, `recon-${sha}`]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(out);
}

test('untar reads GitHub tarballs, long paths included, and strips the top folder', () => {
  const dest = tmp('un-');
  const files = untar(tarball('abc'), dest);
  assert.ok(files.includes('bin/recon.js'));
  assert.equal(fs.readFileSync(path.join(dest, 'src', 'a'.repeat(60), 'b'.repeat(60), 'long.txt'), 'utf8'), 'long path');
});

test('recon update installs the latest commit, and an npx copy never rolls it back', async () => {
  const home = tmp('home-');
  const sha = 'f'.repeat(40);
  const gz = tarball(sha);
  const fake = async (url) => {
    if (url.includes('api.github.com')) return new Response(JSON.stringify({ sha, commit: { committer: { date: '2026-11-27T10:00:00Z' }, message: 'new things' } }), { status: 200 });
    if (url.includes('codeload.github.com')) return new Response(gz, { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  const out = { text: '', write(s) { this.text += s; } };
  const r = await runUpdate({ home, fetchImpl: fake, out, url: 'http://127.0.0.1:1' });
  assert.equal(r.updated, true);
  assert.equal(installed(home).sha, sha);
  assert.ok(fs.existsSync(path.join(home, 'app', 'bin', 'recon.js')));
  const again = await runUpdate({ home, fetchImpl: fake, out, url: 'http://127.0.0.1:1' });
  assert.equal(again.updated, false);
  assert.match(out.text, /already up to date/);
  // the paste-in line runs from an npx cache that may be older: it must not replace the update
  const kept = installCopy({ home, from: ROOT });
  assert.equal(kept.updated, false);
  assert.equal(installed(home).sha, sha);
});

test('agents on MCP switch to the updated recon without reconnecting, and stay in their hunt', async () => {
  const home = tmp('home-');
  installCopy({ home, from: ROOT, force: true, stamp: { source: 'update', sha: '1'.repeat(40) } });
  const hub = createHub({ port: 0, dataDir: tmp('data-'), seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'recon.js'), 'mcp', '--name', 'swapper', '--url', `http://127.0.0.1:${hub.port}`], {
    env: { ...process.env, RECON_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const seen = [];
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); seen.push(m); waiting.get(m.id)?.(m); });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  const tool = async (name, args = {}) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.capabilities.tools.listChanged, true);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await tool('recon_start_engagement', { name: 'swap-hunt' });
    const before = (await rpc('tools/list', {})).result.tools.find((t) => t.name === 'recon_briefing').description;

    // an update lands: new code in ~/.recon/app
    const mcpFile = path.join(home, 'app', 'src', 'mcp.js');
    fs.writeFileSync(mcpFile, fs.readFileSync(mcpFile, 'utf8').replace("description: `Start here, and call again", "description: `UPDATED. Start here, and call again"));
    fs.writeFileSync(path.join(home, 'app', '.hash'), 'changed');
    for (let i = 0; i < 100 && !seen.some((m) => m.method === 'notifications/tools/list_changed'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(seen.some((m) => m.method === 'notifications/tools/list_changed'), 'the client is told the tools changed');

    const after = (await rpc('tools/list', {})).result.tools.find((t) => t.name === 'recon_briefing').description;
    assert.notEqual(after, before);
    assert.match(after, /^UPDATED/);
    const b = await tool('recon_briefing');
    assert.equal(b.project, 'swap-hunt', 'still in the hunt it switched to');
  } finally {
    child.stdin.end();
    await new Promise((r) => { if (child.exitCode !== null) r(); else child.on('exit', r); });
    await hub.close();
  }
});
