// The example agent. Only runs on the example project, so a first-time visitor can
// watch a hunt in motion before connecting anything: it acknowledges steers,
// claims untouched surface, attaches evidence, ticks checklists and proposes its
// next move. It always finishes; it never invents unbounded work.

const SCOUT = 'Scout';

const NOTES = {
  'InterestRateModel': {
    state: 'reviewed',
    reasoning: 'Utilization-based kinked model. LendingPool calls accrueInterest() before reading borrow index in borrow, repay and liquidate.',
    evidence: [
      { ref: 'contracts/core/InterestRateModel.sol:22-48', note: 'kinked rate, no division by zero when utilization is 0' },
      { ref: 'contracts/core/LendingPool.sol:192', note: 'accrueInterest() first line of borrow()' },
    ],
    checks: ['interest-accounting.0', 'interest-accounting.1', 'rounding.1'],
  },
  'FlashLoan.flashLoan()': {
    state: 'flagged',
    reasoning: 'flashLoan() does not take the nonReentrant lock that liquidate() uses. A borrower could call liquidate() from inside the flash-loan callback while pool balances are temporarily inflated.',
    evidence: [
      { ref: 'contracts/core/FlashLoan.sol:30-61', note: 'no nonReentrant modifier; callback before balance check' },
      { ref: 'contracts/core/LendingPool.sol:240', note: 'liquidate() is nonReentrant on its own lock only' },
    ],
    checks: ['reentrancy.0', 'reentrancy.1', 'flash-loan.0'],
    hypothesis: {
      text: 'Calling liquidate() from inside a flash-loan callback reads inflated pool balances and over-pays the liquidator.',
      bugClass: 'reentrancy',
      confidence: 'med',
    },
  },
  'Governor.setRiskParams()': {
    state: 'reviewed',
    reasoning: 'Only callable by the timelock. Liquidation bonus is capped at 15%.',
    evidence: [{ ref: 'contracts/gov/Governor.sol:77-90', note: 'onlyTimelock; require(bonus <= 1500)' }],
    checks: ['access-control.0', 'access-control.1'],
  },
  'LendingPool.borrow()': {
    state: 'reviewed',
    reasoning: 'Interest accrues before the health check; price and decimals match those used in liquidation.',
    evidence: [{ ref: 'contracts/core/LendingPool.sol:190-231', note: 'accrue -> update debt -> _requireHealthy' }],
    checks: ['interest-accounting.0', 'liquidation.0', 'oracle-manipulation.0'],
  },
  'LendingPool.liquidate()': {
    state: 'flagged',
    reasoning: 'Bonus is not capped by the collateral that remains. Small positions may pay out more than they hold.',
    evidence: [{ ref: 'contracts/core/LendingPool.sol:262-275', note: 'seized = repay * price * (1 + bonus); no min() against collateral' }],
    checks: ['liquidation.0', 'liquidation.3'],
  },
};

const DEFAULT_NOTE = (c) => ({
  state: 'reviewed',
  reasoning: `Read ${c.name} end to end. Inputs are validated and state is updated before external calls.`,
  evidence: [{ ref: c.location || c.name, note: 'read in full' }],
  checks: ['access-control.0', 'reentrancy.0'],
});

export class DemoAgent {
  constructor(store, { log = () => {}, interval = 3400 } = {}) {
    this.store = store;
    this.log = log;
    this.interval = interval;
    this.running = false;
    this.queue = [];
    this.timer = null;
    this.proposed = false;
    this.raised = false;
  }

  get id() { return this.store.touchAgent(SCOUT, { transport: 'demo' }).id; }

  start() {
    if (this.running) return;
    this.running = true;
    this.queue = [];
    this.proposed = false;
    this.raised = false;
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
  }

  tick() {
    if (!this.store.state.project.example) { this.stop(); return; }
    try {
      const id = this.id;
      if (!this.queue.length) this.plan(id);
      const step = this.queue.shift();
      if (step) step();
    } catch (err) {
      this.log(`demo agent: ${err.message}`);
      this.queue = [];
    }
  }

