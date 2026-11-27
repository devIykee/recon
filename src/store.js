// The recon store.
//
// Design choice: the hub is the single serialization point for every writer
// (web ui, mcp agents, cli, http, drop-in json). Every item is a map of
// last-write-wins registers, one per field, each stamped with {at, by}.
// Writes are per item and per field, never whole-board overwrites, so a human
// setting `verification` and an agent setting `reviewState` on the same item
// never collide. Two list-ish fields merge instead of replace:
//   evidence  - union by evidence id
//   checklist - per-key last write wins
// External documents (drop-in json, imports) merge through the same path, and
// a field write older than the stored clock is ignored, which keeps merges
// idempotent and order-independent.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { phaseStatus } from './knowledge.js';
import { enforce } from './quality.js';
import {
  KINDS, ENUMS, fieldsFor, validateFields, withDefaults, newId, slug, isHuman,
  MOVE_FIELDS, TITLE_FIELD, AGENT_COLORS, ValidationError, OwnershipError, isKind,
} from './model.js';

const ACTIVITY_CAP = 1000;
export const STATE_VERSION = 1;

export function emptyState(name = 'Untitled engagement') {
  return {
    version: STATE_VERSION,
    project: { id: newId('target').replace('tg_', 'pj_'), name, createdAt: Date.now(), example: false, dismissed: [] },
    items: Object.fromEntries(KINDS.map((k) => [k, {}])),
    activity: [],
  };
}

export class Store extends EventEmitter {
  constructor({ file = null, encryptionKey = null, saveDelay = 120 } = {}) {
    super();
    this.setMaxListeners(200);
    this.file = file;
    this.saveDelay = saveDelay;
    this.key = encryptionKey ? deriveKey(encryptionKey) : null;
    this.state = emptyState();
    this.lastAt = 0;
    this._saveTimer = null;
    this.loaded = false;
    this.rev = 0; // bumps on every change; snapshots use it to skip idle periods
  }

  // Point the store at another engagement file (saving the current one first).
  switchTo(file, { fresh = false, save = true } = {}) {
    if (this.file && save) this.flush();
    clearTimeout(this._saveTimer);
    this.file = file;
    this.rev++;
    if (fresh || !file) { this.state = emptyState(); this.loaded = false; return false; }
    const ok = this.load();
    if (!ok) this.state = emptyState();
    return ok;
  }

  serialize() {
    const body = JSON.stringify(this.state, null, 1);
    return this.key ? encrypt(body, this.key) : body;
  }

  // ---------- persistence ----------

  load() {
    if (this.file && fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      const doc = this.key ? decrypt(raw, this.key) : parseMaybeEncrypted(raw);
      this.state = normalizeState(doc);
      this.loaded = true;
      return true;
    }
    this.loaded = false;
    return false;
  }

