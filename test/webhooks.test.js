import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sign, verifySignature, validateWebhookUrl, createWebhookManager, fileWebhookStore } from '../src/webhooks.js';
import { createHub } from '../src/hub.js';
import { createCloud } from '../src/cloud/server.js';
import { memoryDb } from '../src/cloud/db.js';
import { agentHealth } from '../src/health.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recon-wh-'));

test('webhook sign and verifySignature: vectors, replay window, secret rotation', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'steer.created' });
  const ts = 1764329160;
  const hdr = sign('whsec_secret_a', ts, body);
  assert.match(hdr, /^t=1764329160,v1=[0-9a-f]{64}$/);

  assert.equal(verifySignature(hdr, 'whsec_secret_a', body, { nowSec: ts + 60 }).ok, true);
  assert.equal(verifySignature(hdr, 'whsec_wrong', body, { nowSec: ts + 60 }).ok, false);
  // replay outside 5-minute tolerance window
  assert.equal(verifySignature(hdr, 'whsec_secret_a', body, { nowSec: ts + 400 }).ok, false);
  // rotation: multiple v1 values in one header
  const rotated = sign(['whsec_new', 'whsec_old'], ts, body);
  assert.equal(verifySignature(rotated, 'whsec_old', body, { nowSec: ts + 10 }).ok, true);
  assert.equal(verifySignature(rotated, 'whsec_new', body, { nowSec: ts + 10 }).ok, true);
});

test('validateWebhookUrl enforces https and blocks private/loopback SSRF targets', () => {
  assert.equal(validateWebhookUrl('https://hooks.example.com/recon').host, 'hooks.example.com');
  for (const bad of [
    'http://hooks.example.com/recon',
    'https://localhost/hook',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.10/hook',
    'https://[::1]/hook',
    'https://user:pass@hooks.example.com/hook',
  ]) {
    assert.throws(() => validateWebhookUrl(bad), `expected ${bad} to be rejected`);
  }
  assert.equal(validateWebhookUrl('http://127.0.0.1:9999/hook', { allowLocal: true }).host, '127.0.0.1:9999');
});

test('webhook manager: retries on 500, marks failing on 400, suppresses when listening, debounces batch', async () => {
  const dir = tmp();
  const store = fileWebhookStore(path.join(dir, 'wh.json'));
  const calls = [];
  let clock = 1_700_000_000_000;
  let nextStatus = 500;
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    const st = nextStatus;
    return { ok: st >= 200 && st < 300, status: st, statusText: st === 200 ? 'OK' : 'ERR' };
  };

  const mgr = createWebhookManager({ store, fetch: fakeFetch, hosted: true, debounceMs: 0, now: () => clock });
  const reg = await mgr.register('default', 'ag_scout', { url: 'https://hooks.example.com/scout', auth: 'bearer', secret: 'tok_123' });
  assert.equal(reg.secret, 'tok_123');

  // listening agent is skipped
  const skipped = await mgr.notify('default', 'ag_scout', { type: 'steer.created', hunt: { id: 'h1', name: 'Acme' }, agent: { id: 'ag_scout', name: 'scout' }, data: { steer: { id: 'st_1' } }, isListening: true });
  assert.equal(skipped.skipped, 'listening');
  assert.equal(calls.length, 0);

  // 500 triggers retryable state
  const d1 = await mgr.notify('default', 'ag_scout', { type: 'steer.created', hunt: { id: 'h1', name: 'Acme' }, agent: { id: 'ag_scout', name: 'scout' }, data: { steer: { id: 'st_1', note: 'check' } }, steerIds: ['st_1'] });
  assert.equal(d1.status, 'retrying');
  assert.equal(d1.attempt, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer tok_123');
  assert.equal(verifySignature(calls[0].headers['recon-signature'], 'tok_123', calls[0].raw, { nowSec: Math.floor(clock / 1000) }).ok, true);

  // advance clock past 5s backoff and retryDue -> succeeds with 200
  clock += 6_000;
  nextStatus = 200;
  const retried = await mgr.retryDue();
  assert.equal(retried.checked, 1);
  assert.equal(retried.results[0].status, 'delivered');
  assert.equal(calls[1].headers['recon-event-id'], calls[0].headers['recon-event-id']);
  assert.equal(calls[1].headers['recon-delivery-attempt'], '2');

  // 400 marks failing immediately without retrying
  nextStatus = 400;
  const d2 = await mgr.notify('default', 'ag_scout', { type: 'steer.created', hunt: { id: 'h1', name: 'Acme' }, agent: { id: 'ag_scout', name: 'scout' }, data: { steer: { id: 'st_2' } }, steerIds: ['st_2'] });
  assert.equal(d2.status, 'failed');
  assert.equal(d2.nextAttemptAt, null);
  mgr.close();
});

