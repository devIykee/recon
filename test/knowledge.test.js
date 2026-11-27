import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { seedExample } from '../src/seed.js';
import { playbook, checklistFor, suggest, briefing, PLAYBOOKS, CLASSES } from '../src/knowledge.js';
import { mustDo } from '../src/proactive.js';
import { ENUMS } from '../src/model.js';

test('every protocol type has a playbook whose classes exist', () => {
  for (const t of ENUMS.protocolType) {
    const pb = playbook(t);
    assert.ok(pb.classes.length >= 4, t);
    for (const c of PLAYBOOKS[t].classes) assert.ok(CLASSES[c], `${t} -> ${c}`);
  }
});

test('example seed is coherent', () => {
  const s = new Store();
  seedExample(s);
  const st = s.state;
  assert.equal(Object.keys(st.items.target).length, 1);
  const states = new Set(Object.values(st.items.component).map((c) => c.reviewState));
  for (const rs of ['untouched', 'scanning', 'reviewed', 'flagged']) assert.ok(states.has(rs), rs);
  assert.equal(Object.values(st.items.steer).filter((x) => x.state === 'open').length, 1);
  assert.equal(Object.keys(st.items.agent).length, 1);
});

test('checklist reflects component state', () => {
  const s = new Store();
  seedExample(s);
  const t = Object.values(s.state.items.target)[0];
  const dep = Object.values(s.state.items.component).find((c) => c.name.startsWith('LendingPool.deposit'));
  const cl = checklistFor(t, dep);
  const rounding = cl.find((g) => g.classId === 'rounding');
  assert.equal(rounding.items[0].state, 'checked');
});

test('suggestions point at dark areas and skip already-steered items', () => {
  const s = new Store();
  seedExample(s);
  const sug = suggest(s.state);
  assert.ok(sug.length > 0);
  const flash = Object.values(s.state.items.component).find((c) => c.name.startsWith('FlashLoan'));
  assert.ok(!sug.some((x) => x.itemId === flash.id && x.action === 'cover'), 'flash loan already has an open cover steer');
  assert.ok(sug.some((x) => x.rule === 'untouched'));
  assert.ok(sug.some((x) => x.rule === 'unverified-assumption'));
  s.setProject({ dismissed: [sug[0].id] }, 'human');
  assert.ok(!suggest(s.state).some((x) => x.id === sug[0].id));
});

test('briefing tells an agent what to do next', () => {
  const s = new Store();
  seedExample(s);
  const b = briefing(s.state, 'ag_scout');
  assert.equal(b.steers.length, 1);
  assert.match(b.next, /example/);
  assert.equal(b.example, true);
  assert.equal(b.yourComponents.length, 2);
});

test('briefing is steers, disputed claims, the next action and ids; no playbook, notes or rules', () => {
  const s = new Store();
  seedExample(s);
  const b = briefing(s.state, 'ag_scout');
  for (const k of ['rules', 'existing']) assert.equal(b[k], undefined, k);
  const t = b.targets[0];
  for (const k of ['playbook', 'map', 'scope', 'developerAssumptionPrompts']) assert.equal(t[k], undefined, k);
  assert.ok(b.untouched.every((x) => typeof x === 'string' && x.startsWith('cp_')));
  const text = JSON.stringify(b);
  for (const cls of Object.values(CLASSES)) for (const check of cls.checks) assert.ok(!text.includes(check), `check text leaked: ${check}`);
  assert.ok(text.length < 4000, `briefing is ${text.length} bytes`);
});

test('a flagged part that already has a finding is not sent back to make a hypothesis', () => {
  const s = new Store();
  const t = s.create('target', { name: 'Perps', protocolType: 'perps', phase: 'hunting' }, 'human');
  const a = s.touchAgent('bot', {}).id;
  const web = s.create('component', { targetId: t.id, name: 'Perps web app', reviewState: 'flagged' }, 'human');
  const flagged = () => suggest(s.state, { limit: 50 }).filter((x) => x.rule === 'flagged-no-hypothesis' && x.itemId === web.id);
  assert.equal(flagged().length, 1);
  s.create('finding', { title: 'XSS in the order form', targetId: t.id, componentId: web.id, severity: 'medium' }, 'human');
  assert.equal(flagged().length, 0);
  assert.ok(!mustDo(s.state, a).some((x) => x.kind === 'flag'), 'mustDo agrees');
  assert.ok(!/into a hypothesis/.test(briefing(s.state, a).next));
  // and an agent may flag a part on the strength of a finding alone
  const api = s.create('component', { targetId: t.id, name: 'Perps API' }, a);
  s.create('finding', { title: 'IDOR on /positions', targetId: t.id, componentId: api.id, severity: 'medium' }, 'human');
  s.patch('component', api.id, { reviewState: 'flagged' }, a);
  assert.equal(s.get('component', api.id).reviewState, 'flagged');
});

