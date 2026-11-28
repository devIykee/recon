// recon data model.
//
// Every entity kind, every field, every enum lives here so the hub, the cli,
// the mcp server and the web ui all agree. Agents can rely on these values:
// they are fixed and documented in docs/MODEL.md.

export const ENUMS = Object.freeze({
  transport: ['mcp', 'cli', 'api', 'json', 'demo', 'ui'],
  agentStatus: ['active', 'idle', 'stuck', 'offline'],
  protocolType: [
    'lending', 'amm', 'perps', 'bridge', 'staking', 'nft-market',
    'governance', 'oracle', 'token', 'vault', 'factory', 'dao-module', 'nft-custody', 'naming', 'other',
  ],
  componentKind: ['contract', 'function', 'module', 'endpoint', 'storage', 'config', 'actor', 'external', 'other'],
  relationKind: ['calls', 'delegates', 'inherits', 'reads', 'writes', 'transfers', 'mints', 'owns', 'configures', 'trusts', 'other'],
  phase: ['mapping', 'assumptions', 'hunting', 'reporting'],
  assumptionOrigin: ['developer', 'agent'],
  assumptionCategory: ['trust', 'invariant', 'input', 'external', 'economic', 'other'],
  reviewState: ['untouched', 'scanning', 'reviewed', 'flagged'],
  assumptionState: ['assumed', 'verified', 'invalidated'],
  confidence: ['low', 'med', 'high'],
  hypothesisStatus: ['testing', 'confirmed', 'dropped'],
  severity: ['critical', 'high', 'medium', 'low', 'info'],
  findingStage: ['recon', 'testing', 'reported', 'acknowledged', 'fixed', 'disclosed'],
  steerKind: ['recheck', 'challenge', 'cover', 'verify', 'priority', 'note'],
  steerState: ['open', 'queued', 'acknowledged', 'waiting-on-human', 'addressed'],
  proposalState: ['pending', 'accepted', 'declined'],
  leadState: ['open', 'blocked', 'done', 'dropped'],
  ruleCategory: ['conservation', 'solvency', 'accounting', 'bound', 'access', 'ordering', 'other'],
  ruleStatus: ['untested', 'holds', 'broken', 'inconclusive'],
  ruleEngine: ['foundry-invariant', 'foundry-fuzz', 'halmos', 'hevm', 'echidna', 'medusa', 'certora', 'kontrol', 'manual'],
  value: ['high', 'med', 'low'],
  verification: ['unverified', 'verified', 'disputed'],
  priority: ['low', 'normal', 'high', 'urgent'],
  evidenceKind: ['code', 'test', 'fork', 'tx', 'log', 'link', 'note'],
  attacker: ['stranger', 'holder', 'privileged', 'admin'],
  reachability: ['permissionless', 'needs-role', 'needs-config', 'needs-social'],
  fundsMethod: ['eth_call', 'fork', 'explorer', 'not-measured'],
  reported: ['no', 'yes', 'unknown'],
  verifyMethod: ['fork', 'eth_call', 'unit', 'fuzz', 'live-tx', 'manual'],
  testResult: ['pass', 'fail', 'not-run'],
  exploitStage: ['capability', 'trigger', 'full'],
  chainGlue: ['same-tx', 'same-caller', 'config+code', 'social+code', 'other'],
  reportShape: ['combined', 'separate'],
  checkState: ['unchecked', 'checked', 'na'],
});

export const KINDS = Object.freeze([
  'agent', 'target', 'component', 'relation', 'assumption', 'hypothesis', 'finding', 'chain', 'steer', 'proposal', 'lead', 'message', 'rule',
]);

// Component types that describe the system but are not attack surface to review.
export const MAP_ONLY_TYPES = new Set(['actor', 'external']);
export const isReviewable = (c) => !MAP_ONLY_TYPES.has(c?.type);

// Who may write a field.
//   human  - only a human (verification, priority, assignment). Agents are rejected.
//   any    - humans and agents. Last write wins per field.
//   system - set by the hub only.
const H = 'human';
const A = 'any';

const str = (owner = A, extra = {}) => ({ type: 'string', owner, ...extra });
const en = (name, owner = A, def) => ({ type: 'string', enum: name, owner, default: def });
const arr = (owner = A) => ({ type: 'array', owner, default: [] });
const obj = (owner = A) => ({ type: 'object', owner, default: {} });
const num = (owner = A) => ({ type: 'number', owner });
const bool = (owner = A) => ({ type: 'boolean', owner });

// Fields every item carries.
export const SHARED_FIELDS = {
  evidence: { type: 'array', owner: A, default: [], merge: 'byId' },
  reasoning: str(),
  verification: en('verification', H, 'unverified'),
  priority: en('priority', H, 'normal'),
  meta: obj(),
};

