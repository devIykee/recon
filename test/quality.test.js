import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { mustDo, pulse, beforeYouStop } from '../src/proactive.js';

function board() {
  const s = new Store();
  const a = s.touchAgent('hunter', { transport: 'mcp' }).id;
  const t = s.create('target', { name: 'Vault', protocolType: 'vault', phase: 'hunting' }, 'human');
  const c = s.create('component', { targetId: t.id, name: 'Vault.withdraw()' }, a);
  return { s, a, t, c };
}

const card = {
  attacker: 'stranger', reachability: 'permissionless', bound: 'only the vault balance', liveFunds: 'unknown',
  alreadyReported: 'no', verificationMethod: 'fork', testName: 'test_Drain',
};

test('a finding is refused until its confirmation card is complete', () => {
  const { s, a, t, c } = board();
  assert.throws(() => s.create('finding', { title: 'drain', severity: 'medium', targetId: t.id, componentId: c.id }, a), /confirmation card[\s\S]*attacker[\s\S]*reachability/);
  const f = s.create('finding', { title: 'drain', severity: 'medium', targetId: t.id, componentId: c.id, ...card }, a);
  assert.ok(f.id);
  const h = s.create('finding', { title: 'no card, by a human', targetId: t.id }, 'human');
  assert.ok(h.id, 'humans are never gated');
});

test('severity must be earned', () => {
  const { s, a, t, c } = board();
  assert.throws(() => s.create('finding', { title: 'admin can rug', severity: 'high', targetId: t.id, componentId: c.id, ...card, attacker: 'admin', reachability: 'needs-role' }, a), /High needs a path an outsider can take/);
  assert.throws(() => s.create('finding', { title: 'drain', severity: 'critical', targetId: t.id, componentId: c.id, ...card }, a), /Critical needs live funds/);
  const ok = s.create('finding', { title: 'drain', severity: 'critical', targetId: t.id, componentId: c.id, ...card, liveFunds: '0xabc 120 ETH', liveFundsMethod: 'eth_call' }, a);
  assert.equal(ok.severity, 'critical');
  assert.throws(() => s.patch('finding', ok.id, { reachability: 'needs-config' }, a), /Critical needs a permissionless path/);
});

test('duplicates and already-reported issues are refused with a way forward', () => {
  const { s, a, t, c } = board();
  s.create('finding', { title: 'reentrancy drain', bugClass: 'reentrancy', severity: 'medium', targetId: t.id, componentId: c.id, ...card }, a);
  assert.throws(() => s.create('finding', { title: 'reentrancy drain via hook', bugClass: 'Reentrancy', severity: 'medium', targetId: t.id, componentId: c.id, ...card }, a), /duplicate[\s\S]*recon_add_chain/);
  s.patch('target', t.id, { alreadyReported: [{ title: 'Vault withdraw rounding', date: '2024-08' }] }, 'human');
  assert.throws(() => s.create('finding', { title: 'rounding in withdraw', bugClass: 'rounding', severity: 'low', targetId: t.id, componentId: c.id, ...card }, a), /already-reported/);
  const distinct = s.create('finding', { title: 'rounding in withdraw', bugClass: 'rounding', severity: 'low', targetId: t.id, componentId: c.id, ...card, alreadyReportedRef: 'distinct: different rounding site' }, a);
  assert.ok(distinct.id);
});

test('a capability cannot become a finding until its trigger is found', () => {
  const { s, a, t, c } = board();
  const h = s.create('hypothesis', { text: 'factory can setOwner on the ENS root', targetId: t.id, componentId: c.id, exploitStage: 'capability' }, a);
  assert.throws(() => s.create('finding', { title: 'ENS takeover', severity: 'medium', targetId: t.id, componentId: c.id, hypothesisId: h.id, ...card }, a), /capability without a trigger/);
  assert.throws(() => s.patch('hypothesis', h.id, { status: 'confirmed' }, a), /code reference/);
  s.patch('hypothesis', h.id, { trigger: 'createAlbum() forwards calldata', exploitStage: 'full', evidence: [{ ref: 'Factory.sol:88', kind: 'code' }, { ref: 'test_Takeover', kind: 'fork' }] }, a);
  s.patch('hypothesis', h.id, { status: 'confirmed' }, a);
  assert.ok(s.create('finding', { title: 'ENS takeover', severity: 'medium', targetId: t.id, componentId: c.id, hypothesisId: h.id, ...card }, a).id);
});