  plan(id) {
    const s = this.store;
    const items = s.state.items;
    const steers = Object.values(items.steer).filter((x) => x.state !== 'addressed' && ((x.to || []).includes(id) || (x.to || []).includes('all')));

    const open = steers.find((x) => x.state === 'open');
    if (open) {
      this.queue.push(() => s.patch('steer', open.id, { state: 'acknowledged', response: 'Seen. Picking it up next.' }, id));
      return;
    }

    const acked = steers.find((x) => x.state === 'acknowledged');
    if (acked) {
      const item = acked.itemId ? s.find(acked.itemId) : null;
      if (item?.kind === 'component' && item.reviewState !== 'reviewed' && item.reviewState !== 'flagged') {
        this.workComponent(id, item);
      } else if (item && item.kind !== 'component' && item.kind !== 'target') {
        this.queue.push(() => s.patch('agent', id, { focus: `Re-checking: ${label(item)}`, focusItem: '' }, id));
        this.queue.push(() => s.addEvidence(item.kind, item.id, { ref: 'manual re-read', note: `Re-checked after steer "${acked.action}". Reasoning holds; added a step-by-step trace.` }, id));
      }
      this.queue.push(() => {
        const fresh = s.get('steer', acked.id);
        if (fresh && fresh.state !== 'addressed') {
          s.patch('steer', acked.id, { state: 'addressed', response: responseFor(acked, item && s.find(item.id)) }, id);
        }
      });
      return;
    }

    const mine = Object.values(items.component).find((c) => c.owner === id && c.reviewState === 'scanning');
    if (mine) { this.finishComponent(id, mine); return; }

    const next = Object.values(items.component)
      .filter((c) => c.reviewState === 'untouched' && (!c.owner || c.owner === id))
      .sort((a, b) => rank(b.priority) - rank(a.priority))[0];
    if (next) { this.workComponent(id, next); return; }

    const hyp = Object.values(items.hypothesis).find((h) => h.createdBy === id && h.status === 'testing' && h.confidence === 'med' && h.bugClass === 'liquidation');
    if (hyp && !this.raised) {
      this.raised = true;
      this.queue.push(() => s.patch('agent', id, { focus: 'Building a proof of concept for the liquidation bonus', focusItem: hyp.componentId || '' }, id));
      this.queue.push(() => s.patch('hypothesis', hyp.id, {
        confidence: 'high',
        evidence: [{ ref: 'test/LiquidationDust.t.sol', kind: 'test', note: 'PoC: position with 10 wei collateral liquidated, pool loses 3 wei per call' }],
      }, id));
      return;
    }

    if (!this.proposed) {
      this.proposed = true;
      const irm = Object.values(items.component).find((c) => c.name === 'InterestRateModel');
      this.queue.push(() => s.create('proposal', {
        text: 'Fuzz borrow/repay/liquidate sequences against the interest index to look for accrual drift.',
        rationale: 'Accrual order looks right on read, but the index math has three rounding sites. A stateful fuzz would settle it in minutes.',
        steerKind: 'recheck',
        itemId: irm?.id || '',
        itemKind: irm ? 'component' : '',
      }, id));
      return;
    }

    const agent = s.get('agent', id);
    if (agent && agent.focus !== 'Surface covered. Waiting for steers or a yes on my proposal.') {
      this.queue.push(() => s.patch('agent', id, { focus: 'Surface covered. Waiting for steers or a yes on my proposal.', focusItem: '' }, id));
    }
  }

  workComponent(id, c) {
    const s = this.store;
    this.queue.push(() => {
      if (!c.owner) s.claim([c.id], id);
      s.patch('agent', id, { focus: `Reading ${c.name}`, focusItem: c.id }, id);
    });
    this.finishComponent(id, c);
  }

  finishComponent(id, c) {
    const s = this.store;
    const n = NOTES[c.name] || DEFAULT_NOTE(c);
    this.queue.push(() => s.addEvidence('component', c.id, n.evidence[0], id));
    this.queue.push(() => s.patch('component', c.id, { checklist: Object.fromEntries(n.checks.map((k) => [k, 'checked'])) }, id));
    if (n.evidence[1]) this.queue.push(() => s.addEvidence('component', c.id, n.evidence[1], id));
    this.queue.push(() => s.patch('component', c.id, { reviewState: n.state, reasoning: n.reasoning }, id));
    if (n.hypothesis) {
      this.queue.push(() => {
        const exists = Object.values(s.state.items.hypothesis).some((h) => h.componentId === c.id);
        if (!exists) s.create('hypothesis', { ...n.hypothesis, targetId: c.targetId, componentId: c.id, evidence: n.evidence }, id);
      });
    }
  }
}

function label(item) {
  return item.name || item.text || item.title || item.id;
}

function rank(p) {
  return { low: 0, normal: 1, high: 2, urgent: 3 }[p || 'normal'];
}

function responseFor(steer, item) {
  if (!item) return 'Done.';
  if (item.kind === 'component') {
    return item.reviewState === 'flagged'
      ? `Covered ${item.name}. Flagged it: ${item.reasoning || 'see evidence'}`
      : `Covered ${item.name}. Nothing exploitable; evidence attached.`;
  }
  if (steer.action === 'challenge') return 'Challenged it by tracing every caller. It holds; trace attached as evidence.';
  if (steer.action === 'verify') return 'Added a stronger reproduction; see the new evidence.';
  return `Re-checked "${label(item)}". Evidence updated.`;
}