export const SCHEMA = {
  agent: {
    name: str(A, { required: true }),
    color: str(),
    avatar: str(),
    transport: en('transport', A, 'api'),
    transports: arr(),
    status: en('agentStatus', A, 'active'),
    focus: str(),
    focusItem: str(),
    assignment: arr(H),
    model: str(),
    // non-secret summary of webhook wake configuration & last delivery status
    wake: obj(),
  },
  target: {
    name: str(A, { required: true }),
    chain: str(),
    protocolType: en('protocolType', A, 'other'),
    description: str(),
    focus: str(),
    scope: str(),
    phase: en('phase', A, 'mapping'),
    // what the program covers, so agents do not hunt or file out of scope
    inScope: str(),
    outOfScope: str(),
    alreadyReported: arr(),
    disclosureChannel: str(),
    securityContact: str(),
    severityScale: str(),
    bountyRules: str(),
    repoUrl: str(),
    commit: str(),
    playbooks: arr(),
    ignoredClasses: arr(),
  },
  component: {
    targetId: str(A, { required: true, ref: 'target' }),
    name: str(A, { required: true }),
    type: en('componentKind', A, 'contract'),
    reviewState: en('reviewState', A, 'untouched'),
    summary: str(),
    location: str(),
    owner: str(),
    checklist: { type: 'object', owner: A, default: {}, merge: 'byKey' },
    notes: str(),
    // from the scanner: each function, who may call it, and the state it writes and reads
    surface: arr(),
  },
  relation: {
    targetId: str(A, { required: true, ref: 'target' }),
    from: str(A, { required: true, ref: 'component' }),
    to: str(A, { required: true, ref: 'component' }),
    type: en('relationKind', A, 'calls'),
    label: str(),
  },
  assumption: {
    text: str(A, { required: true }),
    origin: en('assumptionOrigin', A, 'agent'),
    category: en('assumptionCategory', A, 'other'),
    targetId: str(A, { ref: 'target' }),
    componentId: str(A, { ref: 'component' }),
    scope: str(),
    state: en('assumptionState', A, 'assumed'),
    rationale: str(),
  },
  hypothesis: {
    text: str(A, { required: true }),
    targetId: str(A, { ref: 'target' }),
    componentId: str(A, { ref: 'component' }),
    bugClass: str(),
    confidence: en('confidence', A, 'low'),
    status: en('hypothesisStatus', A, 'testing'),
    dropReason: str(),
    findingId: str(A, { ref: 'finding' }),
    exploitStage: en('exploitStage', A),
    trigger: str(),
    confirm: { type: 'object', owner: A, default: {}, merge: 'byKey' },
  },
  finding: {
    title: str(A, { required: true }),
    targetId: str(A, { ref: 'target' }),
    componentId: str(A, { ref: 'component' }),
    chain: str(),
    severity: en('severity', A, 'medium'),
    bugClass: str(),
    bounty: num(),
    stage: en('findingStage', A, 'recon'),
    notes: str(),
    repro: str(),
    hypothesisId: str(A, { ref: 'hypothesis' }),
    // the confirmation card: a finding is not valid until these are answered
    attacker: en('attacker', A),
    reachability: en('reachability', A),
    bound: str(),
    liveFunds: str(),
    liveFundsMethod: en('fundsMethod', A),
    alreadyReported: en('reported', A),
    alreadyReportedRef: str(),
    verificationMethod: en('verifyMethod', A),
    testName: str(),
    testResult: en('testResult', A),
    productionTouched: bool(),
    productionNote: str(),
    // a concrete change an engineer could implement from the description
    fix: str(),
    // if this finding is the same root cause as another finding, fold it into that parent
    foldedInto: str(A, { ref: 'finding' }),
  },
  // Several weaker issues that combine into a stronger one.
  chain: {
    title: str(A, { required: true }),
    targetId: str(A, { ref: 'target' }),
    parts: arr(),
    glue: en('chainGlue', A, 'other'),
    gluePermissionless: bool(),
    result: str(),
    severity: en('severity', A, 'medium'),
  },
  steer: {
    action: en('steerKind', A, 'note'),
    itemId: str(),
    itemKind: str(),
    to: { type: 'array', owner: A, default: ['all'] },
    state: en('steerState', A, 'open'),
    note: str(),
    response: str(),
    waitingReason: str(),
  },
  proposal: {
    text: str(A, { required: true }),
    itemId: str(),
    itemKind: str(),
    steerKind: en('steerKind', A, 'cover'),
    rationale: str(),
    options: arr(),
    choice: str(),
    state: en('proposalState', A, 'pending'),
    // optional state mutation applied automatically when the human accepts (e.g. { report: { shape: 'combined' } })
    onAccept: obj(),
  },
  // What an agent says to the human: a reply, an update, a question. Humans talk
  // to agents with steers, which agents must acknowledge.
  message: {
    text: str(A, { required: true }),
    to: { type: 'array', owner: A, default: ['human'] },
    itemId: str(),
    replyTo: str(),
  },
  // A rule the protocol must never break ("nobody withdraws more than they put in"),
  // the state it is about, and what happened when an engine tried to break it.
  rule: {
    text: str(A, { required: true }),
    targetId: str(A, { ref: 'target' }),
    category: en('ruleCategory', A, 'conservation'),
    state: arr(),
    formal: str(),
    engine: en('ruleEngine', A),
    status: en('ruleStatus', A, 'untested'),
    runs: str(),
    counterexample: str(),
    hypothesisId: str(A, { ref: 'hypothesis' }),
  },
  // An open thread: work worth doing that is not done yet, so nothing is forgotten.
  lead: {
    text: str(A, { required: true }),
    why: str(),
    value: en('value', A, 'med'),
    state: en('leadState', A, 'open'),
    blockedBy: str(),
    nextStep: str(),
    outcome: str(),
    targetId: str(A, { ref: 'target' }),
    componentId: str(A, { ref: 'component' }),
    itemId: str(),
  },
};

