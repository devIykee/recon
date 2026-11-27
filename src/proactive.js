// Proactivity: what an agent must do now, what it must not forget before it stops,
// and where it left off. Modeled on assistants that surface the next action as a
// small card you can say yes or no to, instead of waiting to be asked.
//
// mustDo is ordered by cost of missing it: a missed steer is the most expensive
// miss (the human was pointing at the bug), then disputes, then claims without
// proof, then loose ends.

import { openSteersFor, cardGaps, severityProblem } from './quality.js';
import { phaseStatus } from './knowledge.js';

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

  for (const s of Object.values(items.steer)) {
    if (s.state !== 'acknowledged' || !((s.to || []).includes(agentId) || (s.to || []).includes('all'))) continue;
    const overdue = now - (s.ackAt || s.updatedAt) > OVERDUE;
    add('address', s, `${overdue ? 'OVERDUE: ' : ''}report back on steer ${s.id}: ${short(s.note, 80)}`, 'recon_steer state=addressed response="..."', { urgent: overdue });
  }

  for (const c of Object.values(items.component)) {
    if (c.reviewState !== 'flagged' || !(mine(c) || c.lastTouchedBy === agentId)) continue;
    if (!Object.values(items.hypothesis).some((h) => h.componentId === c.id && h.status !== 'dropped')) {
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
  const reportable = Object.values(items.finding).filter((f) => !cardGaps(f).length);
  const lastFindingChange = Math.max(0, ...Object.values(items.finding).map((f) => f.updatedAt));
  if (reportable.length && report.shape && (!report.last || report.last.at < lastFindingChange)) {
    add('report', null, `findings changed since the report was last written: rewrite the ${report.shape} report${report.path ? ` at ${report.path}` : ''}`, 'recon_write_report');
  }
  if (reportable.length && !report.shape) {
    add('report', null, `${reportable.length} finding(s) are ready: ask the human how they want the report (one combined document, or one per finding) and where to write it, instead of drafting in chat`, 'recon_propose with options ["combined", "separate"]');
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
  const steers = Object.values(items.steer).filter((s) => s.state !== 'addressed' && ((s.to || []).includes(agentId) || (s.to || []).includes('all')));
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
