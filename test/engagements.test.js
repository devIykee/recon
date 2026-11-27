import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engagements } from '../src/engagements.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recon-eng-'));

function open(d, seed = 'empty') {
  const s = new Store({ saveDelay: 0 });
  const e = new Engagements(d, s, { seed });
  e.init();
  return { s, e };
}

test('engagements survive a restart and starting another keeps the first', () => {
  const d = dir();
  let { s, e } = open(d);
  e.create({ name: 'Alpha audit' });
  s.create('target', { name: 'Alpha vault' }, 'human');
  const alpha = s.state.project.id;
  e.create({ name: 'Beta audit' });
  s.create('target', { name: 'Beta bridge' }, 'human');
  s.flush(); e.close();

  ({ s, e } = open(d));
  assert.equal(s.state.project.name, 'Beta audit', 'reopens where you left off');
  const names = e.list().engagements.map((x) => x.name);
  assert.ok(names.includes('Alpha audit') && names.includes('Beta audit'));
  e.open(alpha);
  assert.equal(s.list('target')[0].name, 'Alpha vault');
});

test('a legacy single state.json becomes an engagement, nothing lost', () => {
  const d = dir();
  const legacy = new Store({ file: path.join(d, 'state.json') });
  legacy.setProject({ name: 'Old board' }, 'human');
  legacy.create('target', { name: 'Old target' }, 'human');
  legacy.flush();
  const { s, e } = open(d);
  assert.equal(s.state.project.name, 'Old board');
  assert.equal(s.list('target')[0].name, 'Old target');
  assert.ok(fs.existsSync(path.join(d, 'state.json.migrated')));
  assert.equal(e.list().engagements.length, 1);
});

test('snapshots restore an engagement, and pruning keeps one per day', () => {
  const d = dir();
  const { s, e } = open(d);
  s.create('target', { name: 'Keep me' }, 'human');
  const snap = e.snapshot({ force: true });
  s.remove('target', s.list('target')[0].id, 'human');
  assert.equal(s.list('target').length, 0);
  e.restore(s.state.project.id, snap);
  assert.equal(s.list('target')[0].name, 'Keep me');

  const id = s.state.project.id;
  const sd = path.join(d, 'snapshots', id);
  const day = (n, h) => new Date(Date.UTC(2025, 0, n, h)).toISOString().replace(/[:.]/g, '-');
  for (const [n, h] of [[1, 9], [1, 18], [2, 3], [2, 4]]) fs.writeFileSync(path.join(sd, `${day(n, h)}.json`), '{}');
  e.prune(id, Date.now());
  const left = fs.readdirSync(sd).filter((f) => f.startsWith('2025-01'));
  assert.deepEqual(left.sort(), [`${day(1, 18)}.json`, `${day(2, 4)}.json`]);
});

test('removing an engagement moves it to trash instead of deleting it', () => {
  const d = dir();
  const { e } = open(d);
  const first = e.list().current;
  e.create({ name: 'Second' });
  const r = e.remove(first);
  assert.ok(fs.existsSync(r.trashedTo));
  assert.throws(() => e.remove(e.list().current), /open another/);
});
