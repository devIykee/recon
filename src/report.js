// The report slot. The human decides once how the disclosure should look
// (one combined document, or one per finding) and where it goes; the agent
// writes there, and only findings that pass every gate get in.

import { cardGaps, evidenceGaps, severityProblem, duplicateOf, reportedMatch } from './quality.js';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'finding';

export function reportConfig(state) {
  return { shape: '', path: '', includeIds: [], ...(state.project.report || {}) };
}

// Why a finding is or is not in the report.
export function reportability(state, f) {
  const reasons = [];
  for (const g of cardGaps(f)) reasons.push(`card: ${g.field} missing`);
  for (const g of evidenceGaps(f)) reasons.push(`evidence: needs ${g}`);
  const sev = severityProblem(f);
  if (sev) reasons.push(`severity: ${sev}`);
  if (['fork', 'unit', 'fuzz'].includes(f.verificationMethod) && f.testResult !== 'pass') reasons.push(`test "${f.testName || '?'}" has not passed on its last run`);
  const dup = duplicateOf(state, f);
  if (dup && dup.createdAt < f.createdAt) reasons.push(`duplicate of ${dup.id} "${dup.title}"`);
  if (f.alreadyReported === 'yes' || (reportedMatch(state, f) && !/^distinct/i.test(f.alreadyReportedRef || ''))) reasons.push('already reported');
  if (f.verification === 'disputed') reasons.push('disputed by the human');
  if (f.stage === 'fixed' || f.stage === 'disclosed') reasons.push(`already ${f.stage}`);
  return reasons;
}

export function buildReport(state) {
  const cfg = reportConfig(state);
  const all = Object.values(state.items.finding).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.createdAt - b.createdAt);
  const pool = cfg.includeIds?.length ? all.filter((f) => cfg.includeIds.includes(f.id)) : all;
  const included = [];
  const excluded = [];
  for (const f of pool) {
    const why = reportability(state, f);
    if (why.length) excluded.push({ id: f.id, title: f.title, severity: f.severity, reasons: why });
    else included.push(f);
  }
  for (const f of all) if (!pool.includes(f)) excluded.push({ id: f.id, title: f.title, severity: f.severity, reasons: ['not in the chosen findings'] });
  const shape = cfg.shape || 'combined';
  const files = shape === 'separate' ? separate(state, included) : [{ name: `${slug(state.project.name)}-report.md`, body: combined(state, included) }];
  return { config: cfg, shape, included: included.map((f) => ({ id: f.id, title: f.title, severity: f.severity })), excluded, files };
}

function header(state) {
  const targets = Object.values(state.items.target);
  const lines = [`# ${state.project.name}: security findings`, '', `Date: ${new Date().toISOString().slice(0, 10)}`];
  for (const t of targets) {
    lines.push('', `**Target:** ${t.name}${t.chain ? ` (${t.chain})` : ''}`);
    if (t.inScope || t.scope) lines.push(`**In scope:** ${t.inScope || t.scope}`);
    if (t.outOfScope) lines.push(`**Out of scope:** ${t.outOfScope}`);
    if (t.disclosureChannel) lines.push(`**Disclosure channel:** ${t.disclosureChannel}`);
  }
  return lines;
}

function section(state, f, n) {
  const comp = state.items.component[f.componentId];
  const chains = Object.values(state.items.chain || {}).filter((c) => (c.parts || []).includes(f.id) || (f.hypothesisId && (c.parts || []).includes(f.hypothesisId)));
  const ev = (f.evidence || []).map((e) => `- \`${e.kind}\` ${e.ref}${e.note ? `: ${e.note}` : ''}${e.block ? ` (block ${e.block}${e.rpc ? `, ${e.rpc}` : ''})` : ''}`);
  return [
    `## ${n ? `${n}. ` : ''}${f.title}`,
    '',
    `| | |`, `| --- | --- |`,
    `| Severity | **${cap(f.severity)}** |`,
    comp ? `| Component | \`${comp.name}\`${comp.location ? ` (${comp.location})` : ''} |` : null,
    `| Attacker | ${f.attacker} |`,
    `| Reachability | ${f.reachability} |`,
    `| Funds at risk | ${f.liveFunds}${f.liveFundsMethod ? ` (measured by ${f.liveFundsMethod})` : ''} |`,
    `| Verified by | ${f.verificationMethod}${f.testName ? `: \`${f.testName}\`` : ''}${f.testResult ? ` (${f.testResult})` : ''} |`,
    `| Previously reported | ${f.alreadyReported}${f.alreadyReportedRef ? `: ${f.alreadyReportedRef}` : ''} |`,
    f.productionTouched ? `| Production touched | yes: ${f.productionNote} |` : `| Production touched | no |`,
    '',
    '### Impact and root cause', '', f.notes || '_(not written)_', '',
    '### Bound', '', f.bound, '',
    f.repro ? ['### Reproduction', '', f.repro, ''] : null,
    ev.length ? ['### Evidence', '', ...ev, ''] : null,
    chains.length ? ['### Part of a chain', '', ...chains.map((c) => `- **${c.title}** (${c.severity}): ${c.result} (glue: ${c.glue}${c.gluePermissionless ? ', attacker-controlled' : ''})`), ''] : null,
  ].flat().filter((x) => x !== null);
}

function combined(state, findings) {
  const lines = header(state);
  lines.push('', '## Summary', '', '| # | Finding | Severity |', '| --- | --- | --- |');
  findings.forEach((f, i) => lines.push(`| ${i + 1} | ${f.title} | ${cap(f.severity)} |`));
  if (!findings.length) lines.push('| | No finding passes every check yet. | |');
  lines.push('', 'Each finding below stands on its own, with its own severity, bound and test.', '');
  findings.forEach((f, i) => lines.push(...section(state, f, i + 1), ''));
  return lines.join('\n');
}

function separate(state, findings) {
  const names = findings.map((f, i) => `${String(i + 1).padStart(2, '0')}-${slug(f.title)}.md`);
  const files = findings.map((f, i) => {
    const others = findings.map((o, j) => (j === i ? null : `- [${o.title}](${names[j]}) (${cap(o.severity)})`)).filter(Boolean);
    const lines = [...header(state), '', ...section(state, f, 0)];
    if (others.length) lines.push('', '### Other findings in this engagement', '', ...others);
    return { name: names[i], body: lines.join('\n') };
  });
  const index = [...header(state), '', '## Findings (one report each)', '', ...findings.map((f, i) => `- [${f.title}](${names[i]}) (${cap(f.severity)})`)];
  return [{ name: '00-index.md', body: index.join('\n') }, ...files];
}
