import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { seedExample } from '../src/seed.js';
import { playbook, checklistFor, suggest, briefing, PLAYBOOKS, CLASSES } from '../src/knowledge.js';
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
  assert.match(b.next, /Acknowledge/);
  assert.ok(b.targets[0].playbook.classes.length);
  assert.equal(b.yourComponents.length, 2);
});
