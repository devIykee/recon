// Hosted recon: one request handler for Vercel (or any Node host) that adds what a
// public service needs around the same hub the local app runs: a landing page,
// accounts with passkeys, API keys for agents, a private workspace per account
// kept in the database, and live updates by polling instead of a websocket.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHub } from '../hub.js';
import { ROOT } from '../config.js';
import { createAuth, AuthError } from './auth.js';
import { Workspaces } from './sync.js';
import { ConflictError } from './db.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
};

const security = (extra = {}) => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...extra,
});

export function createCloud({ db, secret, origin = null, root = path.join('/tmp', 'recon-cloud'), log = (...a) => console.error(...a) }) {
  const auth = createAuth({ db, secret, origin });
  const spaces = new Workspaces({ db, root });
  const token = crypto.randomBytes(24).toString('hex'); // marks requests this layer authenticated
  const als = new AsyncLocalStorage();
  const locks = new Map();

  // one request per workspace at a time on this instance; other instances are kept honest by versions
  function lock(tenant) {
    const prev = locks.get(tenant) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chain = prev.then(() => mine);
    locks.set(tenant, chain);
    chain.then(() => { if (locks.get(tenant) === chain) locks.delete(tenant); });
    return prev.then(() => release);
  }

  const hub = createHub({
    mode: 'multi', dataDir: root, hosted: true, realtime: 'poll', snapshots: false, demo: false, seed: 'empty', log,
    authenticate: (req) => {
      const [t, tenant] = String(req.headers['x-recon-cloud'] || '').split(' ');
      if (!t || t.length !== token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token)) || !tenant) throw new AuthError(401, 'sign in at /login, or send an api key as a bearer token');
      return { tenant, role: 'any', agent: null };
    },
    mcpSessions: {
      get: (id) => (id ? db.mcpSession(id) : null),
      set: (id, s) => db.saveMcpSession(id, s),
      delete: async () => {},
    },
    // while an agent waits for the human: save, let other requests in, then catch up
    sleepFresh: async (tenant, ms) => {
      const ctx = als.getStore();
      try { await persist(tenant); } catch (err) { if (!(err instanceof ConflictError)) throw err; }
      ctx?.release();
      await new Promise((r) => setTimeout(r, ms));
      if (ctx) ctx.release = await lock(tenant);
      await refresh(tenant);
    },
  });

  async function refresh(tenant) {
    if (await spaces.pull(tenant)) hub.dropTenant(tenant);
  }
  async function persist(tenant) {
    hub.flushTenant(tenant);
    try { await spaces.push(tenant); } catch (err) {
      if (err instanceof ConflictError) { hub.dropTenant(tenant); spaces.reset(tenant); }
      throw err;
    }
  }

  // Run fn against an up-to-date workspace and save what it changed; replay on a conflict.
  async function inWorkspace(tenant, fn) {
    for (let attempt = 0; ; attempt++) {
      const ctx = { release: await lock(tenant) };
      try {
        await refresh(tenant);
        const out = await als.run(ctx, fn);
        await persist(tenant);
        return out;
      } catch (err) {
        if (err instanceof ConflictError && attempt < 3) continue;
        throw err;
      } finally {
        ctx.release();
      }
    }
  }

  // ---------- pages ----------

  function sendFile(res, file, { cache = 'no-cache', status = 200 } = {}) {
    let body;
    try { body = fs.readFileSync(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
    res.writeHead(status, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': body.length, 'cache-control': cache, ...security() });
    res.end(body);
  }
  function sendJson(res, status, data, headers = {}) {
    const body = JSON.stringify(data ?? null);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...security(), ...headers });
    res.end(body);
  }
  const redirect = (res, to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); };

  function staticFile(url) {
    const p = decodeURIComponent(url.pathname);
    const map = [['/img/', path.join(ROOT, 'docs', 'img')], ['/css/', path.join(ROOT, 'web', 'css')], ['/js/', path.join(ROOT, 'web', 'js')], ['/fonts/', path.join(ROOT, 'web', 'fonts')]];
    for (const [prefix, dir] of map) {
      if (!p.startsWith(prefix)) continue;
      const file = path.normalize(path.join(dir, p.slice(prefix.length)));
      if (!file.startsWith(dir + path.sep)) return null;
      return file;
    }
    if (p === '/favicon.svg' || p === '/favicon.ico') return path.join(ROOT, 'web', 'favicon.svg');
    return null;
  }

  async function readBody(req, limit = 4 << 20) {
    if (req.body !== undefined && typeof req.body !== 'object') return String(req.body);
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new AuthError(413, 'body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // same-origin writes only, as on a local board
  function checkOrigin(req) {
    const o = req.headers.origin;
    if (!o || o === 'null') return;
    let host;
    try { host = new URL(o).host; } catch { throw new AuthError(403, 'bad origin'); }
    if (host !== req.headers.host) throw new AuthError(403, 'cross-origin request refused');
  }

  // ---------- the handler ----------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    try {
      delete req.headers['x-recon-cloud'];
      delete req.headers['x-recon-internal'];
      if (req.method === 'GET' || req.method === 'HEAD') {
        const file = staticFile(url);
        if (file) return sendFile(res, file, { cache: p.startsWith('/fonts/') || p.startsWith('/img/') ? 'public, max-age=604800' : 'public, max-age=300' });
        if (p === '/' || p === '/app') {
          const user = await auth.sessionUser(req).catch(() => null);
          return sendFile(res, path.join(ROOT, 'web', user ? 'index.html' : 'landing.html'));
        }
        if (p === '/login') return sendFile(res, path.join(ROOT, 'web', 'login.html'));
        if (p === '/account') {
          const user = await auth.sessionUser(req).catch(() => null);
          return user ? sendFile(res, path.join(ROOT, 'web', 'account.html')) : redirect(res, '/login');
        }
      }

      if (p.startsWith('/auth/')) {
        if (req.method !== 'GET') checkOrigin(req);
        const fn = auth.routes[`${req.method} ${p}`];
        if (!fn) return sendJson(res, 404, { error: 'not found' });
        let body = null;
        if (req.method === 'POST') { const raw = await readBody(req, 64 << 10); try { body = raw ? JSON.parse(raw) : {}; } catch { throw new AuthError(400, 'invalid json'); } }
        const out = await fn(req, body);
        return sendJson(res, out.status || 200, out.json, out.setCookies ? { 'set-cookie': out.setCookies } : {});
      }

      if (p === '/ws') return sendJson(res, 404, { error: 'hosted recon updates by polling; reload the page' });

      if (p.startsWith('/api/') || p === '/mcp') {
        if (p === '/api/health') {
          const who = await auth.identify(req).catch(() => null);
          return sendJson(res, 200, { ok: true, name: 'recon', hosted: true, realtime: 'poll', signedIn: Boolean(who), via: who?.via });
        }
        const who = await auth.identify(req);
        const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
        const headers = { ...req.headers, 'x-recon-cloud': `${token} ${who.tenant}` };
        const hunt = String(req.headers['x-recon-hunt'] || url.searchParams.get('hunt') || '');
        const out = await inWorkspace(who.tenant, async () => {
          // the board polls: answer "no change" without running anything
          if (req.method === 'GET' && p === '/api/state') {
            const etag = `"${spaces.signature(who.tenant)}:${crypto.createHash('sha1').update(hunt).digest('hex').slice(0, 8)}"`;
            if (spaces.signature(who.tenant) && req.headers['if-none-match'] === etag) return { status: 304, headers: { etag }, body: Buffer.alloc(0) };
          }
          return hub.dispatchCaptured({ method: req.method, url: req.url, headers, body, remoteAddress: req.socket?.remoteAddress });
        });
        if (req.method === 'GET' && p === '/api/state' && out.status === 200) out.headers.etag = `"${spaces.signature(who.tenant)}:${crypto.createHash('sha1').update(hunt).digest('hex').slice(0, 8)}"`;
        res.writeHead(out.status, { ...out.headers, ...security(), 'cache-control': 'no-store' });
        return res.end(out.body);
      }

      return sendFile(res, path.join(ROOT, 'web', 'landing.html'), { status: 404 });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log(err);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: status >= 500 ? 'something went wrong on our side; try again' : err.message });
    }
  }

  return { handle, hub, auth, spaces };
}
