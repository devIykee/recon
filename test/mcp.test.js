import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createHub } from '../src/hub.js';
import { runMcp } from '../src/mcp.js';

let hub;
let rpc;

function session(url) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  readline.createInterface({ input: output }).on('line', (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  const done = runMcp({ name: 'tester', url, input, output, log: () => {}, embed: false });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const tool = async (name, args = {}) => {
    const r = await call('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    return { isError: Boolean(r.result.isError), text, data: r.result.isError ? null : JSON.parse(text) };
  };
  return { call, tool, notify: (method) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => { input.end(); return done; } };
}

before(async () => {
  hub = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-mcp-')), demo: false, log: () => {} });
  await hub.listen();
  rpc = session(`http://127.0.0.1:${hub.port}`);
});
after(async () => { await rpc.close(); await hub.close(); });

test('initialize negotiates a protocol version and lists tools', async () => {
  const init = await rpc.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'recon');
  assert.match(init.result.instructions, /recon_briefing/);
  rpc.notify('notifications/initialized');
  const list = await rpc.call('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['recon_briefing', 'recon_coverage', 'recon_add_hypothesis', 'recon_steer', 'recon_propose']) assert.ok(names.includes(n), n);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
  const unknown = await rpc.call('nope/nope', {});
  assert.equal(unknown.error.code, -32601);
});

test('agent works the board through tools, by name', async () => {
  const b = await rpc.tool('recon_briefing');
  assert.equal(b.isError, false);
  assert.ok(b.data.untouched.length > 0);
  const h = await rpc.tool('recon_add_hypothesis', {
    text: 'interest index drifts under rapid borrow/repay', componentId: 'InterestRateModel', confidence: 'low',
    evidence: [{ ref: 'InterestRateModel.sol:30', note: 'rounding down twice' }],
  });
  assert.equal(h.isError, false);
  assert.ok(h.data.targetId, 'target inferred from component');
  const cov = await rpc.tool('recon_coverage', { component: 'Governor.setRiskParams()', reviewState: 'scanning' });
  assert.equal(cov.data.owner, 'ag_tester', 'scanning auto-claims');
  const agent = hub.tenant().store.get('agent', 'ag_tester');
  assert.equal(agent.transport, 'mcp');
  assert.equal(agent.focusItem, cov.data.id);
});

test('starting an engagement never deletes one, and starting by name resumes it', async () => {
  const eng = hub.tenant().engagements;
  const exampleId = hub.tenant().store.state.project.id;
  const r = await rpc.tool('recon_start_engagement', { name: 'Real audit' });
  assert.equal(r.isError, false);
  assert.equal(hub.tenant().store.state.project.name, 'Real audit');
  const realId = hub.tenant().store.state.project.id;
  await rpc.tool('recon_start_engagement', { name: 'Another audit' });
  assert.equal(hub.tenant().store.state.project.name, 'Another audit');
  const again = await rpc.tool('recon_start_engagement', { name: 'real audit' });
  assert.equal(again.data.resumed, true);
  assert.equal(hub.tenant().store.state.project.id, realId);
  const ids = eng.list().engagements.map((e) => e.id);
  assert.ok(ids.includes(exampleId) && ids.includes(realId));
  eng.open(exampleId);
  assert.equal(hub.tenant().store.state.project.example, true);
});

test('recon_map builds the architecture by name and is idempotent', async () => {
  const store = hub.tenant().store;
  const args = {
    target: 'Example Lending Market',
    components: [{ name: 'Keeper', type: 'actor', summary: 'runs jobs' }, { name: 'InterestRateModel', summary: 'rates' }],
    relations: [{ from: 'Keeper', to: 'InterestRateModel', type: 'calls', label: 'poke' }],
  };
  const r = await rpc.tool('recon_map', args);
  assert.equal(r.isError, false);
  assert.deepEqual(r.data.errors, []);
  const before = store.list('relation').length;
  await rpc.tool('recon_map', args);
  assert.equal(store.list('relation').length, before);
  assert.equal(store.list('component').filter((x) => x.name === 'Keeper').length, 1);
  assert.equal(store.list('component').find((x) => x.name === 'InterestRateModel').summary, 'rates');
});

test('human-owned fields are refused with a helpful error', async () => {
  const r = await rpc.tool('recon_update', { ref: 'InterestRateModel', fields: { verification: 'verified' } });
  assert.equal(r.isError, true);
  assert.match(r.text, /human-owned/);
});

test('steer round trip and proposals through mcp', async () => {
  const store = hub.tenant().store;
  const st = store.create('steer', { action: 'cover', note: 'check the flash loan path', to: ['ag_tester'] }, 'human');
  const b = await rpc.tool('recon_briefing');
  assert.equal(b.data.steers[0].id, st.id);
  assert.match(b.data.next, /example|Acknowledge/);
  await rpc.tool('recon_steer', { steerId: st.id, state: 'acknowledged' });
  const done = await rpc.tool('recon_steer', { steerId: st.id, state: 'addressed', response: 'covered, nothing found' });
  assert.equal(done.data.state, 'addressed');
  const p = await rpc.tool('recon_propose', { text: 'fuzz the index', itemId: 'InterestRateModel' });
  assert.equal(p.data.itemKind, 'component');
});