test('playbook gaps stop once a class is marked na, also on an external part or as a whole class', () => {
  const s = new Store();
  const t = s.create('target', { name: 'Perps', protocolType: 'perps', phase: 'hunting' }, 'human');
  s.create('component', { targetId: t.id, name: 'Router.openPosition()' }, 'human');
  const engine = s.create('component', { targetId: t.id, name: 'Liquidation engine (third party)', type: 'external' }, 'human');
  const gap = (cls) => suggest(s.state, { limit: 50 }).some((x) => x.rule === 'playbook-gap' && x.classId === cls);
  assert.ok(gap('liquidation'));
  s.patch('component', engine.id, { checklist: { liquidation: 'na' } }, 'human');
  assert.ok(!gap('liquidation'));
  assert.ok(gap('funding-rate'));
  s.patch('component', engine.id, { checklist: { 'funding-rate.0': 'na' } }, 'human');
  assert.ok(!gap('funding-rate'));
});

test('briefing walks a new target through map, assumptions, hunt', () => {
  const s = new Store();
  const t = s.create('target', { name: 'Vault', protocolType: 'vault' }, 'human');
  s.create('component', { targetId: t.id, name: 'Vault.deposit()' }, 'human');
  let b = briefing(s.state, 'ag_x');
  assert.match(b.next, /Phase 1, map "Vault"/);
  assert.ok(playbook('vault').commonAssumptions.length >= 3, 'the usual assumptions are on recon_playbook');
  assert.equal(suggest(s.state)[0].rule, 'phase-mapping');
  assert.ok(!suggest(s.state).some((x) => x.rule === 'untouched'), 'no hunting suggestions while mapping');
  s.patch('target', t.id, { phase: 'assumptions' }, 'human');
  b = briefing(s.state, 'ag_x');
  assert.match(b.next, /Phase 2.*recon_playbook/);
  s.patch('target', t.id, { phase: 'hunting' }, 'human');
  b = briefing(s.state, 'ag_x');
  assert.doesNotMatch(b.next, /Phase/);
  assert.ok(suggest(s.state).some((x) => x.rule === 'untouched'));
});

test('agents cannot skip the map or the developers\' assumptions; humans can', () => {
  const s = new Store();
  const t = s.create('target', { name: 'V', protocolType: 'vault' }, 'human');
  const a = s.touchAgent('bot', {});
  const c1 = s.create('component', { targetId: t.id, name: 'Vault.deposit()' }, a.id);
  assert.throws(() => s.patch('target', t.id, { phase: 'hunting' }, a.id), /finish the map/);
  const u = s.create('component', { targetId: t.id, name: 'User', type: 'actor' }, a.id);
  const loose = s.create('component', { targetId: t.id, name: 'Vault.withdraw()' }, a.id);
  s.create('relation', { targetId: t.id, from: u.id, to: c1.id, type: 'calls' }, a.id);
  assert.throws(() => s.patch('target', t.id, { phase: 'assumptions' }, a.id), /not connected to anything: Vault.withdraw/);
  s.create('relation', { targetId: t.id, from: u.id, to: loose.id, type: 'calls' }, a.id);
  assert.throws(() => s.patch('target', t.id, { phase: 'hunting' }, a.id), /developers assume/);
  s.patch('target', t.id, { phase: 'assumptions' }, a.id);
  s.create('assumption', { text: 'asset is a plain ERC20', targetId: t.id, origin: 'developer', category: 'input' }, a.id);
  s.patch('target', t.id, { phase: 'hunting' }, a.id);
  assert.equal(s.get('target', t.id).phase, 'hunting');
  const t2 = s.create('target', { name: 'W' }, 'human');
  s.patch('target', t2.id, { phase: 'hunting' }, 'human');
  assert.equal(s.get('target', t2.id).phase, 'hunting');
});