  save() {
    if (!this.file) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), this.saveDelay);
  }

  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = this.serialize();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // A monotonic clock: wall time, but never repeating or going backwards.
  tick() {
    const now = Date.now();
    this.lastAt = now > this.lastAt ? now : this.lastAt + 1;
    return this.lastAt;
  }

  // ---------- reads ----------

  get(kind, id) {
    return this.state.items[kind]?.[id] || null;
  }

  find(id) {
    if (!id) return null;
    for (const kind of KINDS) {
      const it = this.state.items[kind][id];
      if (it) return it;
    }
    return null;
  }

  list(kind, filter = {}) {
    let out = Object.values(this.state.items[kind] || {});
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined || v === null || v === '') continue;
      out = out.filter((it) => (Array.isArray(it[k]) ? it[k].includes(v) : it[k] === v));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  snapshot() {
    return this.state;
  }

  // ---------- writes ----------

  create(kind, fields, author, { at, silent = false, id, force = false } = {}) {
    if (!isKind(kind)) throw new ValidationError(`unknown kind "${kind}"`);
    const clean = validateFields(kind, fields, { author });
    this.checkRefs(kind, clean);
    const ts = at || this.tick();
    const itemId = id || fields.id || (kind === 'agent' ? agentIdFor(clean.name) : kind === 'relation' ? relationId(clean) : newId(kind));
    if (this.get(kind, itemId)) return this.patch(kind, itemId, fields, author, { at, silent });
    const item = {
      id: itemId,
      kind,
      ...withDefaults(kind, clean),
      createdAt: ts,
      updatedAt: ts,
      createdBy: author,
      lastTouchedBy: author,
      _f: {},
    };
    if (!this.gatesOff && !force) enforce(this.state, kind, item, Object.keys(clean), author, { created: true });
    if (kind === 'agent' && !item.color) item.color = AGENT_COLORS[Object.keys(this.state.items.agent).length % AGENT_COLORS.length];
    if (kind === 'agent' && !item.avatar) item.avatar = initials(item.name);
    if (clean.checklist) item.checklist = mergeByKey({}, clean.checklist, author, ts);
    for (const key of Object.keys(clean)) item._f[key] = { at: ts, by: author };
    this.state.items[kind][itemId] = item;
    const action = kind === 'agent' ? 'joined' : kind === 'steer' ? 'steered' : kind === 'proposal' ? 'proposed' : kind === 'relation' ? 'mapped' : 'added';
    const summary = kind === 'relation'
      ? `mapped ${label('component', this.get('component', item.from))} ${item.type} ${label('component', this.get('component', item.to))}${item.label ? ` (${trim(item.label, 40)})` : ''}`
      : summarize(action, kind, item);
    const activity = this.log({ by: author, action, kind, itemId, summary }, ts);
    this.afterWrite(kind, item, Object.keys(clean), author, { created: true });
    if (!silent) this.emitChange('upsert', kind, item, activity);
    this.save();
    return item;
  }

  patch(kind, id, fields, author, { at, silent = false, force = false } = {}) {
    const item = this.get(kind, id);
    if (!item) throw notFound(kind, id);
    const clean = validateFields(kind, fields, { author, partial: true });
    this.checkRefs(kind, clean);
    if (kind === 'component' && !force) this.checkOwnership(item, clean, author);
    if (kind === 'target' && clean.phase && !isHuman(author)) this.checkPhaseGate(item, clean.phase);
    const ts = at || this.tick();
    const spec = fieldsFor(kind);
    const changed = [];
    const before = {};
    const nextValues = {};
    for (const [key, value] of Object.entries(clean)) {
      const clock = item._f[key];
      if (at && clock && clock.at > at) continue; // stale external write; newer value wins
      const f = spec[key];
      let next = value;
      if (f.merge === 'byId') next = mergeById(item[key] || [], value);
      else if (f.merge === 'byKey') next = mergeByKey(item[key] || {}, value, author, ts);
      if (deepEqual(item[key], next)) continue;
      nextValues[key] = next;
      changed.push(key);
    }
    if (!changed.length) { this.noteNoop(author); return item; }
    if (!force && !this.gatesOff) enforce(this.state, kind, { ...item, ...nextValues }, changed, author);
    for (const key of changed) {
      before[key] = item[key];
      item[key] = nextValues[key];
      item._f[key] = { at: ts, by: author };
    }
    item.updatedAt = Math.max(item.updatedAt, ts);
    item.lastTouchedBy = author;
    const action = actionFor(kind, changed, item, before);
    const activity = this.log({
      by: author, action, kind, itemId: id, fields: changed,
      summary: summarize(action, kind, item, changed, before),
    }, ts);
    this.afterWrite(kind, item, changed, author, { before });
    if (!silent) this.emitChange('upsert', kind, item, activity);
    this.save();
    return item;
  }

  upsert(kind, fields, author, opts = {}) {
    if (fields.id && this.get(kind, fields.id)) {
      const { id, ...rest } = fields;
      return this.patch(kind, id, rest, author, opts);
    }
    if (kind === 'agent' && fields.name && this.get('agent', agentIdFor(fields.name))) {
      return this.patch('agent', agentIdFor(fields.name), fields, author, opts);
    }
    return this.create(kind, fields, author, opts);
  }

  remove(kind, id, author) {
    const item = this.get(kind, id);
    if (!item) throw notFound(kind, id);
    delete this.state.items[kind][id];
    // cascade: components of a removed target, and dangling links
    if (kind === 'target') {
      for (const c of this.list('component', { targetId: id })) delete this.state.items.component[c.id];
      for (const r of this.list('relation', { targetId: id })) delete this.state.items.relation[r.id];
    }
    if (kind === 'component') {
      for (const r of Object.values(this.state.items.relation)) if (r.from === id || r.to === id) delete this.state.items.relation[r.id];
    }
    const activity = this.log({ by: author, action: 'removed', kind, itemId: id, summary: summarize('removed', kind, item) });
    this.emitChange('remove', kind, item, activity);
    this.save();
    return item;
  }

  addEvidence(kind, id, evidence, author) {
    const list = Array.isArray(evidence) ? evidence : [evidence];
    return this.patch(kind, id, { evidence: list }, author);
  }

  removeEvidence(kind, id, evidenceId, author) {
    const item = this.get(kind, id);
    if (!item) throw notFound(kind, id);
    const before = item.evidence.length;
    item.evidence = item.evidence.filter((e) => e.id !== evidenceId);
    if (item.evidence.length === before) return item;
    const ts = this.tick();
    item.updatedAt = ts;
    item.lastTouchedBy = author;
    item._f.evidence = { at: ts, by: author };
    const activity = this.log({ by: author, action: 'updated', kind, itemId: id, fields: ['evidence'], summary: `removed evidence from ${label(kind, item)}` }, ts);
    this.emitChange('upsert', kind, item, activity);
    this.save();
    return item;
  }

  // Register or refresh an agent. Called on every agent request.
  touchAgent(name, { transport, model } = {}) {
    const id = agentIdFor(name);
    let agent = this.get('agent', id);
    const now = Date.now();
    if (!agent) {
      agent = this.create('agent', { name, transport: transport || 'api', transports: [transport || 'api'], status: 'active', ...(model ? { model } : {}) }, id);
      agent.lastSeen = now;
      return agent;
    }
    // Presence is not news: refresh quietly, broadcast without an activity entry.
    let dirty = false;
    if (transport && agent.transport !== transport) { agent.transport = transport; dirty = true; }
    if (transport && !(agent.transports || []).includes(transport)) { agent.transports = [...(agent.transports || []), transport]; dirty = true; }
    if (agent.status === 'offline' || agent.status === 'idle') { agent.status = 'active'; dirty = true; }
    agent.lastSeen = now;
    if (dirty) { agent.updatedAt = this.tick(); this.emitChange('upsert', 'agent', agent, null); this.save(); }
    return agent;
  }

  // Writes that change nothing are a looping signal: an agent repeating itself.
  noteNoop(author) {
    if (isHuman(author)) return;
    const agent = this.get('agent', author);
    if (!agent) return;
    const now = Date.now();
    agent.noops = (agent.noops || []).filter((t) => now - t < 120_000).concat(now).slice(-20);
    agent.lastSeen = now;
  }

  markWrite(author) {
    if (isHuman(author)) return;
    const agent = this.get('agent', author);
    if (agent) { agent.lastWriteAt = Date.now(); agent.lastSeen = Date.now(); }
  }

  log(entry, at) {
    const a = { id: newId('steer').replace('st_', 'ac_'), at: at || this.tick(), ...entry };
    this.state.activity.push(a);
    if (this.state.activity.length > ACTIVITY_CAP) this.state.activity.splice(0, this.state.activity.length - ACTIVITY_CAP);
    this.markWrite(entry.by);
    return a;
  }

  emitChange(op, kind, item, activity) {
    this.rev++;
    this.emit('change', { op, kind, item, activity });
  }

  // ---------- rules that make the loop work ----------

  afterWrite(kind, item, changed, author, { created = false, before = {} } = {}) {
    // A human disputing an agent's claim signals that agent to revisit it.
    if (changed.includes('verification') && item.verification === 'disputed' && isHuman(author)) {
      const owner = !isHuman(item.createdBy) ? item.createdBy : null;
      if (kind !== 'steer' && kind !== 'agent') {
        this.create('steer', {
          action: kind === 'assumption' ? 'challenge' : 'recheck',
          itemId: item.id,
          itemKind: kind,
          to: owner ? [owner] : ['all'],
          note: `Disputed by a human. Revisit the evidence for "${label(kind, item)}".`,
        }, author);
      }
    }
    // Promote: confirming a hypothesis keeps the link both ways.
    if (kind === 'finding' && changed.includes('hypothesisId') && item.hypothesisId) {
      const h = this.get('hypothesis', item.hypothesisId);
      if (h && h.findingId !== item.id) {
        h.findingId = item.id;
        h._f.findingId = { at: this.tick(), by: author };
        this.emitChange('upsert', 'hypothesis', h, null);
      }
    }
    // An agent that starts scanning unowned surface claims it, so others do not duplicate it.
    if (kind === 'component' && changed.includes('reviewState') && item.reviewState === 'scanning' && !item.owner && !isHuman(author) && this.get('agent', author)) {
      item.owner = author;
      item._f.owner = { at: this.tick(), by: author };
    }
    // An agent claiming focus on a component marks it as being scanned.
    if (kind === 'agent' && changed.includes('focusItem') && item.focusItem) {
      const c = this.get('component', item.focusItem);
      if (c && c.reviewState === 'untouched') this.patch('component', c.id, { reviewState: 'scanning' }, author, { force: true });
    }
    // Steer acknowledgement timestamps.
    if (kind === 'steer' && changed.includes('state')) {
      if (item.state === 'acknowledged' && !item.ackAt) item.ackAt = Date.now();
      if (item.state === 'addressed') { item.addressedAt = Date.now(); item.addressedBy = author; if (!item.ackAt) item.ackAt = item.addressedAt; }
    }
    void created; void before;
  }

  checkRefs(kind, fields) {
    const spec = fieldsFor(kind);
    for (const [key, value] of Object.entries(fields)) {
      const ref = spec[key]?.ref;
      if (ref && value && !this.get(ref, value)) {
        throw new ValidationError(`"${key}" points at ${ref} "${value}", which does not exist`);
      }
    }
  }

  // Region ownership: a component claimed by one agent is not overwritten by another.
  checkOwnership(item, fields, author) {
    if (isHuman(author) || !item.owner || item.owner === author) return;
    const contested = Object.keys(fields).filter((k) => !['evidence', 'checklist'].includes(k));
    if (contested.length) {
      throw new OwnershipError(
        `component "${item.name}" is owned by ${item.owner}. add evidence instead, or ask the human to reassign it (fields: ${contested.join(', ')})`,
      );
    }
  }

  // Agents work in order: map the system, record the developers' assumptions, then hunt.
  // A human can move a target to any phase.
  checkPhaseGate(target, next) {
    const order = ENUMS.phase;
    if (order.indexOf(next) <= order.indexOf(target.phase || 'mapping')) return;
    const ps = phaseStatus(this.state, target.id);
    if (order.indexOf(next) >= order.indexOf('assumptions')) {
      const code = ps.components - ps.actors - ps.externals;
      const comps = Object.values(this.state.items.component).filter((c) => c.targetId === target.id);
      const linked = new Set(Object.values(this.state.items.relation).filter((r) => r.targetId === target.id).flatMap((r) => [r.from, r.to]));
      const loose = comps.filter((c) => !linked.has(c.id));
      if (code < 1 || ps.relations < Math.max(1, Math.ceil(ps.components / 2)) || loose.length > Math.floor(comps.length / 5)) {
        throw new ValidationError(`finish the map first: ${ps.components} parts, ${ps.relations} connections${loose.length ? `, and these are not connected to anything: ${loose.slice(0, 8).map((c) => c.name).join(', ')}` : ''}. Show how the parts call, transfer to, read from, own and trust each other (recon_scan does most of it from the source).`);
      }
    }
    if (order.indexOf(next) >= order.indexOf('hunting') && ps.developerAssumptions < 1) {
      throw new ValidationError('record what the developers assume first (assumptions with origin "developer": trust model, invariants, expected inputs and tokens, external dependencies), then move to hunting.');
    }
  }

  claim(componentIds, agentId) {
    const claimed = [];
    const refused = [];
    for (const id of componentIds) {
      const c = this.get('component', id);
      if (!c) { refused.push({ id, reason: 'not found' }); continue; }
      if (c.owner && c.owner !== agentId) { refused.push({ id, reason: `owned by ${c.owner}` }); continue; }
      if (c.owner !== agentId) this.patch('component', id, { owner: agentId }, agentId, { force: true });
      claimed.push(id);
    }
    return { claimed, refused };
  }

  // ---------- whole-document operations ----------

  // Merge an external document (drop-in json, `recon push`) item by item.
  merge(doc, author) {
    const items = docItems(doc);
    const result = { created: 0, updated: 0, errors: [] };
    // targets first so component refs resolve; hypotheses before findings
    const order = ['agent', 'target', 'component', 'relation', 'hypothesis', 'finding', 'chain', 'assumption', 'lead', 'steer', 'proposal'];
    const deferred = [];
    const apply = (kind, raw) => {
      const { id, kind: _k, createdAt, updatedAt, createdBy, lastTouchedBy, _f, ...fields } = raw;
      this.resolveNames(fields);
      const existing = id ? this.get(kind, id) : null;
      const at = typeof updatedAt === 'number' ? updatedAt : undefined;
      const clean = stripHumanFields(kind, fields, author);
      if (existing) { this.patch(kind, id, clean, author, { at }); result.updated++; }
      else { this.create(kind, clean, author, { id }); result.created++; }
    };
    for (const kind of order) {
      for (const raw of items[kind] || []) {
        try { apply(kind, raw); } catch (err) {
          if (err.name === 'GateError') deferred.push([kind, raw, err]);
          else result.errors.push(`${kind}${raw.id ? ` ${raw.id}` : ''}: ${err.message}`);
        }
      }
    }
    // gated writes may pass once the rest of the document has landed (e.g. a flag and its hypothesis)
    for (const [kind, raw, first] of deferred) {
      try { apply(kind, raw); } catch (err) { result.errors.push(`${kind}${raw.id ? ` ${raw.id}` : ''}: ${(err || first).message}`); }
    }
    return result;
  }

  // Drop-in documents may name things instead of using ids: "component": "Vault.withdraw()".
  resolveNames(fields) {
    const byName = (kind, name) => Object.values(this.state.items[kind]).find((x) => String(x.name || x.title || x.text).toLowerCase() === String(name).toLowerCase());
    if (fields.component && !fields.componentId) { const c = byName('component', fields.component); if (c) { fields.componentId = c.id; if (!fields.targetId) fields.targetId = c.targetId; } }
    if (fields.target && !fields.targetId) { const t = byName('target', fields.target); if (t) fields.targetId = t.id; }
    if (fields.hypothesis && !fields.hypothesisId) { const h = byName('hypothesis', fields.hypothesis); if (h) fields.hypothesisId = h.id; }
    delete fields.component; delete fields.target; delete fields.hypothesis;
  }

  replace(doc, author = 'human') {
    this.state = normalizeState(doc);
    this.rev++;
    this.log({ by: author, action: 'imported', kind: 'project', summary: `loaded project "${this.state.project.name}"` });
    this.emit('reset', this.state);
    this.save();
  }

  setProject(fields, author) {
    const p = this.state.project;
    if (typeof fields.name === 'string' && fields.name.trim()) p.name = fields.name.trim().slice(0, 120);
    if (typeof fields.example === 'boolean') p.example = fields.example;
    if (Array.isArray(fields.dismissed)) p.dismissed = fields.dismissed.slice(-500);
    if (fields.report && typeof fields.report === 'object') {
      const r = { ...(p.report || {}) };
      if (['combined', 'separate', ''].includes(fields.report.shape)) r.shape = fields.report.shape;
      if (typeof fields.report.path === 'string') r.path = fields.report.path.slice(0, 500);
      if (Array.isArray(fields.report.includeIds)) r.includeIds = fields.report.includeIds.map(String).slice(0, 200);
      if (typeof fields.report.skill === 'string') r.skill = fields.report.skill.slice(0, 80);
      if (typeof fields.report.signOff === 'string') r.signOff = fields.report.signOff.trim().slice(0, 120);
      if (Array.isArray(fields.report.documents)) r.documents = fields.report.documents.slice(0, 100);
      if (fields.report.last) r.last = fields.report.last;
      p.report = r;
    }
    this.rev++;
    this.emit('project', p);
    this.save();
    void author;
    return p;
  }
}

