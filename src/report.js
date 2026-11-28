// The report slot. The human decides once how the disclosure goes out (one
// combined document, or one per finding), where it is written, which skill the
// writer follows and whose name signs it. The agent then gets a brief (that skill
// as its system prompt, plus every fact on the board that the skill asks for),
// writes plain prose, and submits it here. Only findings that pass every gate
// can be reported.

import { cardGaps, evidenceGaps, severityProblem, duplicateOf, reportedMatch } from './quality.js';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'finding';

const ATTACKER = { stranger: 'anyone, with no special access', holder: 'any token holder', privileged: 'someone holding a privileged role', admin: 'only an admin' };
const REACH = { permissionless: 'no permission is needed', 'needs-role': 'a special role is needed', 'needs-config': 'it only works if a setting is turned on', 'needs-social': 'someone has to be tricked' };
const VERIFY = { fork: 'a test on a local fork of the live chain', eth_call: 'read-only calls against the live chain', unit: 'a unit test', fuzz: 'a fuzz harness', 'live-tx': 'a real signed transaction', manual: 'manual reading of the code only' };
const FUNDS = { eth_call: 'read-only calls', fork: 'a fork', explorer: 'a block explorer', 'not-measured': 'not measured' };

export function reportConfig(state) {
  return { shape: '', path: '', includeIds: [], skill: '', signOff: '', signOffAliases: [], documents: [], ...(state.project.report || {}) };
}

const HYGIENE_FIELDS = new Set(['alreadyReported', 'alreadyReportedRef', 'foldedInto', 'verification', 'priority', 'stage']);
function substantiveUpdatedAt(f) {
  if (!f?._f || !Object.keys(f._f).length) return f?.updatedAt || 0;
  const times = Object.entries(f._f).filter(([k]) => !HYGIENE_FIELDS.has(k)).map(([, v]) => v?.at || 0);
  return times.length ? Math.max(...times) : (f.createdAt || 0);
}

// Why a finding is or is not in the report.
export function reportability(state, f) {
  const reasons = [];
  if (f.foldedInto && state.items.finding[f.foldedInto]) {
    reasons.push(`folded into ${f.foldedInto} "${state.items.finding[f.foldedInto].title}"`);
    return reasons;
  }
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

// Which findings go in, which stay out and why, and what has been written so far.
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
  const expected = expectedDocuments(state, shape, included);
  const docs = (cfg.documents || []).filter((d) => d.shape === shape);
  const changedAt = (ids) => Math.max(0, ...ids.map((id) => substantiveUpdatedAt(state.items.finding[id])));
  const documents = expected.map((e) => {
    const d = docs.find((x) => x.key === e.key);
    return {
      ...e,
      written: Boolean(d),
      stale: Boolean(d && d.at < changedAt(e.findingIds)),
      ...(d ? {
        body: d.body, appendix: d.appendix || '', fields: d.fields, at: d.at, by: d.by, skill: d.skill,
        disclosureState: d.disclosureState || 'draft', sentAt: d.sentAt || null, acknowledgedAt: d.acknowledgedAt || null,
      } : {}),
    };
  });
  return {
    config: { ...cfg, documents: undefined },
    shape,
    included: included.map((f) => ({ id: f.id, title: f.title, severity: f.severity })),
    excluded,
    documents,
    missing: documents.filter((d) => !d.written).map((d) => d.name),
    stale: documents.filter((d) => d.stale).map((d) => d.name),
  };
}

function expectedDocuments(state, shape, included) {
  if (shape === 'separate') return included.map((f, i) => ({ key: f.id, name: `${String(i + 1).padStart(2, '0')}-${slug(f.title)}.txt`, findingIds: [f.id], title: f.title }));
  if (!included.length) return [];
  return [{ key: 'combined', name: `${slug(state.project.name)}-disclosure.txt`, findingIds: included.map((f) => f.id), title: state.project.name }];
}

// ---------- the brief: what the writer gets ----------