test('hub webhook routes: human-only registration, steer push, proposal.decided without double-fire, presence states', async () => {
  const dir = tmp();
  const received = [];
  const hub = createHub({
    dataDir: dir, port: 0, demo: false, seed: 'empty', webhookDebounceMs: 0,
    webhookFetch: async (url, init) => {
      received.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, statusText: 'OK' };
    },
  });
  await hub.listen();
  try {
    // agent joins
    await fetch(`${hub.url}/api/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-recon-agent': 'scout' }, body: JSON.stringify({ focus: 'idle' }) });

    // agent cannot register webhook (humanOnly)
    const forbid = await fetch(`${hub.url}/api/agents/ag_scout/webhook`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-recon-agent': 'scout' },
      body: JSON.stringify({ url: 'https://hooks.example.com/scout' }),
    });
    assert.equal(forbid.status, 403);

    // human registers webhook
    const regRes = await fetch(`${hub.url}/api/agents/ag_scout/webhook`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://hooks.example.com/scout', auth: 'hmac' }),
    });
    assert.equal(regRes.status, 200);
    const reg = await regRes.json();
    assert.match(reg.secret, /^whsec_/);

    // secret is NOT leaked in /api/state
    const state = await (await fetch(`${hub.url}/api/state`)).json();
    assert.equal(JSON.stringify(state).includes(reg.secret), false);
    assert.equal(state.items.agent.ag_scout.wake.via, 'webhook');

    // presence shows asleep-webhook when silent > 90s
    const hl = agentHealth(state, state.items.agent.ag_scout, Date.now() + 15 * 60_000);
    assert.equal(hl.presence, 'asleep-webhook');

    // send test event
    const testRes = await (await fetch(`${hub.url}/api/agents/ag_scout/webhook/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(testRes.status, 'delivered');
    assert.equal(received[0].body.type, 'agent.test');

    // human writes a steer -> fires steer.created
    const steer = await (await fetch(`${hub.url}/api/items/steer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'note', to: ['ag_scout'], note: 'check the new finding' }),
    })).json();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(received.some((r) => r.body.type === 'steer.created' && r.body.data.steer.id === steer.id), true);

    // proposal accept fires proposal.decided and NOT a second steer.created
    const prop = await (await fetch(`${hub.url}/api/items/proposal`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-recon-agent': 'scout' },
      body: JSON.stringify({ text: 'Use combined report?', options: ['combined', 'separate'] }),
    })).json();
    const beforeCount = received.length;
    await fetch(`${hub.url}/api/proposals/${prop.id}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'combined' }),
    });
    await new Promise((r) => setTimeout(r, 40));
    const after = received.slice(beforeCount);
    assert.equal(after.length, 1);
    assert.equal(after[0].body.type, 'proposal.decided');
  } finally {
    await hub.close();
  }
});

test('hosted cloud: durable webhook retry route requires CRON_SECRET and drains due retries', async () => {
  const db = memoryDb();
  let calls = 0;
  const cloud = createCloud({
    db, secret: 's'.repeat(32), cronSecret: 'cron-secret-123', root: tmp(),
    fetch: async () => {
      calls++;
      return calls === 1 ? { ok: false, status: 503, statusText: 'Unavailable' } : { ok: true, status: 200, statusText: 'OK' };
    },
  });
  await cloud.hub.webhooks.register('u1', 'ag_scout', { url: 'https://hooks.example.com/scout' });
  const d = await cloud.hub.webhooks.notify('u1', 'ag_scout', {
    type: 'steer.created', hunt: { id: 'h1', name: 'Acme' }, agent: { id: 'ag_scout', name: 'scout' },
    data: { steer: { id: 'st_9' } }, steerIds: ['st_9'],
  });
  assert.equal(d.status, 'retrying');

  // force due in memory db
  const list = await db.listDeliveries('u1', 'ag_scout', 5);
  await db.saveDelivery({ ...list[0], nextAttemptAt: Date.now() - 1000 });

  // unauthorized call rejected
  const unauth = await dispatchCloud(cloud, 'POST', '/api/internal/webhooks/retry', {});
  assert.equal(unauth.status, 401);

  // authorized cron call drains retry
  const ok = await dispatchCloud(cloud, 'POST', '/api/internal/webhooks/retry', { authorization: 'Bearer cron-secret-123' });
  assert.equal(ok.status, 200);
  const body = JSON.parse(ok.body);
  assert.equal(body.checked, 1);
  assert.equal(body.results[0].status, 'delivered');
});

async function dispatchCloud(cloud, method, url, headers = {}) {
  const { Readable } = await import('node:stream');
  const req = Readable.from([]);
  Object.assign(req, { method, url, headers: { host: 'recon.test', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  let status = 200;
  const chunks = [];
  const res = {
    headersSent: false,
    writeHead(s) { status = s; this.headersSent = true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); },
  };
  await cloud.handle(req, res);
  return { status, body: Buffer.concat(chunks).toString('utf8') };
}