// The field that names an item in the ui and in activity summaries.
export const TITLE_FIELD = {
  agent: 'name', target: 'name', component: 'name', relation: 'label', assumption: 'text',
  hypothesis: 'text', finding: 'title', chain: 'title', steer: 'note', proposal: 'text', lead: 'text', message: 'text', rule: 'text',
};

// Fields whose change reads as "moved" in the activity feed.
export const MOVE_FIELDS = new Set(['stage', 'status', 'reviewState', 'state', 'phase']);

export const SYSTEM_FIELDS = new Set([
  'id', 'kind', 'createdAt', 'updatedAt', 'createdBy', 'lastTouchedBy', '_f',
]);

export function fieldsFor(kind) {
  const own = SCHEMA[kind];
  if (!own) return null;
  return { ...SHARED_FIELDS, ...own };
}

export const isHuman = (author) => typeof author === 'string' && author.startsWith('human');
export const isKind = (kind) => KINDS.includes(kind);

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.details = details;
  }
}

export class OwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OwnershipError';
    this.status = 409;
  }
}

// Check a set of incoming fields. Returns a cleaned copy.
// `author` decides whether human-owned fields may be written.
export function validateFields(kind, fields, { author, partial = false } = {}) {
  const spec = fieldsFor(kind);
  if (!spec) throw new ValidationError(`unknown kind "${kind}". kinds: ${KINDS.join(', ')}`);
  const out = {};
  const errors = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (SYSTEM_FIELDS.has(key)) continue; // silently ignore hub-managed fields
    const f = spec[key];
    if (!f) {
      errors.push(`unknown field "${key}" on ${kind}. allowed: ${Object.keys(spec).join(', ')}`);
      continue;
    }
    if (f.owner === H && !isHuman(author)) {
      errors.push(`"${key}" is a human-owned field; agents cannot set it`);
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = f.type === 'array' ? [] : f.type === 'object' ? {} : '';
      continue;
    }
    if (f.type === 'array' && !Array.isArray(value)) { errors.push(`"${key}" must be an array`); continue; }
    if (f.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) { errors.push(`"${key}" must be an object`); continue; }
    if (f.type === 'boolean') {
      if (typeof value !== 'boolean') { errors.push(`"${key}" must be true or false`); continue; }
      out[key] = value;
      continue;
    }
    if (f.type === 'number') {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) { errors.push(`"${key}" must be a number`); continue; }
      out[key] = n;
      continue;
    }
    if (f.type === 'string') {
      if (typeof value !== 'string') { errors.push(`"${key}" must be a string`); continue; }
      if (f.enum && value !== '' && !ENUMS[f.enum].includes(value)) {
        errors.push(`"${key}" must be one of: ${ENUMS[f.enum].join(', ')} (got "${value}")`);
        continue;
      }
      if (value.length > 20000) { errors.push(`"${key}" is too long`); continue; }
    }
    out[key] = value;
  }
  if (!partial) {
    for (const [key, f] of Object.entries(spec)) {
      if (f.required && (out[key] === undefined || out[key] === '')) errors.push(`"${key}" is required for ${kind}`);
    }
  }
  if (out.evidence) out.evidence = normalizeEvidence(out.evidence, author);
  for (const field of ['checklist', 'confirm']) {
    if (!out[field]) continue;
    for (const [k, v] of Object.entries(out[field])) {
      const state = typeof v === 'string' ? v : v?.state;
      if (!ENUMS.checkState.includes(state)) errors.push(`${field} "${k}" must be one of: ${ENUMS.checkState.join(', ')}`);
    }
  }
  if (errors.length) throw new ValidationError(errors.join('; '), errors);
  return out;
}