export function reportBrief(state, skill) {
  const r = buildReport(state);
  const cfg = reportConfig(state);
  const items = state.items;
  const nameOf = (id) => items.component[id]?.name || '';
  const included = r.included.map((x) => items.finding[x.id]);
  const targets = Object.values(items.target);

  const findingFacts = (f) => {
    const comp = items.component[f.componentId];
    const hyp = items.hypothesis[f.hypothesisId];
    const chains = Object.values(items.chain || {}).filter((c) => (c.parts || []).includes(f.id) || (f.hypothesisId && (c.parts || []).includes(f.hypothesisId)));
    return {
      id: f.id,
      title: f.title,
      severity: f.severity,
      bugClass: f.bugClass || hyp?.bugClass || '',
      component: comp ? { name: comp.name, location: comp.location || '', summary: comp.summary || '' } : null,
      target: items.target[f.targetId]?.name || '',
      whoCanDoIt: ATTACKER[f.attacker] || f.attacker,
      whatTheyNeed: REACH[f.reachability] || f.reachability,
      whatStillCannotHappen: f.bound,
      fundsAtRiskNow: f.liveFunds,
      fundsMeasuredWith: FUNDS[f.liveFundsMethod] || f.liveFundsMethod || 'not said',
      verifiedWith: VERIFY[f.verificationMethod] || f.verificationMethod,
      test: f.testName ? { name: f.testName, lastResult: f.testResult || 'not run' } : null,
      productionTouched: f.productionTouched ? (f.productionNote || 'yes, no detail given') : 'no',
      previouslyReported: f.alreadyReported === 'no' ? `no${f.alreadyReportedRef ? ` (${f.alreadyReportedRef})` : ''}` : f.alreadyReportedRef || f.alreadyReported,
      rootCauseAndImpact: f.notes || '',
      trigger: hyp?.trigger || '',
      reproduction: f.repro || '',
      suggestedFix: f.fix || '',
      evidence: (f.evidence || []).map((e) => ({ kind: e.kind, ref: e.ref, note: e.note || '', block: e.block || '', rpc: e.rpc ? 'yes' : '', ...(e.command ? { command: e.command } : {}), ...(e.env?.length ? { env: e.env } : {}) })),
      chains: chains.map((c) => ({ title: c.title, severity: c.severity, result: c.result, attackerControlsTheGlue: Boolean(c.gluePermissionless) })),
      foldedFindings: Object.values(items.finding).filter((x) => x.foldedInto === f.id).map((x) => ({
        id: x.id, title: x.title, severity: x.severity, notes: x.notes || '', evidence: (x.evidence || []).map((e) => ({ kind: e.kind, ref: e.ref, note: e.note || '' })),
      })),
    };
  };

  // What was tried and held: the credibility section.
  const checkedFine = [
    ...Object.values(items.component).filter((c) => c.reviewState === 'reviewed' && c.type !== 'actor' && c.type !== 'external'
      && !Object.values(items.finding).some((f) => f.componentId === c.id) && !Object.values(items.hypothesis).some((x) => x.componentId === c.id && x.status !== 'dropped'))
      .map((c) => `${c.name}${c.location ? ` (${c.location})` : ''}: reviewed, nothing wrong found${c.reasoning ? `. ${c.reasoning}` : ''}`),
    ...Object.values(items.assumption).filter((a) => a.state === 'verified').map((a) => `Checked that it holds: ${a.text}${a.rationale ? ` (${a.rationale})` : ''}`),
    ...Object.values(items.hypothesis).filter((h) => h.status === 'dropped').map((h) => `Tried and ruled out: ${h.text}${h.dropReason ? `. Why: ${h.dropReason}` : ''}${h.componentId ? ` (in ${nameOf(h.componentId)})` : ''}`),
  ];
  const notReviewed = [
    ...Object.values(items.component).filter((c) => c.reviewState === 'untouched' && c.type !== 'actor' && c.type !== 'external').map((c) => `${c.name}: not reviewed`),
    ...Object.values(items.component).filter((c) => c.reviewState === 'scanning').map((c) => `${c.name}: review not finished`),
    ...targets.filter((t) => t.outOfScope).map((t) => `Out of scope for ${t.name}: ${t.outOfScope}`),
    ...Object.values(items.lead).filter((l) => l.state === 'open' || l.state === 'blocked').map((l) => `Not followed up: ${l.text}${l.blockedBy ? ` (blocked by ${l.blockedBy})` : ''}`),
    ...Object.values(items.assumption).filter((a) => a.state === 'assumed' && a.origin === 'developer').map((a) => `Developer assumption not checked: ${a.text}`),
  ];

  const signOffDisplay = typeof cfg.signOff === 'object' && cfg.signOff ? (cfg.signOff.name || '') : (cfg.signOff || '');
  const facts = {
    project: state.project.name,
    date: new Date().toISOString().slice(0, 10),
    signOffName: signOffDisplay,
    signOffAliases: signOffTokens(cfg.signOff, cfg.signOffAliases),
    targets: targets.map((t) => ({
      name: t.name, chain: t.chain || '', protocolType: t.protocolType, inScope: t.inScope || t.scope || '', outOfScope: t.outOfScope || '',
      disclosureChannel: t.disclosureChannel || '', securityContact: t.securityContact || '', severityScale: t.severityScale || '', bountyRules: t.bountyRules || '',
      ...(t.repoUrl ? { repoUrl: t.repoUrl } : {}), ...(t.commit ? { commit: t.commit } : {}),
    })),
    findings: included.map(findingFacts),
    leftOut: r.excluded,
    checkedFine,
    notReviewed,
  };

  const missingFix = included.filter((f) => !f.fix).map((f) => f.title);
  const instructions = [
    `Write ${r.shape === 'separate' ? `one report per finding (${r.documents.length})` : 'one combined report that covers every finding below'}. Follow the system prompt exactly.`,
    'Use only the facts here and what you can confirm in the code and tests. Do not invent addresses, amounts, checks or test results. If a fact the prompt asks for is missing, find it and put it on the board first (recon_update), or say plainly in the report that it was not measured.',
    missingFix.length ? `No suggested fix is recorded for: ${missingFix.join('; ')}. Work one out from the code, save it with recon_update fix="...", and include it.` : null,
    facts.signOffName ? `Sign off as ${facts.signOffName}.` : 'The human has not said whose name signs the report: ask with recon_propose before submitting.',
    'If the disclosure channel is a form with fields (for example a GitHub security advisory), submit fields: [{label, value}] instead of a body, in the order the platform uses.',
    `Submit with recon_submit_report: documents: [{ findingIds: [...], body: "..." }]${r.shape === 'separate' ? ', one per finding' : ''}. It is checked for markdown and for the severity in the opening; fix and resubmit if refused.`,
  ].filter(Boolean);

  return {
    skill: { id: skill.id, name: skill.name, systemPrompt: skill.body },
    instructions,
    write: r.documents.map((d) => ({ name: d.name, findingIds: d.findingIds, written: d.written, stale: d.stale })),
    facts,
    shape: r.shape,
    path: cfg.path || '',
  };
}

