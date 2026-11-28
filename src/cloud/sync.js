// A user's workspace is the same set of files a local hub keeps on disk (the hunt
// index, one file per hunt, skills). Hosted, the files live in the database; a
// function instance keeps a working copy in /tmp, brings it up to date before a
// request, and writes back what changed after it, each file only if nobody else
// changed it in the meantime.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
// snapshots are not kept hosted (they would grow without bound); everything else is
const skip = (rel) => rel.startsWith('snapshots/') || rel.endsWith('.tmp') || /\.tmp-\d+/.test(rel);

function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

export class Workspaces {
  constructor({ db, root }) {
    this.db = db;
    this.root = root;
    this.known = new Map(); // tenant -> Map(path -> { version, hash })
  }

  dir(tenant) { return path.join(this.root, 'tenants', tenant); }

  // Bring the working copy up to date. Returns true when anything changed.
  async pull(tenant) {
    const dir = this.dir(tenant);
    let known = this.known.get(tenant);
    if (!known) {
      // first time on this instance: start from a clean folder
      fs.rmSync(dir, { recursive: true, force: true });
      known = new Map();
      this.known.set(tenant, known);
    }
    const versions = await this.db.fileVersions(tenant);
    const stale = [...versions].filter(([p, v]) => known.get(p)?.version !== v).map(([p]) => p);
    const gone = [...known.keys()].filter((p) => !versions.has(p));
    if (!stale.length && !gone.length) return false;
    for (const f of await this.db.readFiles(tenant, stale)) {
      const file = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.content);
      known.set(f.path, { version: f.version, hash: hash(f.content) });
    }
    for (const p of gone) { fs.rmSync(path.join(dir, p), { force: true }); known.delete(p); }
    return true;
  }

  // The version signature of the workspace: changes whenever any file does.
  signature(tenant) {
    const known = this.known.get(tenant);
    if (!known) return '';
    return hash([...known].sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => `${p}:${v.version}`).join('|'));
  }

  // Write back what this request changed. Throws ConflictError if another writer got there first.
  async push(tenant) {
    const dir = this.dir(tenant);
    const known = this.known.get(tenant) || new Map();
    const onDisk = walk(dir).filter((p) => !skip(p));
    const changes = [];
    const contents = new Map();
    for (const p of onDisk) {
      const content = fs.readFileSync(path.join(dir, p), 'utf8');
      const h = hash(content);
      if (known.get(p)?.hash === h) continue;
      contents.set(p, h);
      changes.push({ path: p, content, version: known.get(p)?.version || 0 });
    }
    for (const [p, k] of known) if (!onDisk.includes(p)) changes.push({ path: p, deleted: true, version: k.version });
    if (!changes.length) return 0;
    const done = await this.db.writeFiles(tenant, changes);
    for (const d of done) {
      if (!d.version) known.delete(d.path);
      else known.set(d.path, { version: d.version, hash: contents.get(d.path) });
    }
    this.known.set(tenant, known);
    return changes.length;
  }

  // Forget this instance's copy (after a conflict): the next pull starts clean.
  reset(tenant) {
    this.known.delete(tenant);
  }
}
