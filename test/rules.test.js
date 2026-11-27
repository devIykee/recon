import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { scanSolidity } from '../src/scan.js';
import { ruleExposure, suggestRules } from '../src/rules.js';
import { mustDo } from '../src/proactive.js';
import { createHub } from '../src/hub.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

test('the scanner records who can call each function and the state it writes', () => {
  const map = scanSolidity(FIX);
  const vault = map.components.find((c) => c.name === 'Vault');
  const fee = map.components.find((c) => c.name === 'FeeController');
  const fn = (c, n) => c.surface.find((f) => f.fn === `${n}()`);
  assert.deepEqual(fn(vault, 'deposit').writes.sort(), ['sharesOf', 'totalShares']);
  assert.equal(fn(vault, 'deposit').access, 'anyone');
  assert.equal(fn(vault, 'totalAssets').access, 'view');
  assert.equal(fn(vault, 'harvest').access, 'role:Keeper');
  assert.equal(fn(fee, 'setWithdrawFee').access, 'anyone');
  assert.deepEqual(fn(fee, 'setWithdrawFee').writes, ['withdrawFeeBps']);
  assert.equal(fn(fee, 'setTreasury').access, 'role:Owner');
  assert.ok(!vault.surface.some((f) => f.writes.includes('address')), 'mapping(address => ...) is not a variable called address');
});

function board() {
  const s = new Store();
  const t = s.create('target', { name: 'Vault', protocolType: 'vault', phase: 'hunting' }, 'human');
  const map = scanSolidity(FIX);
  for (const c of map.components) s.create('component', { targetId: t.id, name: c.name, type: c.type, summary: c.summary, surface: c.surface || [] }, 'human');
  return { s, t, a: s.touchAgent('hunter', {}).id };
}

test('a rule shows every function that can change its state, and who can reach it', () => {
  const { s, t } = board();
  const fee = s.create('rule', { text: 'Fees never go above 5%', targetId: t.id, state: ['fee'], category: 'bound' }, 'human');
  const x = ruleExposure(s.state, fee);
  assert.equal(x.level, 'open');
  assert.deepEqual(x.writers.map((w) => `${w.component}.${w.fn}:${w.access}`), ['FeeController.setWithdrawFee():anyone']);
  assert.ok(x.readers.some((r) => r.fn === 'withdraw()'), 'withdraw relies on the fee (it reads the fees contract)');
  const treasury = s.create('rule', { text: 'Only the owner moves the treasury', targetId: t.id, state: ['treasury'], category: 'access' }, 'human');
  assert.equal(ruleExposure(s.state, treasury).level, 'guarded');
  const shares = s.create('rule', { text: 'Nobody withdraws more than they deposited', targetId: t.id, state: ['sharesOf', 'totalShares'] }, 'human');
  const sx = ruleExposure(s.state, shares);
  assert.deepEqual(sx.writers.map((w) => w.fn).sort(), ['deposit()', 'withdraw()']);
  assert.equal(ruleExposure(s.state, s.create('rule', { text: 'something', targetId: t.id }, 'human')).level, 'unscoped');
});

test('starter rules come from the playbook with the scanned state filled in', () => {
  const { s, t } = board();
  const sug = suggestRules(s.state, t, ['vault']);
  const fee = sug.find((x) => /fee/i.test(x.text));
  assert.ok(fee.state.includes('withdrawFeeBps'));
  assert.ok(sug.find((x) => /total shares/i.test(x.text)).state.includes('totalShares'));
  s.create('rule', { text: fee.text, targetId: t.id, state: fee.state }, 'human');
  assert.ok(!suggestRules(s.state, t, ['vault']).some((x) => x.text === fee.text), 'not suggested twice');
});

test('"holds" says how hard an engine tried; "broken" becomes a suspected bug with its call sequence', () => {
  const { s, t, a } = board();
  const r = s.create('rule', { text: 'Fees never go above 5%', targetId: t.id, state: ['withdrawFeeBps'], category: 'bound' }, a);
  assert.throws(() => s.patch('rule', r.id, { status: 'holds' }, a), /how hard/);
  assert.throws(() => s.patch('rule', r.id, { status: 'holds', engine: 'manual', runs: 'read it' }, a), /inconclusive/);
  assert.throws(() => s.patch('rule', r.id, { status: 'broken', engine: 'foundry-invariant' }, a), /counterexample/);
  const out = s.patch('rule', r.id, { status: 'broken', engine: 'foundry-invariant', runs: '12k calls, depth 50', counterexample: 'setWithdrawFee(10001) from 0xBEEF; withdraw(1e18) reverts on underflow' }, a);
  const h = s.get('hypothesis', out.hypothesisId);
  assert.ok(h, 'filed as a suspected bug');
  assert.equal(h.exploitStage, 'trigger');
  assert.match(h.trigger, /setWithdrawFee\(10001\)/);
  assert.equal(s.get('component', h.componentId).name, 'FeeController', 'on the part that writes the state');
  const ok = s.create('rule', { text: 'Total shares equal the sum of shares', targetId: t.id, state: ['totalShares'] }, a);
  s.patch('rule', ok.id, { status: 'holds', engine: 'echidna', runs: '50k calls, depth 100' }, a);
  assert.equal(s.get('rule', ok.id).status, 'holds');
});

test('agents are asked to write rules, then to break the most exposed ones first', () => {
  const { s, t, a } = board();
  assert.ok(mustDo(s.state, a).some((x) => x.kind === 'rules'));
  s.create('rule', { text: 'Only the owner moves the treasury', targetId: t.id, state: ['treasury'] }, 'human');
  s.create('rule', { text: 'Fees never go above 5%', targetId: t.id, state: ['withdrawFeeBps'] }, 'human');
  const todo = mustDo(s.state, a).filter((x) => x.kind === 'rule');
  assert.match(todo[0].do, /Fees never go above 5%.*anyone can change/);
});

test('GET /api/rules gives exposure and starter rules', async () => {
  const hub = createHub({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'recon-rules-')), seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const s = hub.tenant().store;
  const t = s.create('target', { name: 'Vault', protocolType: 'vault', phase: 'hunting' }, 'human');
  for (const c of scanSolidity(FIX).components) s.create('component', { targetId: t.id, name: c.name, type: c.type, surface: c.surface || [] }, 'human');
  s.create('rule', { text: 'Fees never go above 5%', targetId: t.id, state: ['withdrawFeeBps'] }, 'human');
  const r = await (await fetch(`http://127.0.0.1:${hub.port}/api/rules`)).json();
  assert.equal(r.rules[0].exposure.level, 'open');
  assert.ok(r.suggested.length >= 3);
  assert.ok(r.engines['foundry-invariant']);
  await hub.close();
});