// ---------- checking what the agent wrote ----------

const BANNED_PHRASES = [
  [/i hope this (email|message) finds you well/i, 'drop the "I hope this email finds you well" opener'],
  [/for (the )?non-technical readers?/i, 'do not address "non-technical readers"; write in one voice'],
  [/to make (this|it) simple/i, 'do not say "to make this simple"'],
  [/here is the (plain[- ]english|technical) version/i, 'do not split into a plain and a technical version'],
  [/potentially catastrophic|critical infrastructure risk/i, 'replace vague intensifiers with the specific, bounded impact'],
];

// Extract accepted sign-off tokens from a string ("alice (Alice)") or { name, aliases } + extra aliases.
export function signOffTokens(signOff, aliases = []) {
  const display = typeof signOff === 'object' && signOff ? String(signOff.name || '') : String(signOff || '');
  const extra = [
    ...(typeof signOff === 'object' && Array.isArray(signOff?.aliases) ? signOff.aliases : []),
    ...(Array.isArray(aliases) ? aliases : []),
  ];
  const out = new Set();
  const addFrom = (s) => {
    const clean = String(s || '').trim();
    if (!clean) return;
    out.add(clean.toLowerCase());
    for (const part of clean.split(/[\s(),/]+/).filter((w) => w.length >= 2)) out.add(part.toLowerCase());
  };
  addFrom(display);
  for (const a of extra) addFrom(a);
  return [...out];
}

