// recon as an MCP server (stdio, JSON-RPC 2.0, newline-delimited).
//
// It is a thin client of the hub, so many agents can share one board. If no hub
// is running on the default local address, it starts one in-process (serving the
// web ui too), so `recon mcp` on its own is a complete, zero-config setup.
//
// stdout carries the protocol; every log line goes to stderr.

import readline from 'node:readline';
import { createClient, defaultUrl, ReconError } from './client.js';
import fs from 'node:fs';
import path from 'node:path';
import { ENUMS } from './model.js';
import { applyMap } from './mapping.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const evidenceSchema = {
  type: 'array',
  description: 'What backs the claim. Each entry: the file:line, function, tx hash or link you looked at, and what it shows.',
  items: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'e.g. "contracts/Vault.sol:120", a test name like "test_Drain", a tx hash, a url' },
      note: { type: 'string', description: 'What this shows, in a sentence' },
      kind: { type: 'string', enum: ENUMS.evidenceKind, description: 'code = file:line; test = a unit/fuzz test; fork = a fork run against live bytecode; tx = a transaction' },
      rpc: { type: 'string', description: 'fork evidence: which network/rpc' },
      block: { type: 'string', description: 'fork evidence: block number' },
      result: { type: 'string', description: 'test or fork result, e.g. "pass"' },
    },
    required: ['ref'],
  },
};

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const en = (name, description) => ({ type: 'string', enum: ENUMS[name], description });

