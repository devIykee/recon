// Engagements are long-lived local sessions. Each one is its own file, listed in an
// index, never overwritten by starting another, and snapshotted on a schedule so it
// can be recovered after a closed tab, a crash, or a year away.
//
//   <data>/index.json                      { current, engagements: [...] }
//   <data>/engagements/<id>.json           the live state of each engagement
//   <data>/snapshots/<id>/<timestamp>.json point-in-time copies
//   <data>/trash/<id>.json                 removed engagements (still recoverable)

import fs from 'node:fs';
import path from 'node:path';
import { seedExample, seedEmpty } from './seed.js';
import { normalizeState, Store } from './store.js';
import { newId } from './model.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SNAPSHOT_EVERY = HOUR;
const KEEP_ALL_FOR = 48 * HOUR;

export class Engagements {
  constructor(dir, store, { seed = 'example', log = () => {}, encryptionKey = null } = {}) {
    this.dir = dir;
    this.store = store;
    this.encryptionKey = encryptionKey;
    // Hunts other than the one on screen that an agent is working in right now.
    this.side = new Map();
    this.onSide = null;
    this.sideRev = new Map();
    this.seed = seed;
    this.log = log;
    this.indexFile = path.join(dir, 'index.json');
    this.index = { current: null, engagements: [] };
    this.lastSnapshotRev = -1;
    this.lastSnapshotAt = 0;
    this.touchTimer = null;
  }

  fileFor(id) { return path.join(this.dir, 'engagements', `${safe(id)}.json`); }
  snapDir(id) { return path.join(this.dir, 'snapshots', safe(id)); }

