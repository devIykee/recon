// Storage for hosted recon. Vercel functions keep nothing between requests, so
// everything a user has lives here: accounts, passkeys, api keys, mcp sessions,
// and their workspace (the same files a local hub keeps in ~/.recon/data, one
// row per file, each with a version so two writers can never overwrite each
// other unnoticed).
//
// Two backends with one interface: Neon Postgres over its HTTPS endpoint (no
// driver needed), and memory for tests.

const SCHEMA = [
  `create table if not exists recon_users (
     id text primary key, name text not null, created_at bigint not null,
     session_version int not null default 1, recovery_hash text)`,
  `create table if not exists recon_passkeys (
     id text primary key, user_id text not null references recon_users(id) on delete cascade,
     public_key text not null, alg int not null, counter bigint not null default 0,
     transports text, label text, created_at bigint not null, last_used bigint)`,
  'create index if not exists recon_passkeys_user on recon_passkeys(user_id)',
  `create table if not exists recon_api_keys (
     hash text primary key, user_id text not null references recon_users(id) on delete cascade,
     label text, prefix text not null, created_at bigint not null, last_used bigint)`,
  'create index if not exists recon_api_keys_user on recon_api_keys(user_id)',
  `create table if not exists recon_files (
     tenant text not null, path text not null, content text not null,
     version int not null, updated_at bigint not null, primary key (tenant, path))`,
  `create table if not exists recon_mcp_sessions (
     id text primary key, tenant text not null, agent text, hunt text, at bigint not null)`,
];

export class ConflictError extends Error {
  constructor(path) { super(`${path} changed underneath this write`); this.name = 'ConflictError'; this.status = 409; }
}

// ---------- Neon over HTTPS ----------

export function neon(connectionString) {
  const u = new URL(connectionString.replace(/^postgres(ql)?:/, 'https:'));
  const endpoint = `https://${u.hostname}/sql`;
  const headers = {
    'content-type': 'application/json',
    'neon-connection-string': connectionString,
    'neon-raw-text-output': 'true',
    'neon-array-mode': 'false',
  };
  async function post(body, extra = {}) {
    const res = await fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }
    if (!res.ok) { const err = new Error(`database: ${data.message || res.statusText}`); err.code = data.code; throw err; }
    return data;
  }
  const rows = (r) => r.rows || [];
  const sql = async (query, params = []) => rows(await post({ query, params: params.map(paramText) }));
  // several statements in one transaction
  const tx = async (queries) => (await post({ queries: queries.map(([query, params = []]) => ({ query, params: params.map(paramText) })) }, { 'neon-batch-isolation-level': 'Serializable' })).results.map(rows);
  return adapter({ sql, tx, kind: 'neon' });
}

const paramText = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
const n = (v) => (v === null || v === undefined ? null : Number(v));