// ---------- helpers ----------

export function agentIdFor(name) {
  return `ag_${slug(name)}`;
}

function initials(name) {
  const parts = String(name).trim().split(/[\s_-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function stripHumanFields(kind, fields, author) {
  if (isHuman(author)) return fields;
  const spec = fieldsFor(kind);
  return Object.fromEntries(Object.entries(fields).filter(([k]) => spec[k] && spec[k].owner !== 'human'));
}

function docItems(doc) {
  if (!doc || typeof doc !== 'object') throw new ValidationError('document must be a json object');
  // Accept a full state ({items: {kind: {id: item}}}) or a flat doc ({targets: [...], ...}).
  const out = {};
  if (doc.items && typeof doc.items === 'object') {
    for (const kind of KINDS) out[kind] = Object.values(doc.items[kind] || {});
    return out;
  }
  const plural = {
    agent: 'agents', target: 'targets', component: 'components', relation: 'relations', assumption: 'assumptions',
    hypothesis: 'hypotheses', finding: 'findings', steer: 'steers', proposal: 'proposals',
  };
  for (const kind of KINDS) {
    const list = doc[plural[kind]] || doc[kind];
    if (Array.isArray(list)) out[kind] = list;
  }
  // Items without ids get a stable id from their content, so rewriting the same file is idempotent.
  const prefix = { assumption: 'as', hypothesis: 'hy', finding: 'fd', steer: 'st', proposal: 'pr' };
  for (const [kind, p] of Object.entries(prefix)) {
    if (!Array.isArray(out[kind])) continue;
    out[kind] = out[kind].map((it) => (it && !it.id && (it[TITLE_FIELD[kind]]) ? { ...it, id: stableId(p, it[TITLE_FIELD[kind]]) } : it));
  }
  // Allow components nested in targets: {targets: [{name, components: [...]}]}
  if (Array.isArray(out.target)) {
    out.component = out.component || [];
    out.target = out.target.map((t) => {
      const { components, ...rest } = t;
      if (!rest.id) rest.id = `tg_${slug(rest.name)}`;
      for (const c of components || []) out.component.push({ ...c, targetId: rest.id, id: c.id || `cp_${slug(rest.name)}_${slug(c.name)}` });
      return rest;
    });
  }
  return out;
}

// One relation per (from, to, type): mapping the same edge twice updates it.
export function relationId(f) {
  const h = crypto.createHash('sha1').update(`${f.from}|${f.to}|${f.type || 'calls'}`).digest('hex').slice(0, 12);
  return `rl_${h}`;
}

function stableId(prefix, text) {
  const h = crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
  return `${prefix}_${slug(text).slice(0, 24)}_${h}`;
}

export function normalizeState(doc) {
  const base = emptyState();
  if (!doc || typeof doc !== 'object') return base;
  const state = {
    version: STATE_VERSION,
    project: { ...base.project, ...(doc.project || {}) },
    items: {},
    activity: Array.isArray(doc.activity) ? doc.activity.slice(-ACTIVITY_CAP) : [],
  };
  for (const kind of KINDS) {
    const src = doc.items?.[kind] || {};
    state.items[kind] = {};
    for (const [id, it] of Object.entries(src)) {
      if (!it || typeof it !== 'object') continue;
      state.items[kind][id] = { ...withDefaults(kind, it), ...it, id, kind, _f: it._f || {} };
    }
  }
  if (!Array.isArray(state.project.dismissed)) state.project.dismissed = [];
  return state;
}

function mergeById(current, incoming) {
  const map = new Map(current.map((e) => [e.id, e]));
  for (const e of incoming) map.set(e.id, { ...(map.get(e.id) || {}), ...e });
  return [...map.values()].sort((a, b) => a.at - b.at);
}

function mergeByKey(current, incoming, author, at) {
  const out = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    const state = typeof v === 'string' ? v : v.state;
    out[k] = { state, by: (typeof v === 'object' && v.by) || author, at: (typeof v === 'object' && v.at) || at, ...(typeof v === 'object' && v.note ? { note: v.note } : {}) };
  }
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function notFound(kind, id) {
  const err = new Error(`${kind} "${id}" not found`);
  err.status = 404;
  return err;
}

export function label(kind, item) {
  const v = item?.[TITLE_FIELD[kind]] || item?.kind || kind;
  const s = String(v);
  return s.length > 64 ? `${s.slice(0, 61)}…` : s;
}

function actionFor(kind, changed, item, before) {
  if (changed.includes('verification')) {
    if (item.verification === 'verified') return 'verified';
    if (item.verification === 'disputed') return 'disputed';
    return 'unverified';
  }
  if (kind === 'steer' && changed.includes('state')) return item.state === 'addressed' ? 'addressed' : item.state === 'acknowledged' ? 'acknowledged' : 'reopened';
  if (kind === 'proposal' && changed.includes('state')) return item.state === 'accepted' ? 'accepted' : item.state === 'declined' ? 'declined' : 'updated';
  if (changed.includes('priority')) return 'prioritized';
  if (kind === 'agent' && (changed.includes('focus') || changed.includes('focusItem'))) return 'focus';
  if (kind === 'component' && changed.length === 1 && changed[0] === 'owner') return 'claimed';
  if (changed.length === 1 && changed[0] === 'evidence') return 'evidence';
  if (changed.some((c) => MOVE_FIELDS.has(c))) return 'moved';
  void before;
  return 'updated';
}

function summarize(action, kind, item, changed = [], before = {}) {
  const name = label(kind, item);
  const k = kind === 'component' ? 'component' : kind;
  switch (action) {
    case 'added': return `added ${k} "${name}"`;
    case 'joined': return `${item.name} joined over ${item.transport}`;
    case 'steered': return `steer · ${item.action}${item.note ? `: ${trim(item.note, 80)}` : ''}`;
    case 'proposed': return `proposed: ${trim(item.text, 90)}`;
    case 'removed': return `removed ${k} "${name}"`;
    case 'verified': return `verified "${name}"`;
    case 'disputed': return `disputed "${name}"`;
    case 'unverified': return `reset verification on "${name}"`;
    case 'acknowledged': return `acknowledged steer${item.note ? ` "${trim(item.note, 60)}"` : ''}`;
    case 'addressed': return `addressed steer${item.response ? `: ${trim(item.response, 80)}` : ''}`;
    case 'reopened': return `reopened steer`;
    case 'accepted': return `accepted proposal "${trim(item.text, 70)}"`;
    case 'declined': return `declined proposal "${trim(item.text, 70)}"`;
    case 'prioritized': return `set priority of "${name}" to ${item.priority}`;
    case 'claimed': return `claimed "${name}"`;
    case 'evidence': return `attached evidence to "${name}"`;
    case 'focus': return item.focus ? `now: ${trim(item.focus, 90)}` : 'cleared focus';
    case 'moved': {
      const f = changed.find((c) => MOVE_FIELDS.has(c));
      return `moved "${name}" ${before[f] ? `${before[f]} → ` : 'to '}${item[f]}`;
    }
    default: return `updated ${changed.join(', ')} on "${name}"`;
  }
}

function trim(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------- encryption at rest (optional) ----------

function deriveKey(secret) {
  return { secret: String(secret) };
}

function encrypt(plain, key) {
  const salt = crypto.randomBytes(16);
  const k = crypto.scryptSync(key.secret, salt, 32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return JSON.stringify({
    enc: 'aes-256-gcm', kdf: 'scrypt',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  });
}

function decrypt(raw, key) {
  const env = JSON.parse(raw);
  if (!env.enc) return env; // plain file; it will be encrypted on next save
  const k = crypto.scryptSync(key.secret, Buffer.from(env.salt, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8');
  return JSON.parse(plain);
}

function parseMaybeEncrypted(raw) {
  const doc = JSON.parse(raw);
  if (doc.enc) throw new Error('state file is encrypted; set RECON_ENCRYPTION_KEY to open it');
  return doc;
}

export { ENUMS };