  init() {
    fs.mkdirSync(path.join(this.dir, 'engagements'), { recursive: true });
    if (fs.existsSync(this.indexFile)) {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (!Array.isArray(this.index.engagements)) this.index.engagements = [];
    }
    this.migrateLegacy();
    const cur = this.index.current && this.entry(this.index.current);
    if (cur && fs.existsSync(this.fileFor(cur.id))) {
      this.store.switchTo(this.fileFor(cur.id));
      this.store.emit('reset', this.store.state);
    } else if (this.index.engagements.length) {
      this.open(this.index.engagements.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
    } else {
      this.create({ mode: this.seed === 'empty' ? 'empty' : 'example' });
    }
    this.store.on('change', () => this.touchSoon());
    this.store.on('project', () => this.touchSoon());
    this.store.on('reset', () => this.touchSoon());
  }

  // Before engagements existed, a hub kept one state.json. Keep it, as an engagement.
  migrateLegacy() {
    const legacy = path.join(this.dir, 'state.json');
    if (!fs.existsSync(legacy)) return;
    this.store.switchTo(legacy);
    const id = this.store.state.project.id;
    const target = this.fileFor(id);
    if (!fs.existsSync(target)) fs.copyFileSync(legacy, target);
    fs.renameSync(legacy, `${legacy}.migrated`);
    this.store.switchTo(target);
    this.upsertEntry();
    if (!this.index.current) this.index.current = id;
    this.saveIndex();
  }

  entry(id) { return this.index.engagements.find((e) => e.id === id) || null; }

  upsertEntry(store = this.store) {
    const p = store.state.project;
    const items = store.state.items;
    const e = this.entry(p.id) || { id: p.id, createdAt: p.createdAt || Date.now() };
    Object.assign(e, {
      name: p.name,
      example: Boolean(p.example),
      updatedAt: Date.now(),
      stats: {
        targets: Object.keys(items.target).length,
        findings: Object.keys(items.finding).length,
        agents: Object.keys(items.agent).length,
      },
    });
    if (!this.entry(p.id)) this.index.engagements.push(e);
    return e;
  }

  saveIndex() {
    const tmp = `${this.indexFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.index, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.indexFile);
  }

  touchSoon() {
    clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => { this.upsertEntry(); this.saveIndex(); }, 500);
    this.touchTimer.unref?.();
  }

  list() {
    this.upsertEntry();
    return {
      current: this.store.state.project.id,
      engagements: this.index.engagements.slice().sort((a, b) => (b.id === this.index.current) - (a.id === this.index.current) || b.updatedAt - a.updatedAt),
    };
  }

  // Find a hunt by id or by name (case-insensitive).
  resolve(ref) {
    if (!ref) return null;
    const r = String(ref).trim().toLowerCase();
    return this.index.engagements.find((e) => e.id === ref) || this.index.engagements.find((e) => e.name.toLowerCase() === r) || null;
  }

  // The store for a hunt: the one on screen, or a second one loaded for an agent working elsewhere.
  storeFor(ref) {
    const e = this.resolve(ref);
    if (!e) { const err = new Error(`no hunt "${ref}". Start it first (recon_start_engagement / recon start "<name>").`); err.status = 404; throw err; }
    if (e.id === this.store.state.project.id) return this.store;
    let s = this.side.get(e.id);
    if (!s) {
      s = new Store({ encryptionKey: this.encryptionKey });
      s.switchTo(this.fileFor(e.id));
      this.side.set(e.id, s);
      let t = null;
      s.on('change', (evt) => {
        clearTimeout(t);
        t = setTimeout(() => { this.upsertEntry(s); this.saveIndex(); }, 500);
        this.onSide?.(e.id, s, evt);
      });
    }
    return s;
  }

  // Every hunt that is open right now: the one on screen and any an agent is working in.
  loaded() {
    return [this.store, ...this.side.values()].map((store) => ({ id: store.state.project.id, name: store.state.project.name, store }));
  }

  // Give a hunt's file back to the main store: the side copy is saved and dropped.
  releaseSide(id) {
    const s = this.side.get(id);
    if (!s) return;
    s.flush();
    s.removeAllListeners();
    this.side.delete(id);
  }

  // Create a hunt without changing what the human is looking at.
  createDetached({ name }) {
    const s = new Store({ encryptionKey: this.encryptionKey });
    s.switchTo(null, { fresh: true });
    seedEmpty(s, name || 'New hunt');
    s.file = this.fileFor(s.state.project.id);
    s.flush();
    this.upsertEntry(s);
    this.saveIndex();
    return this.entry(s.state.project.id);
  }

  // Start a new engagement and make it current. The previous one is saved, not touched.
  create({ name, mode = 'empty', doc = null } = {}) {
    if (this.store.file) { this.store.flush(); this.snapshot({ force: true }); }
    if (doc) {
      const state = normalizeState(doc);
      if (this.entry(state.project.id)) state.project.id = newId('target').replace('tg_', 'pj_');
      if (name) state.project.name = name;
      this.store.switchTo(this.fileFor(state.project.id), { fresh: true });
      this.store.replace(state, 'human');
    } else {
      this.store.switchTo(null, { fresh: true });
      if (mode === 'example') seedExample(this.store); else seedEmpty(this.store, name || 'New engagement');
      this.store.file = this.fileFor(this.store.state.project.id);
    }
    this.store.flush();
    this.index.current = this.store.state.project.id;
    this.upsertEntry();
    this.saveIndex();
    this.store.emit('reset', this.store.state);
    return this.entry(this.index.current);
  }

  open(id) {
    const e = this.entry(id);
    if (!e) throw notFound(id);
    if (this.store.state.project.id === id && this.store.file === this.fileFor(id)) return e;
    if (this.store.file) { this.store.flush(); this.snapshot({ force: true }); }
    this.releaseSide(id);
    this.store.switchTo(this.fileFor(id));
    this.index.current = id;
    this.upsertEntry();
    this.saveIndex();
    this.store.emit('reset', this.store.state);
    return e;
  }

  findByName(name) {
    const n = String(name).trim().toLowerCase();
    return this.index.engagements.find((e) => e.name.toLowerCase() === n && !e.trashed) || null;
  }

  update(id, { name, archived } = {}) {
    const e = this.entry(id);
    if (!e) throw notFound(id);
    if (typeof archived === 'boolean') e.archived = archived;
    if (typeof name === 'string' && name.trim()) {
      e.name = name.trim().slice(0, 120);
      if (id === this.store.state.project.id) this.store.setProject({ name: e.name }, 'human');
    }
    this.saveIndex();
    return e;
  }

  // Removing moves the file to trash; it can always be brought back.
  remove(id) {
    if (id === this.store.state.project.id) throw new Error('open another engagement before removing this one');
    const e = this.entry(id);
    if (!e) throw notFound(id);
    const trash = path.join(this.dir, 'trash');
    fs.mkdirSync(trash, { recursive: true });
    if (fs.existsSync(this.fileFor(id))) fs.renameSync(this.fileFor(id), path.join(trash, `${safe(id)}.json`));
    this.index.engagements = this.index.engagements.filter((x) => x.id !== id);
    this.saveIndex();
    return { ok: true, trashedTo: path.join(trash, `${safe(id)}.json`) };
  }

  // ---------- snapshots ----------

  maybeSnapshot(now = Date.now()) {
    for (const [id, s] of this.side) {
      const last = this.sideRev.get(id) || { rev: -1, at: 0 };
      if (s.rev !== last.rev && now - last.at >= SNAPSHOT_EVERY) { this.snapshot({ now, store: s }); this.sideRev.set(id, { rev: s.rev, at: now }); }
    }
    if (this.store.rev === this.lastSnapshotRev) return null;
    if (now - this.lastSnapshotAt < SNAPSHOT_EVERY) return null;
    return this.snapshot({ now });
  }

  snapshot({ force = false, now = Date.now(), store = this.store } = {}) {
    const main = store === this.store;
    if (main && !force && store.rev === this.lastSnapshotRev) return null;
    const id = store.state.project.id;
    const dir = this.snapDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    let file = path.join(dir, `${stamp}.json`);
    for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `${stamp}-${n}.json`);
    fs.writeFileSync(file, store.serialize(), { mode: 0o600 });
    if (main) { this.lastSnapshotRev = store.rev; this.lastSnapshotAt = now; }
    this.prune(id, now);
    return path.basename(file);
  }

  // Keep everything from the last 48 hours, then the newest snapshot of each day, forever.
  prune(id, now = Date.now()) {
    const dir = this.snapDir(id);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
    const keptDays = new Set();
    for (const f of files) {
      const at = parseSnap(f);
      if (now - at < KEEP_ALL_FOR) continue;
      const day = new Date(at).toISOString().slice(0, 10);
      if (keptDays.has(day)) fs.rmSync(path.join(dir, f), { force: true });
      else keptDays.add(day);
    }
  }

  snapshots(id) {
    const dir = this.snapDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
      .map((f) => ({ id: f, at: parseSnap(f), size: fs.statSync(path.join(dir, f)).size }));
  }

  restore(id, snapshotId) {
    const e = this.entry(id);
    if (!e) throw notFound(id);
    const src = path.join(this.snapDir(id), path.basename(String(snapshotId)));
    if (!fs.existsSync(src)) throw notFound(snapshotId);
    if (this.store.state.project.id === id) { this.store.flush(); this.snapshot({ force: true }); }
    fs.copyFileSync(src, this.fileFor(id));
    if (this.store.state.project.id === id) {
      this.store.switchTo(this.fileFor(id), { save: false });
      this.store.log({ by: 'human', action: 'imported', kind: 'project', summary: `restored the snapshot from ${new Date(parseSnap(snapshotId)).toLocaleString()}` });
      this.store.emit('reset', this.store.state);
    }
    return { ok: true };
  }

  close() {
    clearTimeout(this.touchTimer);
    for (const id of [...this.side.keys()]) this.releaseSide(id);
    try { this.upsertEntry(); this.saveIndex(); } catch { /* best effort */ }
  }
}

function parseSnap(f) {
  const m = String(f).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0;
}

function safe(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function notFound(id) {
  const err = new Error(`no engagement or snapshot "${id}"`);
  err.status = 404;
  return err;
}
