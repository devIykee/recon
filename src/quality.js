// Quality gates for agent writes. Each gate exists because a real hunt went wrong
// without it: missed steers, inflated severity, duplicate findings, capabilities
// filed as exploits, smells without a testable claim, out-of-scope reports.
//
// Gates apply to agents only. A human can always override.

import { ValidationError, isHuman } from './model.js';

const REPORTED_STAGES = ['reported', 'acknowledged', 'fixed', 'disclosed'];

export class GateError extends ValidationError {
  constructor(message, gate) {
    super(message);
    this.name = 'GateError';
    this.status = 422;
    this.gate = gate;
  }
}

// ---------- reads used by gates and by mustDo ----------

export function openSteersFor(state, agentId) {
  return Object.values(state.items.steer).filter((s) => s.state === 'open' && ((s.to || []).includes(agentId) || (s.to || []).includes('all')));
}

const CARD = [
  ['attacker', 'who the attacker is: stranger, holder, privileged or admin'],
  ['reachability', 'how they reach it: permissionless, needs-role, needs-config or needs-social'],
  ['bound', 'one sentence on what still cannot happen (the limit of the damage)'],
  ['liveFunds', 'funds at risk right now: "none", "unknown", or address + amount'],
  ['alreadyReported', 'checked prior reports and audits: no, yes or unknown (with alreadyReportedRef)'],
  ['verificationMethod', 'how it was verified: fork, eth_call, unit, fuzz, live-tx or manual'],
];

export function cardGaps(f) {
  const gaps = CARD.filter(([k]) => f[k] === undefined || f[k] === null || f[k] === '').map(([k, why]) => ({ field: k, why }));
  if (['fork', 'unit', 'fuzz'].includes(f.verificationMethod) && !f.testName) gaps.push({ field: 'testName', why: 'the name of the test that proves it' });
  if (f.liveFunds && !/^(none|unknown)$/i.test(f.liveFunds.trim()) && !f.liveFundsMethod) gaps.push({ field: 'liveFundsMethod', why: 'how the live funds were measured: eth_call, fork, explorer or not-measured' });
  if (f.productionTouched && !f.productionNote) gaps.push({ field: 'productionNote', why: 'production was touched: say why that was necessary and safe' });
  return gaps;
}

export function evidenceGaps(item) {
  const kinds = new Set((item.evidence || []).map((e) => e.kind));
  const gaps = [];
  if (!kinds.has('code')) gaps.push('a code reference (file:line or function)');
  if (!['test', 'fork', 'tx'].some((k) => kinds.has(k))) gaps.push('a test, fork run or transaction that demonstrates it');
  return gaps;
}

const fundsMeasured = (f) => f.liveFunds && !/^(none|unknown)$/i.test(f.liveFunds.trim()) && f.liveFundsMethod && f.liveFundsMethod !== 'not-measured';

