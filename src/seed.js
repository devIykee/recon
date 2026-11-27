// The example project shipped on first run. Generic names, no real targets or
// disclosures. It shows every part of the harness at once: mixed coverage, an
// assumption, a hypothesis, a finding, a connected example agent and one open steer.

import { emptyState } from './store.js';

export function seedExample(store) {
  store.state = emptyState('Example engagement');
  store.state.project.example = true;
  const human = 'human';
  const scout = store.touchAgent('Scout', { transport: 'demo' });
  store.patch('agent', scout.id, { focus: 'Reading the liquidation path', model: 'example agent' }, scout.id);

  const t = store.create('target', {
    name: 'Example Lending Market',
    chain: 'testnet',
    protocolType: 'lending',
    description: 'A fictional over-collateralized lending market used to show how recon works. Users deposit collateral, borrow against it, and get liquidated when they fall below a health factor of 1.',
    scope: 'contracts/core/*, contracts/oracle/*',
  }, human);

  const comp = (name, type, reviewState, location, extra = {}) => store.create('component', {
    targetId: t.id, name, type, reviewState, location, ...extra,
  }, scout.id);

  const deposit = comp('LendingPool.deposit()', 'function', 'reviewed', 'contracts/core/LendingPool.sol:88', {
    reasoning: 'Shares are minted after the transfer-in is measured with balance before/after, so fee-on-transfer tokens are handled. Rounding is down on minted shares.',
    evidence: [
      { ref: 'contracts/core/LendingPool.sol:88-121', note: 'balanceBefore/balanceAfter pattern around safeTransferFrom' },
      { ref: 'contracts/core/LendingPool.sol:117', note: 'mulDivDown when minting shares' },
    ],
    checklist: { 'rounding.0': 'checked', 'weird-tokens.0': 'checked', 'reentrancy.0': 'checked' },
  });
  const withdraw = comp('LendingPool.withdraw()', 'function', 'flagged', 'contracts/core/LendingPool.sol:140', {
    reasoning: 'Asset amount for burned shares uses mulDivUp. Rounding up on assets paid out favors the user.',
    evidence: [{ ref: 'contracts/core/LendingPool.sol:152', note: 'assets = shares.mulDivUp(totalAssets, totalSupply)' }],
    checklist: { 'rounding.0': 'checked' },
  });
  const borrow = comp('LendingPool.borrow()', 'function', 'scanning', 'contracts/core/LendingPool.sol:190', {
    reasoning: 'Following the health-factor check. Interest appears to accrue first; verifying the order.',
  });
  const liquidate = comp('LendingPool.liquidate()', 'function', 'scanning', 'contracts/core/LendingPool.sol:240', {
    evidence: [{ ref: 'contracts/core/LendingPool.sol:268', note: 'bonus = seized * LIQ_BONUS / 1e4, no cap against remaining collateral' }],
  });
  comp('PriceOracle.getPrice()', 'function', 'reviewed', 'contracts/oracle/PriceOracle.sol:40', {
    reasoning: 'Reads a push-based feed. Checks answer > 0 and updatedAt within heartbeat.',
    evidence: [{ ref: 'contracts/oracle/PriceOracle.sol:52-58', note: 'staleness and sign checks present' }],
    checklist: { 'stale-price.0': 'checked', 'stale-price.1': 'checked', 'stale-price.2': 'na' },
  });
  comp('InterestRateModel', 'contract', 'untouched', 'contracts/core/InterestRateModel.sol');
  const flash = comp('FlashLoan.flashLoan()', 'function', 'untouched', 'contracts/core/FlashLoan.sol:30');
  comp('Governor.setRiskParams()', 'function', 'untouched', 'contracts/gov/Governor.sol:77');
  comp('ShareToken.transfer()', 'function', 'reviewed', 'contracts/core/ShareToken.sol:61', {
    reasoning: 'Standard ERC20 transfer; health factor of sender is checked after moving collateral shares.',
    evidence: [{ ref: 'contracts/core/ShareToken.sol:70', note: '_requireHealthy(from) after _transfer' }],
  });

  store.claim([borrow.id, liquidate.id], scout.id);

  store.create('assumption', {
    text: 'Prices only come from the push-based feed, never from pool reserves.',
    targetId: t.id,
    scope: 'PriceOracle and every caller of getPrice()',
    rationale: 'getPrice() reads only the feed address set at deployment, and no other price path was found in LendingPool.',
    evidence: [{ ref: 'contracts/oracle/PriceOracle.sol:40-60', note: 'single source; no fallback path' }],
  }, scout.id);

  const hyp = store.create('hypothesis', {
    text: 'Liquidating a dust position pays a bonus larger than the remaining collateral, leaving bad debt.',
    targetId: t.id,
    componentId: liquidate.id,
    bugClass: 'liquidation',
    confidence: 'med',
    reasoning: 'The bonus is computed from the repaid amount and is not capped by the collateral left in the position.',
    evidence: [{ ref: 'contracts/core/LendingPool.sol:268', note: 'no min(bonus, collateralLeft)' }],
  }, scout.id);
  void hyp;

  store.create('finding', {
    title: 'withdraw() rounds assets up, letting repeated small withdrawals drain dust',
    targetId: t.id,
    componentId: withdraw.id,
    chain: 'testnet',
    severity: 'medium',
    bugClass: 'rounding',
    stage: 'testing',
    notes: 'Each withdraw of 1 share pays ceil(totalAssets / totalSupply). Over many calls the pool pays out more than it holds per share.',
    evidence: [{ ref: 'contracts/core/LendingPool.sol:152', note: 'mulDivUp on payout' }],
  }, scout.id);

  store.create('steer', {
    action: 'cover',
    itemId: flash.id,
    itemKind: 'component',
    to: [scout.id],
    note: 'Can flashLoan() be called while a liquidation is mid-flight? Worth a look.',
  }, human);

  store.patch('target', t.id, { focus: liquidate.id }, scout.id);
  store.patch('agent', scout.id, { focusItem: liquidate.id }, scout.id);
  void deposit;
  store.log({ by: 'human', action: 'note', kind: 'project', summary: 'opened the example engagement' });
  store.emit('reset', store.state);
  store.save();
  return store.state;
}

export function seedEmpty(store, name = 'New engagement') {
  store.state = emptyState(name);
  store.emit('reset', store.state);
  store.save();
  return store.state;
}
