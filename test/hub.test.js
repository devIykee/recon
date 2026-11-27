import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHub } from '../src/hub.js';

let hub;
let base;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-hub-'));

async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const agent = (name) => ({ 'x-recon-agent': name, 'x-recon-transport': 'cli' });

before(async () => {
  hub = createHub({ port: 0, dataDir, demo: false, log: () => {} });
  await hub.listen();
  base = `http://127.0.0.1:${hub.port}`;
});
after(() => hub.close());

test('serves the example project and the ui', async () => {
  const s = await call('GET', '/api/state');
  assert.equal(s.status, 200);
  assert.equal(s.body.project.example, true);
  assert.ok(s.body.suggestions.length);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('agents register themselves and write with attribution', async () => {
  await call('POST', '/api/reset', { mode: 'empty' });
  const t = await call('POST', '/api/items/target', { name: 'Pool', protocolType: 'amm' });
  assert.equal(t.status, 200);
  const c = await call('POST', '/api/items/component', { targetId: t.body.id, name: 'swap()' }, agent('hound'));
  assert.equal(c.body.createdBy, 'ag_hound');
  const agents = await call('GET', '/api/items/agent');
  assert.equal(agents.body[0].transport, 'cli');
  const denied = await call('PATCH', `/api/items/component/${c.body.id}`, { verification: 'verified' }, agent('hound'));
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /human-owned/);
});

test('steer round trip and briefing', async () => {
  const steer = await call('POST', '/api/items/steer', { action: 'cover', note: 'look at fees', to: ['ag_hound'] });
  const brief = await call('GET', '/api/briefing', null, agent('hound'));
  assert.equal(brief.body.steers[0].id, steer.body.id);
  const ack = await call('POST', `/api/steers/${steer.body.id}/ack`, {}, agent('hound'));
  assert.equal(ack.body.state, 'acknowledged');
  const done = await call('POST', `/api/steers/${steer.body.id}/address`, { response: 'fees fine' }, agent('hound'));
  assert.equal(done.body.state, 'addressed');
  assert.equal(done.body.response, 'fees fine');
});

test('proposals: agent proposes, human accepts, steer goes back', async () => {
  const p = await call('POST', '/api/items/proposal', { text: 'fuzz swap()' }, agent('hound'));
  const nope = await call('POST', `/api/proposals/${p.body.id}/accept`, {}, agent('hound'));
  assert.equal(nope.status, 403);
  const ok = await call('POST', `/api/proposals/${p.body.id}/accept`, {});
  assert.equal(ok.body.state, 'accepted');
  const steers = await call('GET', '/api/items/steer?state=acknowledged');
  assert.ok(steers.body.some((s) => s.note.includes('fuzz swap()')));
});

test('suggestions can be accepted into steers', async () => {
  const sug = await call('GET', '/api/suggestions');
  assert.ok(sug.body.length);
  const steer = await call('POST', `/api/suggestions/${sug.body[0].id}/accept`, {});
  assert.equal(steer.body.action, sug.body[0].action);
});

test('rejects non-json writes, foreign origins and foreign hosts', async () => {
  const r = await fetch(base + '/api/items/target', { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  const o = await call('POST', '/api/items/target', { name: 'x' }, { origin: 'https://evil.example' });
  assert.equal(o.status, 403);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: hub.port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test('live feed over websocket', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
  const msgs = [];
  await new Promise((resolve, reject) => {
    ws.onmessage = (e) => { msgs.push(JSON.parse(e.data)); if (msgs.length === 1) resolve(); };
    ws.onerror = reject;
  });
  assert.equal(msgs[0].t, 'hello');
  const got = new Promise((resolve) => {
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'change' && m.kind === 'target') resolve(m); };
  });
  await call('POST', '/api/items/target', { name: 'Live target' });
  const m = await got;
  assert.equal(m.item.name, 'Live target');
  assert.equal(m.activity.action, 'added');
  ws.close();
});

test('server mode requires a key', async () => {
  assert.throws(() => createHub({ mode: 'server', port: 0, dataDir, log: () => {} }), /RECON_KEY/);
  const h = createHub({ mode: 'server', key: 'sekret', host: '127.0.0.1', port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-srv-')), demo: false, log: () => {} });
  await h.listen();
  const u = `http://127.0.0.1:${h.port}`;
  assert.equal((await fetch(`${u}/api/state`)).status, 401);
  assert.equal((await fetch(`${u}/api/state`, { headers: { authorization: 'Bearer sekret' } })).status, 200);
  assert.equal((await fetch(`${u}/api/health`)).status, 200);
  await h.close();
});

test('multi-tenant mode isolates tenants', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-mt-'));
  const keys = path.join(dir, 'keys.json');
  fs.writeFileSync(keys, JSON.stringify({ keys: [{ key: 'ka', tenant: 'alpha' }, { key: 'kb', tenant: 'beta' }] }));
  const h = createHub({ mode: 'multi', keysFile: keys, host: '127.0.0.1', port: 0, dataDir: dir, demo: false, log: () => {} });
  await h.listen();
  const u = `http://127.0.0.1:${h.port}`;
  const post = (key, body) => fetch(`${u}/api/items/target`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post('ka', { name: 'Alpha target' });
  const b = await (await fetch(`${u}/api/items/target`, { headers: { authorization: 'Bearer kb' } })).json();
  assert.equal(b.length, 0);
  const a = await (await fetch(`${u}/api/items/target`, { headers: { authorization: 'Bearer ka' } })).json();
  assert.equal(a[0].name, 'Alpha target');
  await h.close();
});

test('mcp over http: initialize names the agent from the client, tools work with a key', async () => {
  const h = createHub({ mode: 'server', key: 'k3y', host: '127.0.0.1', port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-mcphttp-')), demo: false, log: () => {} });
  await h.listen();
  const u = `http://127.0.0.1:${h.port}/mcp`;
  const rpc = (body, sid, key = 'k3y') => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null, 'wrong')).status, 401);
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } });
  const sid = init.headers.get('mcp-session-id');
  assert.ok(sid);
  assert.equal((await init.json()).result.serverInfo.name, 'recon');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid)).status, 202);
  const call = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recon_briefing', arguments: {} } }, sid)).json();
  assert.equal(call.result.isError, undefined);
  assert.match(JSON.parse(call.result.content[0].text).next, /example/);
  assert.ok(h.tenant().store.get('agent', 'ag_claude-code'), 'agent named after the mcp client');
  assert.equal(h.tenant().store.get('agent', 'ag_claude-code').transport, 'mcp');
  const forged = await fetch(`http://127.0.0.1:${h.port}/api/state`, { headers: { 'x-recon-internal': 'guess' } });
  assert.equal(forged.status, 401);
  await h.close();
});

