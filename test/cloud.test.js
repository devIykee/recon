import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCloud } from '../src/cloud/server.js';
import { memoryDb } from '../src/cloud/db.js';

const SECRET = 'x'.repeat(48);

// ---------- a software authenticator, standing in for a phone or a security key ----------

function cbor(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (typeof v === 'object') return cbor(new Map(Object.entries(v)));
  throw new Error('cbor');
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (x) => crypto.createHash('sha256').update(x).digest();

function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  return {
    credId,
    create(opts, origin) {
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(opts.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin }));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] } };
    },
    get(opts, origin) {
      counter++;
      const c = Buffer.alloc(4); c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(opts.rpId), Buffer.from([0x05]), c]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin }));
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null } };
    },
  };
}

// ---------- a browser with a cookie jar ----------

function browser(base) {
  const jar = new Map();
  const origin = base;
  async function call(method, p, body, extra = {}) {
    const headers = { origin, ...extra };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar.set(k, v); else jar.delete(k); }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return { call, jar, origin };
}

async function instance(db) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cloud-'));
  const cloud = createCloud({ db, secret: SECRET, root, log: () => {} });
  const server = http.createServer((req, res) => cloud.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { cloud, server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function signUp(b, name) {
  const key = authenticator();
  const opts = (await b.call('POST', '/auth/register/options', { name })).json;
  const done = await b.call('POST', '/auth/register/verify', { credential: key.create(opts, b.origin) });
  assert.equal(done.status, 200, done.text);
  return { key, ...done.json };
}

test('sign up with a passkey, sign in again, and work on your own board', async () => {
  const db = memoryDb();
  const a = await instance(db);
  try {
    const b = browser(a.base);
    assert.match((await b.call('GET', '/')).text, /Start free with a passkey/, 'visitors see the landing page');
    assert.equal((await b.call('GET', '/api/state')).status, 401);
    const { key, recoveryCode, user } = await signUp(b, 'iyke');
    assert.match(recoveryCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    assert.match((await b.call('GET', '/')).text, /<html|<!doctype/i);
    const me = (await b.call('GET', '/auth/me')).json;
    assert.equal(me.user.name, 'iyke');
    const st = await b.call('GET', '/api/state');
    assert.equal(st.status, 200, st.text);
    assert.ok(st.json.project);
    const t = await b.call('POST', '/api/items/target', { name: 'Vault', protocolType: 'vault' });
    assert.equal(t.status, 200, t.text);
    // sign out, sign back in with the same passkey
    await b.call('POST', '/auth/logout');
    assert.equal((await b.call('GET', '/api/state')).status, 401);
    const lo = (await b.call('POST', '/auth/login/options')).json;
    const li = await b.call('POST', '/auth/login/verify', { credential: key.get(lo, b.origin) });
    assert.equal(li.status, 200, li.text);
    assert.equal(Object.values((await b.call('GET', '/api/state')).json.items.target)[0].name, 'Vault');
    // a replayed sign-in (old challenge) is refused
    const replay = await b.call('POST', '/auth/login/verify', { credential: key.get(lo, b.origin) });
    assert.equal(replay.status, 400);
    // recovery code: works once, then is replaced
    const b2 = browser(a.base);
    const rec = await b2.call('POST', '/auth/recover', { account: user.id, code: recoveryCode });
    assert.equal(rec.status, 200, rec.text);
    assert.notEqual(rec.json.recoveryCode, recoveryCode);
    assert.equal((await browser(a.base).call('POST', '/auth/recover', { account: user.id, code: recoveryCode })).status, 401);
    assert.equal((await b.call('GET', '/api/state')).status, 401, 'recovery signs out everywhere else');
  } finally { await a.close(); }
});

test('every account is private: another user sees nothing, a wrong-site passkey is refused', async () => {
  const db = memoryDb();
  const a = await instance(db);
  try {
    const one = browser(a.base);
    const two = browser(a.base);
    await signUp(one, 'one');
    await signUp(two, 'two');
    await one.call('POST', '/api/items/target', { name: 'Secret target' });
    const st = (await two.call('GET', '/api/state')).json;
    assert.equal(Object.keys(st.items.target).length, 0);
    // cross-site write from a page elsewhere
    const evil = await fetch(`${a.base}/api/items/target`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: [...one.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(evil.status, 403);
    // a passkey made for another site
    const k = authenticator();
    const opts = (await browser(a.base).call('POST', '/auth/register/options', { name: 'x' })).json;
    const c = browser(a.base);
    const o2 = (await c.call('POST', '/auth/register/options', { name: 'x' })).json;
    void opts;
    const bad = await c.call('POST', '/auth/register/verify', { credential: k.create({ ...o2, rp: { id: 'evil.example' } }, c.origin) });
    assert.equal(bad.status, 400);
  } finally { await a.close(); }
});

test('agents connect with an api key, over the api and over MCP', async () => {
  const db = memoryDb();
  const a = await instance(db);
  try {
    const b = browser(a.base);
    await signUp(b, 'iyke');
    const { key } = (await b.call('POST', '/auth/keys', { label: 'claude' })).json;
    assert.match(key, /^rk_/);
    const H = { authorization: `Bearer ${key}`, 'x-recon-agent': 'claude', 'content-type': 'application/json' };
    const br = await fetch(`${a.base}/api/briefing`, { headers: H });
    assert.equal(br.status, 200, await br.clone().text());
    assert.equal((await fetch(`${a.base}/api/briefing`, { headers: { ...H, authorization: 'Bearer rk_nope' } })).status, 401);
    // remote MCP
    const rpc = async (body, sid) => fetch(`${a.base}/mcp`, { method: 'POST', headers: { ...H, accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } });
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid);
    const call = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recon_add_target', arguments: { name: 'From MCP', protocolType: 'vault' } } }, sid)).json();
    assert.equal(call.result.isError, undefined, JSON.stringify(call));
    const st = (await b.call('GET', '/api/state')).json;
    assert.ok(Object.values(st.items.target).some((t) => t.name === 'From MCP'), 'the human sees what the agent did');
    assert.ok(Object.values(st.items.agent).some((x) => x.name === 'claude'));
    // revoke
    const id = (await b.call('GET', '/auth/me')).json.apiKeys[0].id;
    await b.call('POST', '/auth/keys/remove', { id });
    assert.equal((await fetch(`${a.base}/api/briefing`, { headers: H })).status, 401);
  } finally { await a.close(); }
});

test('two server instances on one database never lose a write', async () => {
  const db = memoryDb();
  const a = await instance(db);
  const c = await instance(db);
  try {
    const ba = browser(a.base);
    await signUp(ba, 'iyke');
    const bc = browser(c.base);
    for (const [k, v] of ba.jar) bc.jar.set(k, v);
    const t = (await ba.call('POST', '/api/items/target', { name: 'Vault' })).json;
    const writes = [];
    for (let i = 0; i < 12; i++) writes.push((i % 2 ? ba : bc).call('POST', '/api/items/component', { targetId: t.id, name: `Part ${i}` }));
    const results = await Promise.all(writes);
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
    const fromA = (await ba.call('GET', '/api/state')).json;
    const fromC = (await bc.call('GET', '/api/state')).json;
    assert.equal(Object.keys(fromA.items.component).length, 12);
    assert.equal(Object.keys(fromC.items.component).length, 12);
    // the board polls cheaply: same workspace, same etag, 304
    const first = await ba.call('GET', '/api/state');
    const again = await ba.call('GET', '/api/state', undefined, { 'if-none-match': first.headers.get('etag') });
    assert.equal(again.status, 304);
  } finally { await a.close(); await c.close(); }
});

test('an agent waiting on one instance wakes when the human writes through another', async () => {
  const db = memoryDb();
  const a = await instance(db);
  const c = await instance(db);
  try {
    const human = browser(a.base);
    await signUp(human, 'iyke');
    const { key } = (await human.call('POST', '/auth/keys', { label: 'agent' })).json;
    const H = { authorization: `Bearer ${key}`, 'x-recon-agent': 'listener' };
    await fetch(`${c.base}/api/briefing`, { headers: H });
    const started = Date.now();
    const waiting = fetch(`${c.base}/api/wait?timeout=20`, { headers: H }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 800));
    // meanwhile the human can still use the board on the agent's instance
    assert.equal((await fetch(`${c.base}/api/state`, { headers: { authorization: `Bearer ${key}` } })).status, 200, 'not blocked by the waiting agent');
    await human.call('POST', '/api/items/steer', { action: 'note', to: ['ag_listener'], note: 'look at the oracle' });
    const woke = await waiting;
    assert.equal(woke.woke, true, JSON.stringify(woke));
    assert.equal(woke.events[0].note, 'look at the oracle');
    assert.ok(Date.now() - started < 10_000);
  } finally { await a.close(); await c.close(); }
});