export const TOOLS = [
  {
    name: 'recon_briefing',
    description: 'Start here, and call again whenever you finish a task. Returns the human\'s open steers for you (act on these first), claims of yours the human disputed, components you own, untouched attack surface, the protocol playbook for each target (usual exploit classes and checks), suggested next moves, and the rules of the board.',
    inputSchema: { type: 'object', properties: {} },
    run: (c) => c.briefing(),
  },
  {
    name: 'recon_start_engagement',
    description: 'Start a real engagement when the board only holds the built-in example (recon_briefing says so). Name it after what you are researching. It never wipes a real engagement.',
    inputSchema: { type: 'object', properties: { name: str('e.g. "Acme Vault review"') }, required: ['name'] },
    run: async (c, a, ctx = {}) => {
      const r = await c.start(a.name);
      ctx.setHunt?.(r.hunt?.name || a.name);
      return { ...r, note: r.onScreen === false ? 'Started in the background: the human is looking at another hunt. Your work lands here; the board offers them a switch.' : undefined };
    },
  },
  {
    name: 'recon_list',
    description: 'List items of one kind, optionally filtered by a field (e.g. kind=component, targetId=..., reviewState=untouched).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['target', 'component', 'relation', 'assumption', 'hypothesis', 'finding', 'chain', 'lead', 'steer', 'proposal', 'agent'] },
        filter: { type: 'object', description: 'field -> value, exact match', additionalProperties: { type: 'string' } },
      },
      required: ['kind'],
    },
    run: async (c, a) => (await c.list(a.kind, a.filter || {})).map(compact),
  },
  {
    name: 'recon_get',
    description: 'Get one item by id or by name, with its full evidence, history, and (for components) the playbook checklist with check ids.',
    inputSchema: { type: 'object', properties: { ref: str('An id like "cp_..." or a name like "Vault.withdraw()"') }, required: ['ref'] },
    run: async (c, a) => {
      const { kind, item } = await c.resolve(a.ref);
      return c.get(kind, item.id);
    },
  },
  {
    name: 'recon_add_target',
    description: 'Add a target (a protocol or system under research) and optionally its attack surface in one call. protocolType selects the playbook.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('e.g. "Acme Lending"'),
        protocolType: en('protocolType', 'Drives the playbook of usual exploit classes'),
        chain: str('e.g. "mainnet"'),
        description: str('One paragraph on what it does'),
        scope: str('In-scope paths or contracts'),
        components: {
          type: 'array',
          items: { type: 'object', properties: { name: str('e.g. "Vault.withdraw()"'), type: en('componentKind', 'What kind of piece'), location: str('path:line') }, required: ['name'] },
        },
      },
      required: ['name'],
    },
    run: async (c, a) => {
      const { components = [], ...fields } = a;
      const t = await c.create('target', fields);
      const comps = [];
      for (const comp of components) comps.push(compact(await c.create('component', { ...comp, targetId: t.id })));
      return { target: compact(t), components: comps };
    },
  },
  {
    name: 'recon_map',
    description: 'Phase 1, before any vulnerability research: map how the system fits together. Add every contract/function, actor (type "actor": users, admins, keepers, liquidators) and external dependency (type "external": tokens, oracles, other protocols) with a one-line summary, and the relations between them. Components are matched by name, so calling this again extends or corrects the map. Relation types: calls, delegates, inherits, reads, writes, transfers, mints, owns, configures, trusts.',
    inputSchema: {
      type: 'object',
      properties: {
        target: str('Target id or name'),
        components: {
          type: 'array',
          items: { type: 'object', properties: { name: str('e.g. "Vault.withdraw()", "Keeper", "USDC"'), type: en('componentKind', 'contract/function for code; actor for people and roles; external for dependencies'), summary: str('What it does, one line'), location: str('path:line') }, required: ['name'] },
        },
        relations: {
          type: 'array',
          items: { type: 'object', properties: { from: str('Component name'), to: str('Component name'), type: en('relationKind', 'How they connect'), label: str('e.g. "transferFrom user", "onlyOwner"') }, required: ['from', 'to'] },
        },
      },
      required: ['target'],
    },
    run: async (c, a) => {
      const r = await applyMap(c, a.target, a);
      return { ...r, next: r.unconnected.length ? `Not connected to anything yet: ${r.unconnected.join(', ')}. Add how they call, transfer to, read from, own or trust the rest.` : r.phase === 'mapping' ? 'When the map is complete, call recon_phase with phase "assumptions".' : undefined };
    },
  },
  {
    name: 'recon_scan',
    description: 'Phase 1 shortcut: read the Solidity source in this project and put a first architecture map on the board: contracts, inheritance, which contract calls which (with function names), token transfers, reads, low-level calls back to the caller, calls to arbitrary addresses, and who may call what (onlyX modifiers, require(msg.sender == x), unrestricted functions). Then refine it with recon_map: add what the scan cannot see (off-chain actors, trust, intent).',
    inputSchema: { type: 'object', properties: { target: str('Target id or name'), path: str('Folder with the .sol files (default: this project)'), includeTests: { type: 'boolean' } }, required: ['target'] },
    run: async (c, a, ctx = {}) => {
      if (!ctx.canWriteFiles) return { error: 'this connection cannot read your files; run `recon scan <folder> --target <name>` on your machine instead' };
      const { scanSolidity } = await import('./scan.js');
      const root = path.resolve(ctx.cwd || process.cwd(), a.path || '.');
      const map = scanSolidity(root, { includeTests: a.includeTests });
      if (!map.files.length) return { error: `no .sol files under ${root}` };
      const r = await applyMap(c, a.target, map);
      return { scanned: map.files, found: { parts: map.components.length, connections: map.relations.length }, ...r };
    },
  },
  {
    name: 'recon_phase',
    description: 'Move a target to the next phase once the current one is done: mapping -> assumptions -> hunting -> reporting.',
    inputSchema: { type: 'object', properties: { target: str('Target id or name'), phase: en('phase', 'The phase to move to') }, required: ['target', 'phase'] },
    run: async (c, a) => {
      const t = (await c.resolve(a.target, 'target')).item;
      return compact(await c.update('target', t.id, { phase: a.phase }));
    },
  },
  {
    name: 'recon_add_component',
    description: 'Add a piece of attack surface (contract, function, endpoint...) to a target.',
    inputSchema: {
      type: 'object',
      properties: { targetId: str('Target id or name'), name: str('e.g. "Vault.withdraw()"'), type: en('componentKind', 'What kind of piece'), summary: str('What it does, one line'), location: str('path:line') },
      required: ['targetId', 'name'],
    },
    run: async (c, a) => {
      const t = await c.resolve(a.targetId, 'target');
      return compact(await c.create('component', { ...a, targetId: t.item.id }));
    },
  },
  {
    name: 'recon_coverage',
    description: 'Record review progress on a component: set its review state (untouched, scanning, reviewed, flagged), your reasoning, evidence, and checklist results. Set "scanning" when you start, "reviewed" or "flagged" when done. Always attach evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        component: str('Component id or name'),
        reviewState: en('reviewState', 'untouched | scanning | reviewed (nothing found) | flagged (something smells)'),
        reasoning: str('What you checked and concluded'),
        evidence: evidenceSchema,
        checklist: { type: 'object', description: 'checklist id (from recon_get) -> checked | na | unchecked', additionalProperties: { type: 'string', enum: ENUMS.checkState } },
        hypothesis: {
          type: 'object', description: 'Required when flagging: the testable claim behind the smell. Created on this component before the flag.',
          properties: { text: str('The suspected bug'), bugClass: str('e.g. reentrancy'), confidence: en('confidence', 'low | med | high'), exploitStage: en('exploitStage', 'capability | trigger | full') },
          required: ['text'],
        },
      },
      required: ['component'],
    },
    run: async (c, a) => {
      const { item } = await c.resolve(a.component, 'component');
      if (a.hypothesis?.text) await c.create('hypothesis', { ...a.hypothesis, componentId: item.id, targetId: item.targetId, evidence: a.evidence });
      const fields = pick(a, ['reviewState', 'reasoning', 'evidence', 'checklist']);
      const out = await c.update('component', item.id, fields);
      if (a.reviewState === 'scanning') await c.heartbeat({ focus: `Reviewing ${item.name}`, focusItem: item.id }).catch(() => {});
      return compact(out);
    },
  },
  {
    name: 'recon_add_assumption',
    description: 'Record an assumption so the human can challenge it. In phase 2 record what the DEVELOPERS assume (origin "developer"): trust model, invariants, expected inputs and tokens, external dependencies. Later, record what you yourself take for granted (origin "agent"). Include why it seems true.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('e.g. "Only the owner can call setFee()"'), targetId: str('Target id'), componentId: str('Component id'),
        origin: en('assumptionOrigin', 'developer: what the code\'s authors assume. agent: what you assume'),
        category: en('assumptionCategory', 'trust | invariant | input | external | economic | other'),
        scope: str('Where it applies'), rationale: str('Why it seems true'), evidence: evidenceSchema,
      },
      required: ['text'],
    },
    run: async (c, a) => compact(await c.create('assumption', await resolveRefs(c, a))),
  },
  {
    name: 'recon_add_hypothesis',
    description: 'Record a suspected bug you are about to test. Ask yourself first: is this a capability without a trigger? Update it later with recon_update (status confirmed needs code + test/fork/tx evidence; or dropped + dropReason).',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('The suspected bug in one sentence'), targetId: str('Target id'), componentId: str('Component id'),
        bugClass: str('An exploit class id from the playbook, e.g. "reentrancy"'), confidence: en('confidence', 'low | med | high'),
        exploitStage: en('exploitStage', 'capability: the power exists but no public path makes it fire yet. trigger: you found the path, impact unproven. full: trigger plus impact. Only full can become a finding.'),
        trigger: str('The public call path that makes it fire, once found'),
        reasoning: str('Why you suspect it'), evidence: evidenceSchema,
      },
      required: ['text', 'exploitStage'],
    },
    run: async (c, a) => compact(await c.create('hypothesis', await resolveRefs(c, a))),
  },
  {
    name: 'recon_add_finding',
    description: 'Record a confirmed vulnerability. It is refused until its confirmation card is complete (attacker, reachability, bound, liveFunds, alreadyReported, verificationMethod), its severity is earned (Critical: permissionless + measured live funds; High: an outsider path), it is not a duplicate of an existing finding (same component + bug class: add evidence or a chain instead), and its source hypothesis is exploitStage "full".',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line'), severity: en('severity', 'critical | high | medium | low | info'),
        targetId: str('Target id'), componentId: str('Component id'), hypothesisId: str('Source hypothesis id'),
        bugClass: str('e.g. "rounding"'), stage: en('findingStage', 'Usually "testing" until reproduced'),
        notes: str('Impact and root cause'), repro: str('Steps or test that reproduces it'), fix: str('A concrete fix an engineer could implement from this description'), evidence: evidenceSchema,
        attacker: en('attacker', 'Who can do it: stranger, holder, privileged, admin'),
        reachability: en('reachability', 'permissionless, needs-role, needs-config (a setting the team chose), needs-social'),
        bound: str('One sentence on what still cannot happen'),
        liveFunds: str('"none", "unknown", or address + amount at risk now'),
        liveFundsMethod: en('fundsMethod', 'How liveFunds was measured'),
        alreadyReported: en('reported', 'Did you check prior reports and audits?'),
        alreadyReportedRef: str('The report/audit you checked, or "distinct: <how it differs>"'),
        verificationMethod: en('verifyMethod', 'How you verified it'),
        testName: str('The test that proves it, e.g. test_ReentrantDrain'),
        testResult: en('testResult', 'Result of the last run'),
        productionTouched: { type: 'boolean', description: 'Did you send anything to mainnet/production? Default false.' },
        productionNote: str('If production was touched: why it was necessary and safe'),
      },
      required: ['title', 'severity', 'attacker', 'reachability', 'bound', 'liveFunds', 'alreadyReported', 'verificationMethod'],
    },
    run: async (c, a) => compact(await c.create('finding', await resolveRefs(c, a))),
  },
  {
    name: 'recon_update',
    description: 'Update fields on any item you own: e.g. hypothesis status (testing | confirmed | dropped) and dropReason, assumption state (assumed | verified | invalidated), finding stage or repro, confidence. You cannot set verification or priority; those belong to the human.',
    inputSchema: {
      type: 'object',
      properties: { ref: str('Item id or name'), fields: { type: 'object', description: 'field -> new value' } },
      required: ['ref', 'fields'],
    },
    run: async (c, a) => {
      const { kind, item } = await c.resolve(a.ref);
      return compact(await c.update(kind, item.id, a.fields));
    },
  },
  {
    name: 'recon_evidence',
    description: 'Attach evidence to any item (component, assumption, hypothesis, finding). Use this to strengthen a claim the human disputed.',
    inputSchema: {
      type: 'object',
      properties: { ref: str('Item id or name'), evidence: evidenceSchema },
      required: ['ref', 'evidence'],
    },
    run: async (c, a) => {
      const { kind, item } = await c.resolve(a.ref);
      const out = await c.evidence(kind, item.id, a.evidence);
      return { id: out.id, evidence: out.evidence.length };
    },
  },
  {
    name: 'recon_steer',
    description: 'Respond to a human steer. Acknowledge as soon as you see it (state=acknowledged), then mark it addressed with a short response when done. Steers never require you to stop current work.',
    inputSchema: {
      type: 'object',
      properties: {
        steerId: str('The steer id from recon_briefing'),
        state: { type: 'string', enum: ['acknowledged', 'addressed'] },
        response: str('What you did or found, in a sentence or two'),
      },
      required: ['steerId', 'state'],
    },
    run: async (c, a) => compact(await c.steer(a.steerId, a.state === 'addressed' ? 'address' : 'ack', a.response)),
  },
  {
    name: 'recon_propose',
    description: 'Propose your next move to the human instead of going idle, going rogue, or asking in chat. Give options when there is a real choice; the human picks one with a click. Accepted proposals come back as acknowledged steers in recon_briefing.',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('What you want to do next'), rationale: str('Why it is worth it'),
        itemId: str('The item it concerns, if any'), steerKind: en('steerKind', 'The kind of work it is'),
        options: { type: 'array', items: { type: 'string' }, description: 'Choices for the human to pick from with one click, e.g. ["Send the combined report", "Split: High first, then Mediums", "Keep hunting TVL first"]' },
      },
      required: ['text'],
    },
    run: async (c, a) => {
      const fields = { ...a };
      if (a.itemId) { const r = await c.resolve(a.itemId); fields.itemId = r.item.id; fields.itemKind = r.kind; }
      return compact(await c.create('proposal', fields));
    },
  },
  {
    name: 'recon_focus',
    description: 'Tell the board what you are doing right now. Shows as your live status and moves your marker on the map.',
    inputSchema: {
      type: 'object',
      properties: { focus: str('e.g. "Tracing withdraw() for reentrancy"'), item: str('Component or item id/name you are on'), status: en('agentStatus', 'Set "stuck" to ask for help') },
      required: ['focus'],
    },
    run: async (c, a) => {
      const fields = { focus: a.focus };
      if (a.status) fields.status = a.status;
      if (a.item) fields.focusItem = (await c.resolve(a.item)).item.id;
      return compact(await c.heartbeat(fields));
    },
  },
  {
    name: 'recon_claim',
    description: 'Claim components so other agents do not duplicate your work. Claims fail for components another agent owns.',
    inputSchema: { type: 'object', properties: { components: { type: 'array', items: { type: 'string' }, description: 'Component ids or names' } }, required: ['components'] },
    run: async (c, a) => {
      const ids = [];
      for (const r of a.components) ids.push((await c.resolve(r, 'component')).item.id);
      return c.claim(ids);
    },
  },
  {
    name: 'recon_add_lead',
    description: 'Record an open thread: something worth doing that is not done yet (blocked by an RPC limit, needs a live NFT, needs the audit PDF...). Record every one before you stop so nothing is forgotten. Update it later with recon_update (state done / dropped / blocked, outcome).',
    inputSchema: {
      type: 'object',
      properties: {
        text: str('What is left to do'), why: str('Why it matters: what it would prove or change'),
        value: en('value', 'high | med | low'), state: en('leadState', 'open or blocked'),
        blockedBy: str('What is in the way, if blocked'), nextStep: str('The concrete next action'),
        targetId: str('Target id or name'), componentId: str('Component id or name'), itemId: str('A related hypothesis/finding id'),
      },
      required: ['text', 'value'],
    },
    run: async (c, a) => compact(await c.create('lead', await resolveRefs(c, a))),
  },
  {
    name: 'recon_add_chain',
    description: 'Link hypotheses/findings that combine into a stronger issue, instead of filing a second finding. A chain raises severity only if the glue is something an attacker controls (gluePermissionless).',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('One line'), parts: { type: 'array', items: { type: 'string' }, description: 'Hypothesis or finding ids (at least two)' },
        glue: en('chainGlue', 'How they combine'), gluePermissionless: { type: 'boolean', description: 'Can an outsider force the combination?' },
        result: str('The extra impact no single part has'), severity: en('severity', 'Severity of the combination'), targetId: str('Target id or name'),
      },
      required: ['title', 'parts', 'glue', 'result'],
    },
    run: async (c, a) => compact(await c.create('chain', await resolveRefs(c, a))),
  },
  {
    name: 'recon_check_finding',
    description: 'Re-run every gate on a finding: confirmation card, evidence, severity, passing test, duplicates, already reported. Call before reporting it.',
    inputSchema: { type: 'object', properties: { ref: str('Finding id or title') }, required: ['ref'] },
    run: async (c, a) => c.checkFinding((await c.resolve(a.ref, 'finding')).item.id),
  },
  {
    name: 'recon_write_report',
    description: 'Start writing the disclosure report. Returns the human\'s report-writing skill (use its systemPrompt as your instructions for this writing), the facts from the board it asks for (findings with their card, evidence and suggested fix, what was checked and held, what was not reviewed, scope, disclosure channel, bounty rules, whose name signs it) and which documents are due. Write the prose yourself, then call recon_submit_report. Refused until the human has chosen combined or separate: ask with recon_propose and options first. Never draft reports in chat.',
    inputSchema: { type: 'object', properties: {} },
    run: (c) => c.reportBrief(),
  },
  {
    name: 'recon_submit_report',
    description: 'Submit the report you wrote from recon_write_report. One document for a combined report, one per finding for separate. Plain prose (no markdown symbols), severity in the opening sentences, signed by name; for form-based channels (GitHub security advisory) send fields instead of body. Refused with the exact problems if it does not follow the skill: fix them and resubmit. Saved on the board and, when a report path is set, written there as .txt files.',
    inputSchema: {
      type: 'object',
      properties: {
        documents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              findingIds: { type: 'array', items: { type: 'string' }, description: 'The findings this document covers (from the brief)' },
              body: str('The report, plain prose'),
              fields: { type: 'array', items: { type: 'object', properties: { label: str('e.g. Title, Summary, Details, Proof of Concept, Impact, Affected products, Severity, CWE'), value: str() }, required: ['label', 'value'] }, description: 'Instead of body, for channels that use form fields' },
            },
            required: ['findingIds'],
          },
        },
      },
      required: ['documents'],
    },
    run: async (c, a, ctx = {}) => {
      const r = await c.submitReport(a.documents);
      const where = r.config.path;
      const summary = { written: r.written, stillMissing: r.missing, stale: r.stale };
      if (!ctx.canWriteFiles || !where) return { ...summary, note: where ? 'Saved on the board. This connection cannot write files; the human can download them from the Report window.' : 'Saved on the board. No report path is set; the human can download it from the Report window.' };
      const base = path.resolve(ctx.cwd || process.cwd(), where);
      const files = [];
      const docs = r.documents.filter((d) => r.written.includes(d.name));
      const single = docs.length === 1 && r.shape === 'combined' && /\.(txt|md)$/i.test(base);
      for (const d of docs) {
        const target = single ? base : path.join(base, d.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${d.body}\n`);
        files.push(target);
      }
      return { ...summary, files };
    },
  },
  {
    name: 'recon_skill',
    description: 'The human\'s skills: reusable instructions they keep for agents (how they want reports written, how they audit a protocol type, house rules). Without a name, lists them; with a name, returns the instructions to follow. The briefing lists them too.',
    inputSchema: { type: 'object', properties: { name: str('Skill id or name') } },
    run: async (c, a) => (a.name ? c.skill(a.name) : (await c.skills()).skills.map(({ id, name, description, use }) => ({ id, name, description, use }))),
  },
  {
    name: 'recon_playbook',
    description: 'The playbook for a protocol type: what usually goes wrong, plain explanations, and concrete checks with ids.',
    inputSchema: { type: 'object', properties: { protocolType: en('protocolType', 'Protocol type') }, required: ['protocolType'] },
    run: (c, a) => c.playbook(a.protocolType),
  },
];

const INSTRUCTIONS = `recon: a shared board where you and a human research vulnerabilities together.
1. Call recon_briefing first, and again between tasks. Do its mustDo list top to bottom.
2. Acknowledge every open steer at once (recon_steer). Until you do, findings, coverage and focus writes are refused.
3. Work each target in order: map it (recon_scan, then recon_map for what the scan cannot see), record the developers' assumptions, then hunt.
4. Every claim needs evidence. Findings need a complete confirmation card and earned severity.
5. Never leave loose ends in chat: record open threads with recon_add_lead and choices with recon_propose options.
6. The human keeps skills (recon_skill): follow the ones that fit. Reports are written with recon_write_report, which hands you their report skill as your instructions.
Never set verification or priority; those belong to the human.`;

function compact(it) {
  if (!it || typeof it !== 'object') return it;
  const { _f, ...rest } = it;
  if (Array.isArray(rest.evidence)) rest.evidence = rest.evidence.map(({ ref, note, kind }) => ({ ref, note, kind }));
  return rest;
}

// Agents often pass names instead of ids; resolve them, and infer the target from the component.
async function resolveRefs(c, a) {
  const out = { ...a };
  const refs = { targetId: 'target', componentId: 'component', hypothesisId: 'hypothesis' };
  for (const [field, kind] of Object.entries(refs)) {
    if (out[field]) out[field] = (await c.resolve(out[field], kind)).item.id;
  }
  if (out.componentId && !out.targetId) {
    const comp = await c.resolve(out.componentId, 'component');
    out.targetId = comp.item.targetId;
  }
  return out;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

// The protocol itself, shared by the stdio server and the hub's HTTP /mcp endpoint.
// Returns the JSON-RPC response for a request, or null for a notification.
export async function dispatch(msg, { getClient, onInitialize, ctx = {} } = {}) {
  if (!msg || msg.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const ok = (result) => (isRequest ? { jsonrpc: '2.0', id, result } : null);
  const fail = (code, message) => (isRequest ? { jsonrpc: '2.0', id, error: { code, message } } : null);
  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        onInitialize?.(params);
        return ok({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'recon', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      // The human's skills, offered as prompts the client can show (e.g. as slash commands).
      case 'prompts/list': {
        const { skills } = await (await getClient()).skills();
        return ok({ prompts: skills.map((x) => ({ name: x.id, title: x.name, description: x.description })) });
      }
      case 'prompts/get': {
        const x = await (await getClient()).skill(params?.name);
        return ok({ description: x.description, messages: [{ role: 'user', content: { type: 'text', text: x.body } }] });
      }
      case 'tools/list':
        return ok({ tools: TOOLS.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `unknown tool ${params?.name}`);
        try {
          const client = await getClient();
          const result = await tool.run(client, params.arguments || {}, ctx);
          const content = [{ type: 'text', text: JSON.stringify(result, null, 1) }];
          if (tool.name !== 'recon_briefing' && tool.name !== 'recon_playbook') {
            try { const p = await client.pulse(); if (p?.pulse) content.push({ type: 'text', text: p.pulse }); } catch { /* the board can still answer next time */ }
          }
          return ok({ content });
        } catch (err) {
          const detail = err instanceof ReconError && err.details ? `\n${[].concat(err.details).join('\n')}` : '';
          return ok({ content: [{ type: 'text', text: `error: ${err.message}${detail}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, err.message);
  }
}

