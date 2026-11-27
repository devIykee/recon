import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createHub } from '../src/hub.js';
import { runMcp } from '../src/mcp.js';

const card = { attacker: 'stranger', reachability: 'permissionless', bound: 'vault balance only', liveFunds: 'unknown', alreadyReported: 'no', verificationMethod: 'fork', testName: 'test_Drain', testResult: 'pass' };

test('report: human picks the shape, only ready findings go in, mcp writes the files', async () => {
  const hub = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-rep-')), seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const base = `http://127.0.0.1:${hub.port}`;
  const s = hub.tenant().store;
  const a = s.touchAgent('hunter', { transport: 'mcp' }).id;
  const t = s.create('target', { name: 'Vault', phase: 'hunting', disclosureChannel: 'security@example.org' }, 'human');
  const c = s.create('component', { targetId: t.id, name: 'Vault.withdraw()' }, a);
  const ev = [{ ref: 'Vault.sol:42', kind: 'code' }, { ref: 'test_Drain', kind: 'fork', block: '19000000' }];
  s.create('finding', { title: 'Reentrant drain', severity: 'high', targetId: t.id, componentId: c.id, ...card, evidence: ev, notes: 'calls out before updating shares' }, a);
  s.create('finding', { title: 'Untested rounding', bugClass: 'rounding', severity: 'low', targetId: t.id, componentId: c.id, ...card, testResult: 'not-run', evidence: ev }, a);

  const agentHeaders = { 'content-type': 'application/json', 'x-recon-agent': 'hunter' };
  const early = await fetch(`${base}/api/report/write`, { method: 'POST', headers: agentHeaders, body: '{}' });
  assert.equal(early.status, 409);
  assert.match((await early.json()).error, /recon_propose and options/);
  const pick = await fetch(`${base}/api/report`, { method: 'PATCH', headers: agentHeaders, body: JSON.stringify({ shape: 'combined' }) });
  assert.equal(pick.status, 403, 'the shape is the human\'s call');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-rep-out-'));
  await fetch(`${base}/api/report`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shape: 'separate', path: dir }) });

  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  readline.createInterface({ input: output }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const done = runMcp({ name: 'hunter', url: base, input, output, log: () => {}, embed: false });
  const r = await new Promise((resolve) => { pending.set(1, resolve); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recon_write_report', arguments: {} } })}\n`); });
  const data = JSON.parse(r.result.content[0].text);
  assert.equal(data.included.length, 1);
  assert.equal(data.included[0].title, 'Reentrant drain');
  assert.match(data.excluded.find((x) => x.title === 'Untested rounding').reasons.join(), /has not passed/);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['00-index.md', '01-reentrant-drain.md']);
  const body = fs.readFileSync(path.join(dir, '01-reentrant-drain.md'), 'utf8');
  assert.match(body, /\| Attacker \| stranger \|/);
  assert.match(body, /test_Drain/);
  assert.match(body, /security@example.org/);
  assert.ok(s.state.project.report.last.at);

  await fetch(`${base}/api/report`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shape: 'combined' }) });
  const combined = await (await fetch(`${base}/api/report`)).json();
  assert.equal(combined.files.length, 1);
  assert.match(combined.files[0].body, /## Summary/);
  input.end();
  await done;
  await hub.close();
});
