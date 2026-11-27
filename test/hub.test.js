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
