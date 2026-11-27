import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { watchSource } from '../src/dropin.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('drop-in json is merged item by item and re-merged on change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-drop-'));
  const file = path.join(dir, 'inbox.json');
  const s = new Store();
  const w = watchSource(s, file, { interval: 50 });
  await wait(80);
  assert.equal(s.list('target').length, 0, 'missing file is fine');
  fs.writeFileSync(file, JSON.stringify({
    agent: { name: 'filebot' },
    targets: [{ name: 'Bridge', protocolType: 'bridge', components: [{ name: 'receiveMessage()', reviewState: 'scanning' }] }],
  }));
  await wait(150);
  const c = s.list('component')[0];
  assert.equal(c.reviewState, 'scanning');
  assert.equal(c.createdBy, 'ag_filebot');
  assert.equal(s.get('agent', 'ag_filebot').transport, 'json');
  fs.writeFileSync(file, '{ not json');
  await wait(120);
  fs.writeFileSync(file, JSON.stringify({
    agent: { name: 'filebot' },
    targets: [{ name: 'Bridge', protocolType: 'bridge', components: [{ name: 'receiveMessage()', reviewState: 'flagged', evidence: [{ id: 'e1', ref: 'Bridge.sol:77' }] }] }],
    hypotheses: [{ text: 'source chain is not validated', bugClass: 'message-validation', confidence: 'high', component: 'receiveMessage()' }],
  }));
  await wait(150);
  fs.writeFileSync(file, JSON.stringify({
    agent: { name: 'filebot' },
    hypotheses: [{ text: 'source chain is not validated', bugClass: 'message-validation', confidence: 'med', component: 'receiveMessage()' }],
  }));
  await wait(150);
  w.close();
  assert.equal(s.list('hypothesis')[0].confidence, 'med', 'same hypothesis updated, not duplicated');
  assert.equal(s.list('component').length, 1);
  assert.equal(s.list('component')[0].reviewState, 'flagged');
  assert.equal(s.list('component')[0].evidence.length, 1);
  assert.equal(s.list('hypothesis').length, 1);
});
