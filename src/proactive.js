// Proactivity: what an agent must do now, what it must not forget before it stops,
// and where it left off. Modeled on assistants that surface the next action as a
// small card you can say yes or no to, instead of waiting to be asked.
//
// mustDo is ordered by cost of missing it: a missed steer is the most expensive
// miss (the human was pointing at the bug), then disputes, then claims without
// proof, then loose ends.

import { openSteersFor, cardGaps, severityProblem, ackedSteersFor, queuedSteersFor, steersBeingIgnored } from './quality.js';
import { phaseStatus } from './knowledge.js';
import { ruleExposure, ENGINE_HINTS } from './rules.js';
import { buildReport } from './report.js';

const OVERDUE = 30 * 60_000;
const name = (it) => it?.name || it?.title || it?.text || it?.note || it?.id || '';
const short = (s, n = 90) => { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function mustDo(state, agentId, now = Date.now()) {
  const items = state.items;
  const out = [];
  const add = (kind, item, todo, how, extra = {}) => out.push({ kind, id: item?.id || null, do: todo, how, ...extra });
  const mine = (it) => it.createdBy === agentId || it.owner === agentId;

  for (const s of openSteersFor(state, agentId)) {
    const about = s.itemId ? items[s.itemKind]?.[s.itemId] : null;
    add('steer', s, `acknowledge steer ${s.id} (${s.action}${about ? ` on "${short(name(about), 40)}"` : ''}): ${short(s.note, 80)}`, 'recon_steer state=acknowledged', { urgent: true });
  }

  for (const kind of ['finding', 'hypothesis', 'assumption', 'component']) {
    for (const it of Object.values(items[kind])) {
      if (it.verification === 'disputed' && it.createdBy === agentId) add('disputed', it, `revisit your disputed ${kind} "${short(name(it), 60)}": strengthen the evidence or retract`, 'recon_evidence / recon_update', { urgent: true });
    }
  }

  // An acknowledged steer stays in front of the agent on every call until it reports back.
  const ignored = new Set(steersBeingIgnored(state, agentId, now).map((s) => s.id));
  for (const s of ackedSteersFor(state, agentId)) {
    const overdue = ignored.has(s.id) || now - (s.ackAt || s.updatedAt) > OVERDUE;
    add('address', s, `${overdue ? 'OVERDUE, other work is refused until you answer: ' : 'the human asked, work this now: '}steer ${s.id}: ${short(s.note, 100)}`, `do it, then recon_steer state=addressed response="..." (progress: recon_say replyTo=${s.id})`, { urgent: true });
  }
  for (const s of queuedSteersFor(state, agentId)) {
    add('queued', s, `queued steer ${s.id}: ${short(s.note, 90)}`, 'recon_steer state=acknowledged when you start it, or state=addressed when done');
  }

  for (const c of Object.values(items.component)) {
    if (c.reviewState !== 'flagged' || !(mine(c) || c.lastTouchedBy === agentId)) continue;
    if (!Object.values(items.hypothesis).some((h) => h.componentId === c.id && h.status !== 'dropped')
      && !Object.values(items.finding).some((f) => f.componentId === c.id)) {
      add('flag', c, `"${c.name}" is flagged with no hypothesis: write down the testable claim`, 'recon_add_hypothesis');
    }
  }

  for (const f of Object.values(items.finding)) {
    if (!mine(f)) continue;
    const gaps = cardGaps(f);
    if (gaps.length) add('card', f, `finish the confirmation card for "${short(f.title, 50)}": ${gaps.map((g) => g.field).join(', ')}`, 'recon_update');
    const sev = severityProblem(f);
    if (sev) add('severity', f, `"${short(f.title, 50)}" is rated ${f.severity} but: ${sev}`, 'recon_update severity or add proof');
  }

  for (const h of Object.values(items.hypothesis)) {
    if (!mine(h) || h.status === 'dropped') continue;
    if (h.exploitStage === 'capability') add('trigger', h, `hunt the trigger for "${short(h.text, 60)}": what public path makes this capability fire?`, 'recon_update trigger + exploitStage');
    else if (h.status === 'confirmed' && !h.findingId && h.exploitStage === 'full') add('promote', h, `confirmed but not filed: "${short(h.text, 60)}"`, 'recon_add_finding with hypothesisId');
  }

  for (const t of Object.values(items.target)) {
    const phase = t.phase || 'mapping';
    const ps = phaseStatus(state, t.id);
    if (phase === 'mapping' && !t.inScope && !t.outOfScope && !t.scope) add('scope', t, `record the program's scope for "${t.name}": in scope, out of scope, already-reported issues, disclosure channel, severity scale and rules (one per submission?)`, 'recon_update on the target: inScope, outOfScope, alreadyReported, disclosureChannel, severityScale, bountyRules');
    if (phase === 'mapping') add('phase', t, `map "${t.name}" (${ps.components} parts, ${ps.relations} connections so far), then move it to assumptions`, 'recon_map, recon_phase');
    else if (phase === 'assumptions') add('phase', t, `record what "${t.name}"'s developers assume (${ps.developerAssumptions} so far), then move to hunting`, 'recon_add_assumption origin=developer, recon_phase');
  }

  const report = state.project.report || {};
  const rep = buildReport(state);
  const includedIds = new Set(rep.included.map((f) => f.id));
  const reportable = Object.values(items.finding).filter((f) => !f.foldedInto && !cardGaps(f).length);
  const HYGIENE_FIELDS = new Set(['alreadyReported', 'alreadyReportedRef', 'foldedInto', 'verification', 'priority', 'stage']);
  const substantiveUpdatedAt = (f) => {
    if (!f?._f || !Object.keys(f._f).length) return f?.updatedAt || 0;
    const times = Object.entries(f._f).filter(([k]) => !HYGIENE_FIELDS.has(k)).map(([, v]) => v?.at || 0);
    return times.length ? Math.max(...times) : (f.createdAt || 0);
  };
  const includedFindings = Object.values(items.finding).filter((f) => includedIds.has(f.id));
  const lastFindingChange = Math.max(0, ...includedFindings.map(substantiveUpdatedAt));
  if (includedFindings.length && report.shape && (!report.last || report.last.at < lastFindingChange)) {
    add('report', null, `findings changed since the report was last written: rewrite the ${report.shape} report${report.path ? ` at ${report.path}` : ''}`, 'recon_write_report, write it, then recon_submit_report');
  }
  if (reportable.length && report.shape && !report.signOff) {
    add('report', null, 'ask the human whose name signs the report before you write it', 'recon_propose with options, e.g. ["Sign as <their name>", "Sign as <team name>"]');
  }
  for (const f of reportable) {
    if (!f.fix && (mine(f) || !f.createdBy?.startsWith('ag_'))) add('card', f, `"${short(f.title, 60)}" has no suggested fix: write one an engineer could implement from the description`, 'recon_update fix="..."');
  }
  if (reportable.length && !report.shape) {
    add('report', null, `${reportable.length} finding(s) are ready: ask the human how they want the report (one combined document, or one per finding) and where to write it, instead of drafting in chat`, 'recon_propose with options ["combined", "separate"]');
  }

  // rules: write them, then try to break them, riskiest first (not on the built-in example)
  for (const t of state.project.example ? [] : Object.values(items.target)) {
    if ((t.phase || 'mapping') === 'mapping') continue;
    const rules = Object.values(items.rule || {}).filter((r) => r.targetId === t.id);
    if (!rules.length) { add('rules', t, `write the rules "${t.name}" must never break (e.g. nobody withdraws more than they put in), each with the state it is about`, 'recon_rules (suggests some from the code), then recon_add_rule'); continue; }
    const untested = rules.filter((r) => r.status === 'untested' && (mine(r) || !r.createdBy?.startsWith('ag_')))
      .map((r) => ({ r, x: ruleExposure(state, r) }))
      .sort((a, b) => ['open', 'guarded', 'internal', 'untouched', 'unscoped', 'unmapped'].indexOf(a.x.level) - ['open', 'guarded', 'internal', 'untouched', 'unscoped', 'unmapped'].indexOf(b.x.level));
    for (const { r, x } of untested.slice(0, 3)) {
      add('rule', r, `try to break the rule "${short(r.text, 70)}"${x.level === 'open' ? ` (anyone can change its state: ${x.writers.filter((w) => w.access === 'anyone').slice(0, 3).map((w) => `${w.component}.${w.fn}`).join(', ')})` : ''}`, `write it as ${ENGINE_HINTS['foundry-invariant']} (or Halmos/Echidna), run it, then recon_rule_result`);
    }
  }

  for (const l of Object.values(items.lead)) {
    if (l.state === 'open' && l.value === 'high' && (mine(l) || !l.createdBy?.startsWith('ag_'))) add('lead', l, `open high-value thread: ${short(l.text, 80)}${l.nextStep ? ` (next: ${short(l.nextStep, 50)})` : ''}`, 'work it, or recon_update state=blocked/done/dropped');
  }

  return out.slice(0, 12);
}

// The short nudge attached to every agent response while something urgent is waiting.
export function pulse(state, agentId, now = Date.now()) {
  const todo = mustDo(state, agentId, now);
  const urgent = todo.filter((t) => t.urgent);
  if (!urgent.length) return null;
  const lines = urgent.slice(0, 4).map((t) => `- ${t.do}`);
  return `recon: ${urgent.length} thing(s) come before your next step:\n${lines.join('\n')}${urgent.length > 4 ? `\n- ...and ${urgent.length - 4} more (recon_briefing)` : ''}`;
}

// What must not be lost before the agent stops, writes a report, or goes idle.
export function beforeYouStop(state, agentId) {
  const items = state.items;
  const steers = Object.values(items.steer).filter((s) => !['addressed', 'waiting-on-human'].includes(s.state) && ((s.to || []).includes(agentId) || (s.to || []).includes('all')));
  const leads = Object.values(items.lead).filter((l) => l.state === 'open' || l.state === 'blocked');
  const unfinished = Object.values(items.finding).filter((f) => f.createdBy === agentId && cardGaps(f).length);
  const testing = Object.values(items.hypothesis).filter((h) => h.createdBy === agentId && h.status === 'testing');
  const list = [];
  if (steers.length) list.push(`${steers.length} steer(s) not reported back on`);
  if (unfinished.length) list.push(`${unfinished.length} finding(s) with an unfinished confirmation card`);
  if (testing.length) list.push(`${testing.length} hypothesis(es) still testing: confirm, drop with a reason, or record what is left as a lead`);
  list.push('record everything still worth doing as a lead (recon_add_lead: what, why it matters, what blocks it, next step) so nothing is lost when you stop');
  if (leads.length) list.push(`${leads.length} open lead(s): keep them current (done, dropped, or blocked with the reason)`);
  list.push('end with a recon_propose that offers the human a choice of next moves, instead of a question in chat');
  list.push('then do not end your turn: call recon_wait, which returns as soon as the human answers from the board');
  return list;
}

export function whereWeLeftOff(state, agentId) {
  const items = state.items;
  const me = items.agent[agentId];
  const mineActs = state.activity.filter((a) => a.by === agentId);
  const last = mineActs[mineActs.length - 1];
  return {
    engagement: { id: state.project.id, name: state.project.name },
    lastSeen: last ? new Date(last.at).toISOString() : null,
    lastFocus: me?.focus || null,
    lastActions: mineActs.slice(-8).map((a) => a.summary),
    openLeads: Object.values(items.lead).filter((l) => l.state === 'open' || l.state === 'blocked')
      .map((l) => ({ id: l.id, text: l.text, value: l.value, state: l.state, blockedBy: l.blockedBy || undefined, nextStep: l.nextStep || undefined })),
  };
}
