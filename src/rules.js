// Rules: what a protocol must never break, written in plain words and tied to the
// state they are about. Two things make them useful on the map:
//
//  - exposure: from the scanner's surface (each function, who may call it, what
//    state it writes), every function that can change a rule's state, and
//    whether a stranger, a role, or nobody can reach it. That is where to aim
//    before any engine runs.
//  - results: an engine (Foundry invariant tests, Halmos, Echidna, Medusa,
//    Certora...) tries to break the rule; "holds" says how hard it tried,
//    "broken" carries the call sequence that breaks it, which becomes a
//    suspected bug on the board.

// Starter rules per protocol type. `hint` finds the state variables a rule is
// about among the ones the scanner saw.
export const RULE_TEMPLATES = {
  vault: [
    ['conservation', 'Nobody can withdraw more than they deposited plus their share of the gains', /share|balance|deposit|asset/i],
    ['accounting', 'Total shares always equal the sum of every holder\'s shares', /totalShares|shares|supply/i],
    ['solvency', 'The vault\'s assets always cover what every holder can redeem', /totalAssets|asset|shares|debt/i],
    ['bound', 'Fees never go above their documented cap', /fee/i],
    ['access', 'Only the owner can change fees, the treasury and the keeper', /fee|treasury|keeper|owner|admin/i],
  ],
  lending: [
    ['solvency', 'Every position stays over-collateralised after any action except liquidation', /debt|borrow|collateral/i],
    ['accounting', 'Total borrows never exceed total supplied', /borrow|supply|reserve/i],
    ['ordering', 'Only an unhealthy position can be liquidated', /health|liquidat|collateral/i],
    ['bound', 'The interest index never goes down', /index|rate|interest/i],
  ],
  amm: [
    ['conservation', 'Reserves times each other never decrease on a swap (k only grows)', /reserve|balance/i],
    ['accounting', 'LP supply always matches the reserves it claims', /supply|reserve|liquidity/i],
    ['bound', 'A swap never pays out less than the caller\'s minimum', /amountOut|min/i],
  ],
  token: [
    ['accounting', 'Total supply always equals the sum of all balances', /totalSupply|balance/i],
    ['conservation', 'A transfer never creates or destroys tokens', /balance/i],
    ['access', 'Only the minter can mint', /minter|owner|role/i],
  ],
  staking: [
    ['conservation', 'Rewards paid never exceed rewards funded', /reward/i],
    ['conservation', 'Nobody unstakes more than they staked', /stake|balance/i],
  ],
  bridge: [
    ['conservation', 'Tokens minted on one side never exceed tokens locked on the other', /lock|mint|supply|deposit/i],
    ['ordering', 'Each message is processed exactly once', /nonce|processed|executed|message/i],
  ],
  governance: [
    ['ordering', 'A proposal executes only after it passed quorum and the timelock', /quorum|eta|timelock|state|executed/i],
    ['bound', 'Nobody votes with more power than they hold', /vote|power|weight/i],
  ],
  perps: [
    ['solvency', 'Every position keeps at least maintenance margin after a trade', /margin|position|collateral/i],
    ['conservation', 'Funding paid by longs equals funding received by shorts', /funding/i],
  ],
  oracle: [
    ['bound', 'A price is never used when it is stale or out of bounds', /price|updated|timestamp|round/i],
  ],
  other: [
    ['conservation', 'Nobody can take out more value than they put in', /balance|deposit|share|amount/i],
    ['access', 'Only privileged roles can change settings', /owner|admin|fee|config|role/i],
  ],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '');

// Does a written state variable match what a rule talks about? Exact name, or one
// contains the other (a rule about "fee" covers "withdrawFeeBps").
export function stateMatches(ruleState, written) {
  const a = norm(ruleState);
  const b = norm(written);
  if (!a || !b) return false;
  return a === b || (a.length >= 3 && b.includes(a)) || (b.length >= 3 && a.includes(b));
}

// Every function that can change the state a rule depends on, and who can reach it.
export function ruleExposure(state, rule) {
  const comps = Object.values(state.items.component).filter((c) => c.targetId === rule.targetId || !rule.targetId);
  const want = rule.state || [];
  const mapped = comps.some((c) => (c.surface || []).length);
  if (!want.length) return { level: 'unscoped', writers: [], readers: [], why: 'Say which state this rule is about, so the map can show what can change it.' };
  if (!mapped) return { level: 'unmapped', writers: [], readers: [], why: 'No functions on the map yet: run recon scan on the source.' };
  const writers = [];
  const readers = [];
  for (const c of comps) {
    for (const f of c.surface || []) {
      const w = (f.writes || []).filter((v) => want.some((s) => stateMatches(s, v)));
      const r = (f.reads || []).filter((v) => want.some((s) => stateMatches(s, v)));
      if (w.length) writers.push({ componentId: c.id, component: c.name, fn: f.fn, access: f.access, writes: w, line: f.line, location: c.location });
      else if (r.length && f.access !== 'internal') readers.push({ componentId: c.id, component: c.name, fn: f.fn, access: f.access, reads: r });
    }
  }
  const open = writers.filter((w) => w.access === 'anyone');
  const roles = writers.filter((w) => w.access.startsWith('role:'));
  const level = open.length ? 'open' : roles.length ? 'guarded' : writers.length ? 'internal' : 'untouched';
  const why = {
    open: `Anyone can change it: ${open.slice(0, 4).map((w) => `${w.component}.${w.fn}`).join(', ')}. Test these first.`,
    guarded: `Only a role can change it (${[...new Set(roles.map((w) => w.access.slice(5)))].join(', ')}). It breaks if that role is wrong, compromised or misconfigured.`,
    internal: 'Only internal code changes it; look at the public functions that call it.',
    untouched: 'Nothing on the map writes this state: check the name, or it may be set once at deploy.',
  }[level];
  return { level, writers, readers, why };
}

// Starter rules for a target, with the scanned state they are about filled in.
export function suggestRules(state, target, playbookTypes = [target.protocolType || 'other']) {
  const comps = Object.values(state.items.component).filter((c) => c.targetId === target.id);
  const vars = [...new Set(comps.flatMap((c) => (c.surface || []).flatMap((f) => [...(f.writes || []), ...(f.reads || [])])))];
  const have = new Set(Object.values(state.items.rule || {}).filter((r) => r.targetId === target.id).map((r) => r.text.toLowerCase()));
  const out = [];
  for (const type of [...new Set([...playbookTypes, 'other'])]) {
    for (const [category, text, hint] of RULE_TEMPLATES[type] || []) {
      if (have.has(text.toLowerCase()) || out.some((x) => x.text === text)) continue;
      out.push({ category, text, state: vars.filter((v) => hint.test(v)).slice(0, 6), from: type });
    }
  }
  return out;
}

// What an agent writes to test a rule, per engine: a nudge, not a template to paste.
export const ENGINE_HINTS = {
  'foundry-invariant': 'a Foundry invariant test: a handler that calls the target\'s functions as different senders, and invariant_<name>() asserting the rule',
  'foundry-fuzz': 'a Foundry fuzz test over the inputs of the functions that write the rule\'s state',
  halmos: 'a Halmos check_<name>() that symbolically executes the writers and asserts the rule',
  echidna: 'an Echidna property echidna_<name>() returning whether the rule holds',
  medusa: 'a Medusa property test asserting the rule after random call sequences',
  certora: 'a Certora rule or invariant in CVL',
};