function adapter({ sql, tx, kind }) {
  let ready = null;
  const migrate = () => { ready ||= tx(SCHEMA.map((q) => [q])).catch((err) => { ready = null; throw err; }); return ready; };
  const userRow = (r) => r && ({ id: r.id, name: r.name, createdAt: n(r.created_at), sessionVersion: n(r.session_version), recoveryHash: r.recovery_hash });
  const keyRow = (r) => r && ({ id: r.id, userId: r.user_id, publicKey: r.public_key, alg: n(r.alg), counter: n(r.counter), transports: r.transports ? JSON.parse(r.transports) : [], label: r.label, createdAt: n(r.created_at), lastUsed: n(r.last_used) });
  return {
    kind,
    migrate,
    async createUser(u, passkey) {
      await migrate();
      await tx([
        ['insert into recon_users (id, name, created_at, recovery_hash) values ($1, $2, $3, $4)', [u.id, u.name, u.createdAt, u.recoveryHash]],
        ['insert into recon_passkeys (id, user_id, public_key, alg, counter, transports, label, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', [passkey.id, u.id, passkey.publicKey, passkey.alg, passkey.counter, JSON.stringify(passkey.transports || []), passkey.label, passkey.createdAt]],
      ]);
    },
    async user(id) { await migrate(); return userRow((await sql('select * from recon_users where id = $1', [id]))[0]); },
    async updateUser(id, fields) {
      await migrate();
      if (fields.recoveryHash !== undefined) await sql('update recon_users set recovery_hash = $2 where id = $1', [id, fields.recoveryHash]);
      if (fields.bumpSessions) await sql('update recon_users set session_version = session_version + 1 where id = $1', [id]);
      if (fields.name) await sql('update recon_users set name = $2 where id = $1', [id, fields.name]);
    },
    async deleteUser(id) { await migrate(); await tx([['delete from recon_files where tenant = $1', [id]], ['delete from recon_mcp_sessions where tenant = $1', [id]], ['delete from recon_users where id = $1', [id]]]); },
    async addPasskey(userId, k) { await migrate(); await sql('insert into recon_passkeys (id, user_id, public_key, alg, counter, transports, label, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)', [k.id, userId, k.publicKey, k.alg, k.counter, JSON.stringify(k.transports || []), k.label, k.createdAt]); },
    async passkey(id) { await migrate(); return keyRow((await sql('select * from recon_passkeys where id = $1', [id]))[0]); },
    async passkeys(userId) { await migrate(); return (await sql('select * from recon_passkeys where user_id = $1 order by created_at', [userId])).map(keyRow); },
    async touchPasskey(id, counter) { await migrate(); await sql('update recon_passkeys set counter = $2, last_used = $3 where id = $1', [id, counter, Date.now()]); },
    async removePasskey(userId, id) { await migrate(); await sql('delete from recon_passkeys where user_id = $1 and id = $2', [userId, id]); },
    async addApiKey(userId, k) { await migrate(); await sql('insert into recon_api_keys (hash, user_id, label, prefix, created_at) values ($1, $2, $3, $4, $5)', [k.hash, userId, k.label, k.prefix, k.createdAt]); },
    async apiKey(hash) {
      await migrate();
      const r = (await sql('select * from recon_api_keys where hash = $1', [hash]))[0];
      if (!r) return null;
      // awaited (at most once a minute per key): a serverless function can be frozen
      // the moment it answers, so a write left running in the background may never land
      if (!r.last_used || Date.now() - n(r.last_used) > 60_000) await sql('update recon_api_keys set last_used = $2 where hash = $1', [hash, Date.now()]).catch(() => {});
      return { userId: r.user_id, label: r.label, prefix: r.prefix };
    },
    async apiKeys(userId) { await migrate(); return (await sql('select hash, label, prefix, created_at, last_used from recon_api_keys where user_id = $1 order by created_at', [userId])).map((r) => ({ id: r.hash.slice(0, 16), label: r.label, prefix: r.prefix, createdAt: n(r.created_at), lastUsed: n(r.last_used) })); },
    async removeApiKey(userId, id) { await migrate(); await sql('delete from recon_api_keys where user_id = $1 and left(hash, 16) = $2', [userId, id]); },
    // workspace files
    async fileVersions(tenant) { await migrate(); return new Map((await sql('select path, version from recon_files where tenant = $1', [tenant])).map((r) => [r.path, n(r.version)])); },
    async readFiles(tenant, paths) {
      await migrate();
      if (!paths.length) return [];
      return (await sql('select path, content, version from recon_files where tenant = $1 and path = any($2::text[])', [tenant, `{${paths.map((p) => `"${p.replace(/["\\]/g, '\\$&')}"`).join(',')}}`])).map((r) => ({ path: r.path, content: r.content, version: n(r.version) }));
    },
    // write changed files; each must still be at the version this request read, or nothing is written
    async writeFiles(tenant, changes) {
      await migrate();
      if (!changes.length) return [];
      const now = Date.now();
      // Each statement divides by the number of rows it touched: a write whose version no
      // longer matches touches none, raises division by zero, and the whole batch rolls back.
      const guarded = (cte) => `with u as (${cte}) select (select version from u) as version, 1 / (select count(*) from u)::int as ok`;
      const queries = changes.map((c) => (c.deleted
        ? [guarded('delete from recon_files where tenant = $1 and path = $2 and version = $3 returning 0 as version'), [tenant, c.path, c.version]]
        : c.version
          ? [guarded('update recon_files set content = $3, version = version + 1, updated_at = $5 where tenant = $1 and path = $2 and version = $4 returning version'), [tenant, c.path, c.content, c.version, now]]
          : [guarded('insert into recon_files (tenant, path, content, version, updated_at) values ($1, $2, $3, 1, $4) on conflict do nothing returning version'), [tenant, c.path, c.content, now]]));
      let results;
      try { results = await tx(queries); } catch (err) {
        if (err.code === '22012' || /division by zero|could not serialize/i.test(err.message)) throw new ConflictError('workspace');
        throw err;
      }
      return results.map((r, i) => ({ path: changes[i].path, version: changes[i].deleted ? 0 : n(r[0].version) }));
    },
    async mcpSession(id) { await migrate(); const r = (await sql('select * from recon_mcp_sessions where id = $1', [id]))[0]; return r && { tenant: r.tenant, agent: r.agent, hunt: r.hunt, at: n(r.at) }; },
    async saveMcpSession(id, s) { await migrate(); await sql('insert into recon_mcp_sessions (id, tenant, agent, hunt, at) values ($1, $2, $3, $4, $5) on conflict (id) do update set agent = $3, hunt = $4, at = $5', [id, s.tenant, s.agent, s.hunt || null, Date.now()]); },
  };
}

