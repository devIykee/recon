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
    'governance', 'oracle', 'token', 'vault', 'other',
  ],
  componentKind: ['contract', 'function', 'module', 'endpoint', 'storage', 'config', 'other'],
  reviewState: ['untouched', 'scanning', 'reviewed', 'flagged'],
  assumptionState: ['assumed', 'verified', 'invalidated'],
  confidence: ['low', 'med', 'high'],
  hypothesisStatus: ['testing', 'confirmed', 'dropped'],
  severity: ['critical', 'high', 'medium', 'low', 'info'],
  findingStage: ['recon', 'testing', 'reported', 'acknowledged', 'fixed', 'disclosed'],
  steerKind: ['recheck', 'challenge', 'cover', 'verify', 'priority', 'note'],
  steerState: ['open', 'acknowledged', 'addressed'],
  proposalState: ['pending', 'accepted', 'declined'],
  verification: ['unverified', 'verified', 'disputed'],
  priority: ['low', 'normal', 'high', 'urgent'],
  evidenceKind: ['code', 'tx', 'log', 'test', 'link', 'note'],
  checkState: ['unchecked', 'checked', 'na'],
});

export const KINDS = Object.freeze([
  'agent', 'target', 'component', 'assumption', 'hypothesis', 'finding', 'steer', 'proposal',
]);

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
    status: en('agentStatus', A, 'active'),
    focus: str(),
    focusItem: str(),
    assignment: arr(H),
    model: str(),
  },
  target: {
    name: str(A, { required: true }),
    chain: str(),
    protocolType: en('protocolType', A, 'other'),
    description: str(),
    focus: str(),
    scope: str(),
  },
  component: {
    targetId: str(A, { required: true, ref: 'target' }),
    name: str(A, { required: true }),
    kind: en('componentKind', A, 'contract'),
    reviewState: en('reviewState', A, 'untouched'),
    location: str(),
    owner: str(),
    checklist: { type: 'object', owner: A, default: {}, merge: 'byKey' },
    notes: str(),
  },
  assumption: {
    text: str(A, { required: true }),
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
  },
  steer: {
    action: en('steerKind', A, 'note'),
    itemId: str(),
    itemKind: str(),
    to: { type: 'array', owner: A, default: ['all'] },
    state: en('steerState', A, 'open'),
    note: str(),
    response: str(),
  },
  proposal: {
    text: str(A, { required: true }),
    itemId: str(),
    itemKind: str(),
    steerKind: en('steerKind', A, 'cover'),
    rationale: str(),
    state: en('proposalState', A, 'pending'),
  },
};

// The field that names an item in the ui and in activity summaries.
export const TITLE_FIELD = {
  agent: 'name', target: 'name', component: 'name', assumption: 'text',
  hypothesis: 'text', finding: 'title', steer: 'note', proposal: 'text',
};

// Fields whose change reads as "moved" in the activity feed.
export const MOVE_FIELDS = new Set(['stage', 'status', 'reviewState', 'state']);

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
  if (out.checklist) {
    for (const [k, v] of Object.entries(out.checklist)) {
      const state = typeof v === 'string' ? v : v?.state;
      if (!ENUMS.checkState.includes(state)) errors.push(`checklist "${k}" must be one of: ${ENUMS.checkState.join(', ')}`);
    }
  }
  if (errors.length) throw new ValidationError(errors.join('; '), errors);
  return out;
}

let evSeq = 0;
export function normalizeEvidence(list, author) {
  return list.map((e) => {
    if (typeof e === 'string') e = { ref: e };
    const kind = ENUMS.evidenceKind.includes(e.kind) ? e.kind : guessEvidenceKind(e.ref || '');
    return {
      id: e.id || `ev_${Date.now().toString(36)}${(evSeq++).toString(36)}`,
      kind,
      ref: String(e.ref || '').slice(0, 2000),
      note: String(e.note || '').slice(0, 8000),
      by: e.by || author || 'unknown',
      at: e.at || Date.now(),
    };
  });
}

function guessEvidenceKind(ref) {
  if (/^0x[0-9a-f]{64}$/i.test(ref)) return 'tx';
  if (/^https?:\/\//.test(ref)) return 'link';
  if (/[\w/.-]+\.(sol|rs|move|vy|go|ts|js|py|cairo)(:\d+)?/.test(ref) || /::|\(\)|#L\d+/.test(ref)) return 'code';
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
  agent: 'ag', target: 'tg', component: 'cp', assumption: 'as', hypothesis: 'hy',
  finding: 'fd', steer: 'st', proposal: 'pr',
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