test('two agents on two projects at once: each writes to its own hunt, the board stays put', async () => {
  const h = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-hunts-')), seed: 'empty', demo: false, log: () => {} });
  await h.listen();
  const u = `http://127.0.0.1:${h.port}`;
  const as = (agent, hunt) => ({ 'content-type': 'application/json', 'x-recon-agent': agent, 'x-recon-hunt': encodeURIComponent(hunt) });
  const post = (p, body, headers) => fetch(u + p, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());
  await post('/api/start', { name: 'vault-repo' }, as('alpha', 'vault-repo'));
  const onScreen = h.tenant().store.state.project.name;
  await post('/api/items/target', { name: 'Vault' }, as('alpha', 'vault-repo'));
  const bridge = await post('/api/start', { name: 'bridge-repo' }, as('beta', 'bridge-repo'));
  assert.equal(bridge.onScreen, false, 'a busy board is not taken over');
  await post('/api/items/target', { name: 'Bridge' }, as('beta', 'bridge-repo'));
  assert.equal(h.tenant().store.state.project.name, onScreen);
  const eng = h.tenant().engagements;
  assert.deepEqual(eng.storeFor('vault-repo').list('target').map((t) => t.name), ['Vault']);
  assert.deepEqual(eng.storeFor('bridge-repo').list('target').map((t) => t.name), ['Bridge']);
  const briefing = await fetch(`${u}/api/briefing`, { headers: as('beta', 'bridge-repo') }).then((r) => r.json());
  assert.equal(briefing.project, 'bridge-repo');
  eng.open(bridge.hunt.id);
  assert.deepEqual(h.tenant().store.list('target').map((t) => t.name), ['Bridge'], 'opening it shows the agent\'s work');
  await h.close();
});

test('wait: an idle agent wakes when the human writes to it from the board', async () => {
  const hub = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-wait-')), seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const base = `http://127.0.0.1:${hub.port}`;
  const agent = { 'x-recon-agent': 'listener', 'content-type': 'application/json' };
  const s = hub.tenant().store;

  // nothing to say: it times out quietly and the board shows it as listening meanwhile
  const quiet = fetch(`${base}/api/wait?timeout=1`, { headers: agent }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(s.get('agent', 'ag_listener').waitingSince, 'listening while it waits');
  assert.deepEqual((await quiet).woke, false);

  const started = Date.now();
  const pending = fetch(`${base}/api/wait?timeout=20`, { headers: agent }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 300));
  await fetch(`${base}/api/items/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'note', to: ['ag_listener'], note: 'look at the oracle next' }) });
  const woke = await pending;
  assert.equal(woke.woke, true);
  assert.ok(Date.now() - started < 5000, 'woke at once, not at the timeout');
  assert.equal(woke.events[0].type, 'steer');
  assert.equal(woke.events[0].note, 'look at the oracle next');
  assert.match(woke.next, /Acknowledge/);
  assert.ok(!s.get('agent', 'ag_listener').waitingSince, 'no longer listening once woken');

  // an open steer wakes it immediately; acknowledging it stops that
  const again = await (await fetch(`${base}/api/wait?timeout=1`, { headers: agent })).json();
  assert.equal(again.woke, true);
  await fetch(`${base}/api/steers/${woke.events[0].id}/ack`, { method: 'POST', headers: agent, body: '{}' });

  // a decided proposal wakes it too, once
  const p = await (await fetch(`${base}/api/items/proposal`, { method: 'POST', headers: agent, body: JSON.stringify({ text: 'Write the report now?', options: ['yes', 'hunt more'] }) })).json();
  const waitDecision = fetch(`${base}/api/wait?timeout=20`, { headers: agent }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 200));
  await fetch(`${base}/api/proposals/${p.id}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'hunt more' }) });
  const d = await waitDecision;
  assert.equal(d.events[0].type, 'decision');
  assert.equal(d.events[0].choice, 'hunt more');
  assert.equal((await (await fetch(`${base}/api/wait?timeout=1`, { headers: agent })).json()).woke, false, 'the same decision does not wake it twice');

  // the agent answers on the board
  const said = await (await fetch(`${base}/api/items/message`, { method: 'POST', headers: agent, body: JSON.stringify({ text: 'On it: oracle next.' }) })).json();
  assert.equal(said.kind, 'message');
  assert.deepEqual(said.to, ['human']);
  await hub.close();
});