export async function runMcp({ name = process.env.RECON_AGENT || 'agent', url, key, model, hunt = null, input = process.stdin, output = process.stdout, log = (...a) => console.error(...a), embed = true } = {}) {
  const hubUrl = (url || defaultUrl()).replace(/\/$/, '');
  let client = createClient({ url: hubUrl, key, agent: name, transport: 'mcp', model });
  let huntName = hunt;
  let embedded = null;

  // Reach the hub. Locally, start one in the background so the board outlives this
  // agent session; fall back to an in-process hub if that is not possible.
  async function ensureHub() {
    try { await client.health(); return; } catch (err) {
      const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(hubUrl);
      if (!embed || !local) { log(`recon mcp: ${err.message}`); return; }
    }
    try {
      const { ensureHub: launch } = await import('./launch.js');
      await launch({ url: hubUrl, key, log });
      return;
    } catch (err) {
      log(`recon mcp: could not start a background hub (${err.message}); running one in-process`);
    }
    const { createHub } = await import('./hub.js');
    const port = Number(new URL(hubUrl).port || 4317);
    embedded = createHub({ port, log });
    await embedded.listen();
    log(`recon mcp: started a local hub at ${embedded.url}`);
    client = createClient({ url: embedded.url, key, agent: name, transport: 'mcp', model });
  }

  // Work in the hunt named after this project: start or resume it once the hub is up.
  async function enterHunt() {
    if (!huntName) return;
    try {
      const r = await client.start(huntName);
      huntName = r.hunt?.name || huntName;
      client = createClient({ url: client.url, key, agent: name, transport: 'mcp', model, hunt: huntName });
      log(`recon mcp: working in the hunt "${huntName}"${r.onScreen === false ? ' (in the background; the board offers a switch)' : ''}`);
    } catch (err) { log(`recon mcp: could not open the hunt "${huntName}": ${err.message}`); huntName = null; }
  }

  const hubReady = ensureHub().catch((err) => log(`recon mcp: ${err.message}`)).then(() => enterHunt());

  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);

  async function handle(msg) {
    const res = await dispatch(msg, {
      ctx: {
        canWriteFiles: true, cwd: process.cwd(),
        setHunt: (h) => { huntName = h; client = createClient({ url: client.url, key, agent: name, transport: 'mcp', model, hunt: h }); },
      },
      getClient: async () => { await hubReady; return client; },
      onInitialize: () => hubReady.then(() => client.heartbeat({}).catch(() => {})),
    });
    if (res) send(res);
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  });

  return new Promise((resolve) => {
    rl.on('close', async () => {
      if (embedded) await embedded.close();
      resolve();
    });
  });
}