// ---------- memory, for tests and local trials ----------

export function memoryDb() {
  const users = new Map();
  const passkeys = new Map();
  const apiKeys = new Map();
  const files = new Map(); // `${tenant}\n${path}` -> { content, version }
  const sessions = new Map();
  const fk = (t, p) => `${t}\n${p}`;
  return {
    kind: 'memory',
    files,
    async migrate() {},
    async createUser(u, k) { users.set(u.id, { ...u, sessionVersion: 1 }); passkeys.set(k.id, { ...k, userId: u.id }); },
    async user(id) { return users.get(id) ? { ...users.get(id) } : null; },
    async updateUser(id, f) { const u = users.get(id); if (!u) return; if (f.recoveryHash !== undefined) u.recoveryHash = f.recoveryHash; if (f.bumpSessions) u.sessionVersion++; if (f.name) u.name = f.name; },
    async deleteUser(id) { users.delete(id); for (const [k, v] of passkeys) if (v.userId === id) passkeys.delete(k); for (const [k, v] of apiKeys) if (v.userId === id) apiKeys.delete(k); for (const k of files.keys()) if (k.startsWith(`${id}\n`)) files.delete(k); },
    async addPasskey(userId, k) { passkeys.set(k.id, { ...k, userId }); },
    async passkey(id) { return passkeys.get(id) ? { ...passkeys.get(id) } : null; },
    async passkeys(userId) { return [...passkeys.values()].filter((k) => k.userId === userId); },
    async touchPasskey(id, counter) { const k = passkeys.get(id); if (k) { k.counter = counter; k.lastUsed = Date.now(); } },
    async removePasskey(userId, id) { const k = passkeys.get(id); if (k?.userId === userId) passkeys.delete(id); },
    async addApiKey(userId, k) { apiKeys.set(k.hash, { ...k, userId }); },
    async apiKey(hash) { const k = apiKeys.get(hash); if (!k) return null; k.lastUsed = Date.now(); return { userId: k.userId, label: k.label, prefix: k.prefix }; },
    async apiKeys(userId) { return [...apiKeys.values()].filter((k) => k.userId === userId).map((k) => ({ id: k.hash.slice(0, 16), label: k.label, prefix: k.prefix, createdAt: k.createdAt, lastUsed: k.lastUsed || null })); },
    async removeApiKey(userId, id) { for (const [h, k] of apiKeys) if (k.userId === userId && h.slice(0, 16) === id) apiKeys.delete(h); },
    async fileVersions(t) { const out = new Map(); for (const [k, v] of files) if (k.startsWith(`${t}\n`)) out.set(k.slice(t.length + 1), v.version); return out; },
    async readFiles(t, paths) { return paths.filter((p) => files.has(fk(t, p))).map((p) => ({ path: p, ...files.get(fk(t, p)) })); },
    async writeFiles(t, changes) {
      for (const c of changes) {
        const cur = files.get(fk(t, c.path));
        if ((cur?.version || 0) !== (c.version || 0)) throw new ConflictError(c.path);
      }
      return changes.map((c) => {
        if (c.deleted) { files.delete(fk(t, c.path)); return { path: c.path, version: 0 }; }
        const version = (c.version || 0) + 1;
        files.set(fk(t, c.path), { content: c.content, version });
        return { path: c.path, version };
      });
    },
    async mcpSession(id) { return sessions.get(id) || null; },
    async saveMcpSession(id, s) { sessions.set(id, { ...s, at: Date.now() }); },
  };
}
