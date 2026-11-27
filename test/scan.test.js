import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSolidity } from '../src/scan.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');
const has = (map, from, type, to, label) => map.relations.some((r) => r.from === from && r.type === type && r.to === to && (!label || r.label.includes(label)));

test('scan maps who calls what from Solidity source', () => {
  const map = scanSolidity(dir);
  assert.deepEqual(map.files.sort(), ['FeeController.sol', 'IERC20.sol', 'Vault.sol']);
  assert.ok(has(map, 'Anyone', 'calls', 'FeeController', 'setWithdrawFee()'), 'unrestricted setter is visible');
  assert.ok(has(map, 'Owner', 'owns', 'FeeController', 'setKeeper()'));
  assert.ok(!has(map, 'Anyone', 'calls', 'FeeController', 'setKeeper()'), 'owner-only functions are not open to anyone');
  assert.ok(has(map, 'Vault', 'transfers', 'IERC20', 'transferFrom()'));
  assert.ok(has(map, 'Vault', 'reads', 'IERC20', 'balanceOf()'));
  assert.ok(has(map, 'Vault', 'calls', 'FeeController', 'withdrawFeeBps()'));
  assert.ok(has(map, 'Vault', 'calls', 'Caller (msg.sender)', 'withdraw()'), 'low-level callback to the caller');
  assert.ok(has(map, 'Keeper', 'calls', 'Vault', 'harvest()'), 'require(msg.sender == keeper) becomes a role');
  assert.ok(has(map, 'Vault', 'calls', 'Any address', 'harvest()'), 'arbitrary call target');
  assert.equal(map.components.find((c) => c.name === 'IERC20').type, 'external');
});