test('flagging needs a hypothesis; reporting needs a passing test', () => {
  const { s, a, t, c } = board();
  assert.throws(() => s.patch('component', c.id, { reviewState: 'flagged' }, a), /needs a testable claim/);
  s.create('hypothesis', { text: 'reenters', targetId: t.id, componentId: c.id, exploitStage: 'trigger' }, a);
  s.patch('component', c.id, { reviewState: 'flagged' }, a);
  const f = s.create('finding', { title: 'drain', severity: 'medium', targetId: t.id, componentId: c.id, ...card }, a);
  assert.throws(() => s.patch('finding', f.id, { stage: 'reported' }, a), /code reference[\s\S]*passing/);
  s.patch('finding', f.id, { testResult: 'pass', evidence: [{ ref: 'Vault.sol:42', kind: 'code' }, { ref: 'test_Drain', kind: 'fork', block: '19000000' }] }, a);
  s.patch('finding', f.id, { stage: 'reported' }, a);
  assert.equal(s.get('finding', f.id).stage, 'reported');
});

test('open steers come first: gated writes, mustDo and pulse', () => {
  const { s, a, t, c } = board();
  const st = s.create('steer', { action: 'challenge', note: 'is the minter really inert?', to: [a] }, 'human');
  assert.throws(() => s.patch('component', c.id, { reviewState: 'scanning' }, a), /acknowledge your 1 open steer/);
  s.create('lead', { text: 'list every Safe NFT', value: 'high', state: 'blocked', blockedBy: 'no archive RPC', targetId: t.id }, a);
  const todo = mustDo(s.state, a);
  assert.equal(todo[0].kind, 'steer');
  assert.match(pulse(s.state, a), /is the minter really inert/);
  s.patch('steer', st.id, { state: 'acknowledged' }, a);
  s.patch('component', c.id, { reviewState: 'scanning' }, a);
  assert.match(pulse(s.state, a), /work this now: steer .*minter/, 'an acknowledged steer stays in front of the agent');
  assert.ok(mustDo(s.state, a).some((x) => x.kind === 'address'));
  assert.ok(beforeYouStop(s.state, a).some((x) => /record everything still worth doing as a lead/.test(x)));
  s.patch('steer', st.id, { state: 'addressed', response: 'inert: nothing calls mint' }, a);
  assert.equal(pulse(s.state, a), null, 'quiet once it reports back');
});

test('a steer cannot be acknowledged and then ignored', () => {
  const { s, a, t, c } = board();
  const other = s.create('component', { targetId: t.id, name: 'Other.fn()' }, 'human');
  const st = s.create('steer', { action: 'cover', itemId: c.id, itemKind: 'component', note: 'look here first', to: [a] }, 'human');
  s.patch('steer', st.id, { state: 'acknowledged' }, a);
  // a few unrelated writes are fine
  for (let i = 0; i < 5; i++) s.create('assumption', { text: `side note ${i}`, targetId: t.id }, a);
  // then other work is refused until the agent answers
  assert.throws(() => s.create('assumption', { text: 'one more', targetId: t.id }, a), /acknowledged steer .* have not reported back.*look here first/s);
  assert.throws(() => s.patch('component', other.id, { reviewState: 'scanning' }, a), /have not reported back/);
  // work on the steered item, messages and leads still go through
  s.patch('component', c.id, { reviewState: 'scanning' }, a);
  s.create('lead', { text: 'later: Other.fn()', targetId: t.id }, a);
  // progress on the steer reopens the window
  s.create('message', { text: 'half way: deposit path is fine', replyTo: st.id }, a);
  s.create('assumption', { text: 'allowed again', targetId: t.id }, a);
  // and time alone also counts
  const later = Date.now() + 11 * 60_000;
  assert.ok(mustDo(s.state, a, later).some((x) => x.kind === 'address' && /OVERDUE/.test(x.do)));
  s.patch('steer', st.id, { state: 'addressed', response: 'checked: fine' }, a);
  for (let i = 0; i < 8; i++) s.create('assumption', { text: `free ${i}`, targetId: t.id }, a);
});

test('a ready finding without a report decision asks the human how to report', () => {
  const { s, a, t, c } = board();
  s.create('finding', { title: 'drain', severity: 'medium', targetId: t.id, componentId: c.id, ...card }, a);
  assert.ok(mustDo(s.state, a).some((x) => x.kind === 'report' && /combined/.test(x.how)));
});

test('chains need two parts and attacker-controlled glue to raise severity', () => {
  const { s, a, t, c } = board();
  const h1 = s.create('hypothesis', { text: 'open allowlist', targetId: t.id, componentId: c.id, exploitStage: 'full' }, a);
  const h2 = s.create('hypothesis', { text: 'setAddr on unused label', targetId: t.id, componentId: c.id, exploitStage: 'full' }, a);
  assert.throws(() => s.create('chain', { title: 'x', parts: [h1.id], glue: 'config+code' }, a), /at least two/);
  assert.throws(() => s.create('chain', { title: 'impersonation', parts: [h1.id, h2.id], glue: 'config+code', severity: 'high' }, a), /glue an attacker controls/);
  assert.ok(s.create('chain', { title: 'impersonation', parts: [h1.id, h2.id], glue: 'config+code', severity: 'medium', result: 'phishing' }, a).id);
});