const APPENDIX_RE = /^\s*-{3,}\s*(?:code\s+)?(?:appendix|proof of concept|poc)\b[^\n]*$/im;

export function splitProseAndAppendix(text) {
  const s = String(text || '');
  const m = APPENDIX_RE.exec(s);
  if (!m) return { prose: s, appendix: '' };
  return { prose: s.slice(0, m.index).trimEnd(), appendix: s.slice(m.index).trim() };
}

// Returns a list of problems; empty means it reads as the skill asks.
export function lintProse(text, { signOff = '', signOffAliases = [], label = 'the report', needSeverity = true } = {}) {
  const problems = [];
  const { prose } = splitProseAndAppendix(text);
  const s = String(prose || '');
  if (!s.trim()) return [`${label} is empty`];
  const lines = s.split('\n');
  const where = (i) => `line ${i + 1}: "${lines[i].trim().slice(0, 50)}"`;
  lines.forEach((line, i) => {
    if (/^\s{0,3}#{1,6}\s/.test(line)) problems.push(`${label}, ${where(i)}: a markdown header; write the heading into a sentence or drop it`);
    else if (/^\s*([-*+•]|\d+[.)])\s+\S/.test(line)) problems.push(`${label}, ${where(i)}: a list item; write it as part of a paragraph`);
    else if (/^\s*\|.*\|\s*$/.test(line)) problems.push(`${label}, ${where(i)}: a table row; describe it in sentences`);
    else if (/^\s*>\s/.test(line)) problems.push(`${label}, ${where(i)}: a quote block`);
  });
  if (/\*\*[^*\n]+\*\*|(^|[\s(])__[^_\n]+__(?=[\s.,;:)]|$)/m.test(s)) problems.push(`${label}: bold markup (** or __); remove it`);
  if (/(^|[\s(])\*[^*\s][^*\n]*[^*\s]\*(?=[\s.,;:)]|$)/m.test(s) || /(^|[\s(])_[^_\s][^_\n]*[^_\s]_(?=[\s.,;:)]|$)/m.test(s)) problems.push(`${label}: italic markup (*text* or _text_); remove it`);
  if (/`/.test(s)) problems.push(`${label}: backticks; write names like withdraw() as plain text (or put proof-of-concept code in the appendix field or after a "--- APPENDIX ---" line)`);
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(s)) problems.push(`${label}: a markdown link; write the URL out in the sentence`);
  for (const [re, msg] of BANNED_PHRASES) if (re.test(s)) problems.push(`${label}: ${msg}`);
  if (needSeverity) {
    const opening = s.replace(/^\s*(hi|hello|dear)[^\n]*\n/i, '').slice(0, 700);
    if (!/\b(critical|high|medium|moderate|low|informational|severity|not (a )?(serious|critical|severe))\b/i.test(opening)) {
      problems.push(`${label}: give your honest severity in the first two or three sentences`);
    }
  }
  const display = typeof signOff === 'object' && signOff ? String(signOff.name || '') : String(signOff || '');
  const tokens = signOffTokens(signOff, signOffAliases);
  if (tokens.length) {
    const paras = s.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const tail = paras[paras.length - 1] || s.slice(-400);
    const low = tail.toLowerCase();
    if (!tokens.some((tok) => low.includes(tok))) {
      problems.push(`${label}: sign off by name (${display || tokens[0]}) at the end - looked for ${tokens.slice(0, 4).join(' or ')} in the last prose paragraph (${tail.length} chars)`);
    }
  }
  return problems;
}

// Validate and normalize submitted documents against what the report needs.
// Returns { docs, problems }.
export function checkSubmission(state, documents) {
  const r = buildReport(state);
  const cfg = reportConfig(state);
  const problems = [];
  if (!Array.isArray(documents) || !documents.length) return { docs: [], problems: ['send documents: [{ findingIds, body }]'] };
  const byKey = new Map(r.documents.map((d) => [d.key, d]));
  const out = [];
  documents.forEach((doc, i) => {
    const label = documents.length > 1 ? `document ${i + 1}` : 'the report';
    let ids = [].concat(doc?.findingIds || doc?.findingId || []).filter(Boolean);
    if (!ids.length && r.documents.length === 1) ids = r.documents[0].findingIds;
    const unknown = ids.filter((id) => !r.included.some((f) => f.id === id));
    if (unknown.length) {
      for (const id of unknown) {
        const ex = r.excluded.find((x) => x.id === id);
        problems.push(ex ? `${label}: "${ex.title}" cannot be reported yet: ${ex.reasons.join('; ')}` : `${label}: no reportable finding ${id}`);
      }
      return;
    }
    const key = r.shape === 'separate' ? ids[0] : 'combined';
    if (r.shape === 'separate' && ids.length !== 1) { problems.push(`${label}: the human chose one report per finding; send one finding id per document`); return; }
    const want = byKey.get(key);
    if (!want) { problems.push(`${label}: does not match any report that is due`); return; }
    if (r.shape === 'combined') {
      const left = want.findingIds.filter((id) => !ids.includes(id));
      if (left.length) problems.push(`${label}: the combined report must cover every reportable finding; missing ${left.map((id) => `"${state.items.finding[id].title}"`).join(', ')}`);
    }
    let fields = null;
    let body = '';
    const appendix = typeof doc.appendix === 'string' ? doc.appendix.replace(/\r\n/g, '\n').trim() : '';
    if (Array.isArray(doc.fields) && doc.fields.length) {
      fields = doc.fields.map((f) => ({ label: String(f?.label || '').trim(), value: String(f?.value || '').trim() })).filter((f) => f.label);
      for (const f of fields) problems.push(...lintProse(f.value, { label: `${label}, field "${f.label}"`, needSeverity: false }));
      body = fields.map((f) => `${f.label}\n\n${f.value}`).join('\n\n\n');
    } else {
      body = String(doc.body || '').replace(/\r\n/g, '\n').trim();
      problems.push(...lintProse(body, { label, signOff: cfg.signOff, signOffAliases: cfg.signOffAliases }));
    }
    out.push({ key, shape: r.shape, name: want.name, findingIds: want.findingIds, body, appendix, fields, disclosureState: 'draft' });
  });
  return { docs: out, problems };
}

// Prepare a human-ready disclosure handoff after a report is saved. Recon never sends it automatically.
export function buildHandoff(state, docs = []) {
  const targets = Object.values(state.items.target || {});
  const primary = targets[0] || null;
  const emailMatch = (s) => String(s || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const to = primary?.securityContact?.trim() || emailMatch(primary?.disclosureChannel) || primary?.disclosureChannel?.trim() || '';
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
  return docs.map((d) => {
    const firstFinding = state.items.finding?.[d.findingIds?.[0]];
    const subject = d.shape === 'separate' && firstFinding
      ? `Security disclosure: ${primary?.name || state.project.name} - ${firstFinding.title}`
      : `Security disclosure: ${primary?.name || state.project.name} (${(d.findingIds || []).length} finding${(d.findingIds || []).length === 1 ? '' : 's'})`;
    const fullBody = d.appendix ? `${d.body}\n\n--- APPENDIX ---\n\n${d.appendix}` : d.body;
    const mailto = isEmail ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fullBody.slice(0, 1800))}` : null;
    return {
      key: d.key,
      name: d.name,
      to,
      channel: primary?.disclosureChannel || to || '',
      subject,
      body: fullBody,
      mailto,
      disclosureState: d.disclosureState || 'draft',
      nextSteps: to
        ? `Review the saved report and send it to ${to} yourself (recon never sends disclosures automatically). Then mark it "sent" in the Report panel.`
        : 'Set securityContact or disclosureChannel on the target, review the saved report, send it yourself, and mark it "sent" in the Report panel.',
    };
  });
}