test('agents dismiss a suggestion that does not apply, with the reason', async () => {
  const hub = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-dismiss-')), seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const base = `http://127.0.0.1:${hub.port}`;
  const s = hub.tenant().store;
  const t = s.create('target', { name: 'Perps', protocolType: 'perps', phase: 'hunting' }, 'human');
  s.create('component', { targetId: t.id, name: 'Router.openPosition()' }, 'human');
  const agent = { 'x-recon-agent': 'bot', 'content-type': 'application/json' };
  const b = await (await fetch(`${base}/api/briefing`, { headers: agent })).json();
  const liq = (await (await fetch(`${base}/api/suggestions?limit=50`)).json()).find((x) => /liquidation/i.test(x.title));
  void b;
  assert.ok(liq, 'liquidation is suggested');
  const noReason = await fetch(`${base}/api/suggestions/${liq.id}/dismiss`, { method: 'POST', headers: agent, body: '{}' });
  assert.equal(noReason.status, 400);
  const ok = await (await fetch(`${base}/api/suggestions/${liq.id}/dismiss`, { method: 'POST', headers: agent, body: JSON.stringify({ reason: 'liquidations run on an external engine that is out of scope' }) })).json();
  assert.equal(ok.ok, true);
  const after = await (await fetch(`${base}/api/briefing`, { headers: agent })).json();
  assert.ok(!after.suggestions.some((x) => x.id === liq.id));
  assert.ok(s.state.activity.some((a) => a.by === 'ag_bot' && /dismissed .*external engine/.test(a.summary)), 'the human sees why');
  assert.equal((await fetch(`${base}/api/suggestions/sg_nope/dismiss`, { method: 'POST', headers: agent, body: JSON.stringify({ reason: 'x' }) })).status, 404);
  await hub.close();
});

test('a steer sent in the hunt on screen reaches an agent working in another hunt', async () => {
  const hub = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-away-')), seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const base = `http://127.0.0.1:${hub.port}`;
  const json = { 'content-type': 'application/json' };
  const inB = { ...json, 'x-recon-agent': 'roamer', 'x-recon-hunt': 'hunt-b' };
  // the agent once worked in the hunt on screen, now works in hunt-b
  await fetch(`${base}/api/heartbeat`, { method: 'POST', headers: { ...json, 'x-recon-agent': 'roamer' }, body: '{}' });
  await fetch(`${base}/api/start`, { method: 'POST', headers: { ...json, 'x-recon-agent': 'roamer' }, body: JSON.stringify({ name: 'hunt-b' }) });
  const onScreen = (await (await fetch(`${base}/api/engagements`)).json()).current;
  assert.notEqual((await (await fetch(`${base}/api/state`)).json()).project.name, 'hunt-b', 'hunt-b runs in the background');
  void onScreen;
  // the human steers it from the hunt on screen
  const waiting = fetch(`${base}/api/wait?timeout=20`, { headers: inB }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 300));
  const st = await (await fetch(`${base}/api/items/steer`, { method: 'POST', headers: json, body: JSON.stringify({ action: 'note', to: ['ag_roamer'], note: 'check the oracle' }) })).json();
  const woke = await waiting;
  assert.equal(woke.woke, true);
  assert.equal(woke.events[0].id, st.id);
  assert.ok(woke.events[0].hunt, 'says which hunt it is in');
  const p = await (await fetch(`${base}/api/pulse`, { headers: inB })).json();
  assert.match(p.pulse, /in the hunt .*check the oracle/);
  const b = await (await fetch(`${base}/api/briefing`, { headers: inB })).json();
  assert.equal(b.mustDo.find((x) => x.kind === 'steer-elsewhere').id, st.id);
  await hub.close();
});