let evSeq = 0;
export function normalizeEvidence(list, author) {
  return list.map((e) => {
    if (typeof e === 'string') e = { ref: e };
    const ref = String(e.ref || '').slice(0, 2000);
    if (looksCollapsedRef(ref)) {
      throw new ValidationError(`evidence ref "${ref.slice(0, 80)}" looks like multiple refs joined with "|". Attach each evidence entry separately (CLI: pass --evidence once per item, e.g. --evidence "code:file.sol:10|note" --evidence "fork:test_X|note").`);
    }
    const kind = ENUMS.evidenceKind.includes(e.kind) ? e.kind : guessEvidenceKind(ref);
    const env = Array.isArray(e.env) ? e.env.map((x) => String(x).slice(0, 80)).filter(Boolean).slice(0, 20) : undefined;
    return {
      id: e.id || `ev_${Date.now().toString(36)}${(evSeq++).toString(36)}`,
      kind,
      ref,
      note: String(e.note || '').slice(0, 8000),
      ...(e.rpc ? { rpc: String(e.rpc).slice(0, 300) } : {}),
      ...(e.block ? { block: String(e.block).slice(0, 40) } : {}),
      ...(e.result ? { result: String(e.result).slice(0, 40) } : {}),
      ...(e.command ? { command: String(e.command).slice(0, 1000) } : {}),
      ...(env?.length ? { env } : {}),
      by: e.by || author || 'unknown',
      at: e.at || Date.now(),
    };
  });
}

function looksCollapsedRef(ref) {
  if (!ref || !ref.includes('|')) return false;
  const parts = ref.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const refLike = (s) => /^https?:\/\/|^0x[0-9a-f]{64}$|^test[_A-Z]|[\w/.-]+\.(sol|rs|move|vy|go|ts|js|py|cairo)(:\d+)?|\bfork\b/i.test(s);
  return parts.filter(refLike).length >= 2;
}

export function guessEvidenceKind(ref) {
  if (/^0x[0-9a-f]{64}$/i.test(ref)) return 'tx';
  if (/\bfork\b|--fork-url|mainnet[- ]fork|\bcast\s+(call|eth_call)\b|\beth_call\b/i.test(ref)) return 'fork';
  if (/^test[_A-Z]|\.t\.sol|forge test|::test/.test(ref)) return 'test';
  if (/^https?:\/\//.test(ref)) return 'link';
  if (/[\w/.-]+\.(sol|rs|move|vy|go|ts|js|py|cairo)(:\d+)?/.test(ref) || /::|\(\)|#L\d+/.test(ref)) return 'code';
  if (/\.(log|txt)$|\b(trace|stdout|stderr)\b/i.test(ref)) return 'log';
  return 'note';
}

// Fill defaults for a newly created item.
export function withDefaults(kind, fields) {
  const spec = fieldsFor(kind);
  const out = {};
  for (const [key, f] of Object.entries(spec)) {
    if (fields[key] !== undefined) out[key] = fields[key];
    else if (f.default !== undefined) out[key] = Array.isArray(f.default) ? [...f.default] : typeof f.default === 'object' ? { ...f.default } : f.default;
  }
  return out;
}

export function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}

const PREFIX = {
  agent: 'ag', target: 'tg', component: 'cp', relation: 'rl', assumption: 'as', hypothesis: 'hy',
  finding: 'fd', chain: 'ch', steer: 'st', proposal: 'pr', lead: 'ld', message: 'ms', rule: 'ru',
};

let idSeq = 0;
export function newId(kind) {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${PREFIX[kind] || 'it'}_${Date.now().toString(36)}${(idSeq++ % 1296).toString(36).padStart(2, '0')}${rand}`;
}

export const AGENT_COLORS = [
  '#a5d8ff', '#b2f2bb', '#ffd8a8', '#eebefa', '#ffc9c9', '#99e9f2', '#d0bfff', '#ffec99',
];

// A description of the model suitable for docs and for agents asking "what can I write?".
export function describeModel() {
  const kinds = {};
  for (const kind of KINDS) {
    const spec = fieldsFor(kind);
    kinds[kind] = Object.fromEntries(Object.entries(spec).map(([k, f]) => [k, {
      type: f.type,
      ...(f.enum ? { enum: ENUMS[f.enum] } : {}),
      ...(f.required ? { required: true } : {}),
      ...(f.default !== undefined && f.type === 'string' ? { default: f.default } : {}),
      owner: f.owner === H ? 'human-only' : 'human or agent',
    }]));
  }
  return { enums: ENUMS, kinds };
}

// Guard: no schema field may shadow a hub-managed field (id, kind, timestamps...).
for (const [kind, spec] of Object.entries(SCHEMA)) {
  for (const key of Object.keys(spec)) {
    if (SYSTEM_FIELDS.has(key)) throw new Error(`schema bug: ${kind}.${key} shadows a system field`);
  }
}