// Severity has to be earned. Returns a reason to refuse, or null.
export function severityProblem(f) {
  if (f.severity === 'critical') {
    if (f.reachability !== 'permissionless') return 'Critical needs a permissionless path. A role, config or social step in the way makes it High at most.';
    if (!['stranger', 'holder'].includes(f.attacker)) return 'Critical needs an outside attacker (stranger or holder), not a privileged role.';
    if (!fundsMeasured(f) && !/insolv/i.test(`${f.bound} ${f.notes}`)) return 'Critical needs live funds at risk, measured (liveFunds + liveFundsMethod), or protocol insolvency spelled out.';
  }
  if (f.severity === 'high') {
    if (f.reachability !== 'permissionless' && !['stranger', 'holder'].includes(f.attacker)) {
      return 'High needs a path an outsider can take (attacker stranger/holder or reachability permissionless). Admin or config-only issues are Medium at most.';
    }
  }
  return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function duplicateOf(state, f) {
  if (!f.componentId || !f.bugClass) return null;
  return Object.values(state.items.finding).find((x) => x.id !== f.id && x.componentId === f.componentId
    && norm(x.bugClass) === norm(f.bugClass) && x.stage !== 'disclosed') || null;
}

export function reportedMatch(state, f) {
  const target = state.items.target[f.targetId];
  const comp = state.items.component[f.componentId];
  for (const r of target?.alreadyReported || []) {
    const entry = typeof r === 'string' ? { title: r } : r;
    const hay = norm(`${entry.title} ${entry.contract || ''}`);
    const name = norm(comp?.name || '').split(' ')[0];
    if ((name && hay.includes(name)) || (norm(f.title) && hay && (hay.includes(norm(f.title)) || norm(f.title).includes(hay)))) return entry;
  }
  return null;
}

const list = (xs) => xs.map((x) => `- ${x}`).join('\n');

// Throws a GateError explaining what to do instead. `next` is the item as it would be after the write.
export function enforce(state, kind, next, changed, author, { created = false } = {}) {
  if (isHuman(author)) return;
  const steers = openSteersFor(state, author);
  const gated = (kind === 'finding' && !(changed.length === 1 && changed[0] === 'evidence'))
    || (kind === 'chain')
    || (kind === 'component' && changed.includes('reviewState'))
    || (kind === 'agent' && (changed.includes('focus') || changed.includes('focusItem')));
  if (gated && steers.length) {
    throw new GateError(`acknowledge your ${steers.length} open steer(s) first (they never stop your work, but they come first):\n${list(steers.slice(0, 6).map((s) => `${s.id} ${s.action}: ${s.note || ''}`.trim()))}\nUse recon_steer with state "acknowledged" (cli: recon ack <id>).`, 'steers');
  }

  if (kind === 'component' && changed.includes('reviewState') && next.reviewState === 'flagged') {
    const hasHyp = Object.values(state.items.hypothesis).some((h) => h.componentId === next.id && h.status !== 'dropped')
      || Object.values(state.items.finding).some((f) => f.componentId === next.id);
    if (!hasHyp) throw new GateError(`flagging "${next.name}" needs a testable claim: add the hypothesis for it first (recon_add_hypothesis with componentId, or recon_coverage with a "hypothesis"), then flag it.`, 'flag-needs-hypothesis');
  }

  if (kind === 'hypothesis' && changed.includes('status') && next.status === 'confirmed') {
    const gaps = evidenceGaps(next);
    if (gaps.length) throw new GateError(`a confirmed hypothesis needs:\n${list(gaps)}\nAttach them with recon_evidence, then confirm.`, 'evidence');
    if (next.exploitStage === 'capability') throw new GateError('this is a capability without a trigger. Confirmed means exploitable: find the trigger (the call path that makes the capability fire), record it in "trigger" and set exploitStage to "full".', 'capability');
  }

  if (kind === 'finding') {
    if (created) {
      const gaps = cardGaps(next);
      if (gaps.length) throw new GateError(`a finding is not valid until its confirmation card is filled. Missing:\n${list(gaps.map((g) => `${g.field}: ${g.why}`))}`, 'card');
      const dup = duplicateOf(state, next);
      if (dup) throw new GateError(`this looks like a duplicate of ${dup.id} "${dup.title}" (same component and bug class). Add evidence to it, or link both in a chain (recon_add_chain) if together they are worse.`, 'duplicate');
      const prior = reportedMatch(state, next);
      if (prior && next.alreadyReported !== 'yes' && !/^distinct/i.test(next.alreadyReportedRef || '')) {
        throw new GateError(`this matches an already-reported issue on the target: "${prior.title}"${prior.date ? ` (${prior.date})` : ''}. If it is the same bug, set alreadyReported "yes" (it will not be paid). If it is different, set alreadyReportedRef to "distinct: <how it differs>".`, 'already-reported');
      }
      if (next.hypothesisId) {
        const h = state.items.hypothesis[next.hypothesisId];
        if (h && h.exploitStage !== 'full') {
          throw new GateError(h.exploitStage === 'capability'
            ? `hypothesis ${h.id} is a capability without a trigger. Hunt the trigger first: what public path makes it fire? Record it, set exploitStage "full", then file the finding.`
            : `set exploitStage on hypothesis ${h.id} first: capability (power exists, no trigger found), trigger (trigger found, impact unproven) or full (trigger + impact).`, 'capability');
        }
      }
    } else {
      const cardTouched = changed.some((k) => ['attacker', 'reachability', 'bound', 'liveFunds', 'alreadyReported', 'verificationMethod'].includes(k));
      if (cardTouched) {
        const gaps = cardGaps(next).filter((g) => changed.includes(g.field));
        if (gaps.length) throw new GateError(`cannot clear card fields: ${gaps.map((g) => g.field).join(', ')}`, 'card');
      }
    }
    if (changed.includes('severity') || created || changed.some((k) => ['attacker', 'reachability', 'liveFunds', 'liveFundsMethod'].includes(k))) {
      const why = severityProblem(next);
      if (why) throw new GateError(`severity ${next.severity} refused: ${why} Lower the severity, or add the missing proof. A human can still override.`, 'severity');
    }
    if (changed.includes('stage') && REPORTED_STAGES.includes(next.stage)) {
      const gaps = [...cardGaps(next).map((g) => `${g.field}: ${g.why}`), ...evidenceGaps(next)];
      if (['fork', 'unit', 'fuzz'].includes(next.verificationMethod) && next.testResult !== 'pass') gaps.push(`the test "${next.testName || '?'}" passing on its last run (testResult "pass")`);
      if (gaps.length) throw new GateError(`not ready to move to "${next.stage}". Still needed:\n${list(gaps)}`, 'report-ready');
    }
  }

  if (kind === 'chain') {
    const missing = (next.parts || []).filter((id) => !state.items.hypothesis[id] && !state.items.finding[id]);
    if ((next.parts || []).length < 2) throw new GateError('a chain links at least two hypotheses or findings (parts).', 'chain');
    if (missing.length) throw new GateError(`chain parts not found: ${missing.join(', ')}`, 'chain');
    if (['critical', 'high'].includes(next.severity) && !next.gluePermissionless) {
      throw new GateError(`a ${next.severity} chain needs glue an attacker controls (gluePermissionless true). Config the team chose plus code is usually Medium.`, 'chain-severity');
    }
  }
}
