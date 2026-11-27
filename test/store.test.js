import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recon-test-'));

function seeded() {
  const s = new Store();
  const agent = s.touchAgent('scout', { transport: 'mcp' });
  const t = s.create('target', { name: 'Vault', protocolType: 'vault' }, 'human');
  const c = s.create('component', { targetId: t.id, name: 'withdraw()' }, agent.id);
  return { s, agent, t, c };
}

test('creates items with defaults and attribution', () => {
  const { c, agent } = seeded();
  assert.equal(c.reviewState, 'untouched');
  assert.equal(c.verification, 'unverified');
  assert.equal(c.createdBy, agent.id);
  assert.deepEqual(c.evidence, []);
});

test('rejects bad enums, unknown fields and missing refs', () => {
  const { s, t } = seeded();
  assert.throws(() => s.create('component', { targetId: t.id, name: 'x', reviewState: 'done' }, 'human'), /must be one of/);
  assert.throws(() => s.create('component', { targetId: t.id, name: 'x', colour: 'red' }, 'human'), /unknown field/);
  assert.throws(() => s.create('component', { targetId: 'tg_nope', name: 'x' }, 'human'), /does not exist/);
  assert.throws(() => s.create('finding', { severity: 'high' }, 'human'), /"title" is required/);
});

test('agents cannot write human-owned fields', () => {
  const { s, c, agent } = seeded();
  assert.throws(() => s.patch('component', c.id, { verification: 'verified' }, agent.id), /human-owned/);
  assert.throws(() => s.patch('component', c.id, { priority: 'high' }, agent.id), /human-owned/);
  s.patch('component', c.id, { verification: 'verified', priority: 'high' }, 'human');
  assert.equal(s.get('component', c.id).verification, 'verified');
});

test('per-field writes do not clobber each other', () => {
  const { s, c, agent } = seeded();
  s.patch('component', c.id, { reviewState: 'scanning' }, agent.id);
  s.patch('component', c.id, { priority: 'urgent' }, 'human');
  s.patch('component', c.id, { reviewState: 'reviewed' }, agent.id);
  const item = s.get('component', c.id);
  assert.equal(item.reviewState, 'reviewed');
  assert.equal(item.priority, 'urgent');
  assert.equal(item._f.priority.by, 'human');
  assert.equal(item._f.reviewState.by, agent.id);
});

test('stale external writes lose to newer field clocks', () => {
  const { s, c, agent } = seeded();
  s.patch('component', c.id, { notes: 'fresh' }, agent.id);
  const old = s.get('component', c.id)._f.notes.at - 1000;
  s.patch('component', c.id, { notes: 'stale' }, agent.id, { at: old });
  assert.equal(s.get('component', c.id).notes, 'fresh');
});

test('evidence merges by id and checklist merges by key', () => {
  const { s, c, agent } = seeded();
  s.addEvidence('component', c.id, { ref: 'Vault.sol:120', note: 'checks-effects-interactions ok' }, agent.id);
  s.addEvidence('component', c.id, { ref: 'Vault.sol:144' }, 'human');
  assert.equal(s.get('component', c.id).evidence.length, 2);
  assert.equal(s.get('component', c.id).evidence[0].kind, 'code');
  s.patch('component', c.id, { checklist: { 'reentrancy.0': 'checked' } }, agent.id);
  s.patch('component', c.id, { checklist: { 'rounding.0': 'na' } }, 'human');
  const cl = s.get('component', c.id).checklist;
  assert.equal(cl['reentrancy.0'].state, 'checked');
  assert.equal(cl['rounding.0'].state, 'na');
});

test('component ownership blocks other agents but allows evidence', () => {
  const { s, c, agent } = seeded();
  const other = s.touchAgent('hound', { transport: 'cli' });
  s.claim([c.id], agent.id);
  assert.throws(() => s.patch('component', c.id, { reviewState: 'flagged' }, other.id), /owned by/);
  s.addEvidence('component', c.id, { ref: 'note from hound' }, other.id);
  s.patch('component', c.id, { reviewState: 'flagged' }, 'human');
  assert.equal(s.get('component', c.id).reviewState, 'flagged');
  assert.deepEqual(s.claim([c.id], other.id).refused[0].reason, `owned by ${agent.id}`);
});

