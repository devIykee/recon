import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { seedExample } from '../src/seed.js';
import { DemoAgent } from '../src/demo.js';

test('demo agent works the example to completion without errors', () => {
  const s = new Store();
  seedExample(s);
  const errors = [];
  const d = new DemoAgent(s, { log: (m) => errors.push(m) });
  d.running = true;
  for (let i = 0; i < 120; i++) d.tick();
  assert.deepEqual(errors, []);
  const comps = Object.values(s.state.items.component);
  assert.ok(comps.every((c) => c.reviewState === 'reviewed' || c.reviewState === 'flagged'), 'all surface covered');
  assert.ok(Object.values(s.state.items.steer).every((x) => x.state === 'addressed'));
  assert.equal(Object.values(s.state.items.proposal).length, 1);
  const before = s.state.activity.length;
  for (let i = 0; i < 20; i++) d.tick();
  assert.ok(s.state.activity.length - before <= 1, 'goes quiet once done');
});