test('disputing an agent claim opens a steer to that agent', () => {
  const { s, agent, t } = seeded();
  const h = s.create('hypothesis', { text: 'share price can be inflated', targetId: t.id }, agent.id);
  s.patch('hypothesis', h.id, { verification: 'disputed' }, 'human');
  const steers = s.list('steer');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].action, 'recheck');
  assert.deepEqual(steers[0].to, [agent.id]);
  assert.equal(steers[0].itemId, h.id);
});

test('steer round trip stamps ack and address times', () => {
  const { s, agent } = seeded();
  const st = s.create('steer', { action: 'cover', note: 'look at fees', to: [agent.id] }, 'human');
  s.patch('steer', st.id, { state: 'acknowledged' }, agent.id);
  assert.ok(s.get('steer', st.id).ackAt);
  s.patch('steer', st.id, { state: 'addressed', response: 'fees are fine' }, agent.id);
  const done = s.get('steer', st.id);
  assert.equal(done.addressedBy, agent.id);
  const actions = s.state.activity.map((a) => a.action);
  assert.ok(actions.includes('acknowledged') && actions.includes('addressed'));
});

test('merge accepts flat docs with nested components and is idempotent', () => {
  const s = new Store();
  const doc = {
    targets: [{ name: 'Pool', protocolType: 'amm', components: [{ name: 'swap()' }, { name: 'addLiquidity()' }] }],
    hypotheses: [{ text: 'rounding favors trader', bugClass: 'rounding' }],
  };
  const r1 = s.merge(doc, 'ag_file');
  assert.equal(r1.errors.length, 0);
  assert.equal(s.list('component').length, 2);
  s.merge(doc, 'ag_file');
  assert.equal(s.list('component').length, 2);
  assert.equal(s.list('target').length, 1);
});

test('persists atomically and round-trips, with optional encryption', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  const a = new Store({ file, encryptionKey: 'correct horse' });
  a.create('target', { name: 'Bridge', protocolType: 'bridge' }, 'human');
  a.flush();
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('aes-256-gcm'));
  assert.ok(!raw.includes('Bridge'));
  const b = new Store({ file, encryptionKey: 'correct horse' });
  b.load();
  assert.equal(b.list('target')[0].name, 'Bridge');
  const c = new Store({ file });
  assert.throws(() => c.load(), /encrypted/);
});

test('repeated no-op writes flag an agent as looping', async () => {
  const { agentHealth } = await import('../src/health.js');
  const { s, c, agent } = seeded();
  for (let i = 0; i < 7; i++) s.patch('component', c.id, { notes: 'same' }, agent.id);
  assert.ok(agentHealth(s.state, s.get('agent', agent.id)).flags.includes('looping'));
});

test('relations are unique per edge and go away with their components', () => {
  const { s, t, c, agent } = seeded();
  const user = s.create('component', { targetId: t.id, name: 'User', type: 'actor' }, agent.id);
  const r1 = s.create('relation', { targetId: t.id, from: user.id, to: c.id, type: 'calls' }, agent.id);
  const r2 = s.create('relation', { targetId: t.id, from: user.id, to: c.id, type: 'calls', label: 'withdraw' }, agent.id);
  assert.equal(r1.id, r2.id);
  assert.equal(s.list('relation').length, 1);
  assert.equal(s.list('relation')[0].label, 'withdraw');
  assert.match(s.state.activity.find((a) => a.action === 'mapped').summary, /User calls withdraw\(\)/);
  assert.throws(() => s.create('relation', { targetId: t.id, from: user.id, to: 'cp_nope' }, agent.id), /does not exist/);
  s.remove('component', user.id, 'human');
  assert.equal(s.list('relation').length, 0);
});
