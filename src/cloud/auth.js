// Accounts for hosted recon: passkeys to sign in, a recovery code in case every
// passkey is lost, signed session cookies, and API keys for agents. Nothing
// secret is stored in the clear: keys and recovery codes as SHA-256 hashes,
// passkeys as public keys.

import crypto from 'node:crypto';
import { verifyRegistration, verifyAssertion, b64url } from './webauthn.js';

const SESSION_DAYS = 30;
const CHALLENGE_MINUTES = 5;

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n) => crypto.randomBytes(n).toString('base64url');

export function createAuth({ db, secret, origin: fixedOrigin = null }) {
  if (!secret || secret.length < 32) throw new Error('RECON_SECRET must be set to at least 32 random characters');
  const sign = (payload) => {
    const body = b64url.enc(Buffer.from(JSON.stringify(payload)));
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  };
  const unsign = (token) => {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    try { const p = JSON.parse(b64url.dec(body).toString('utf8')); return p.exp && p.exp < Date.now() ? null : p; } catch { return null; }
  };

  // The site a passkey belongs to. Fixed in production (RECON_ORIGIN), so preview
  // deployments cannot mint passkeys for the real site.
  const site = (req) => {
    if (fixedOrigin) { const u = new URL(fixedOrigin); return { origin: u.origin, rpId: u.hostname }; }
    const host = String(req.headers.host || '');
    const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https');
    return { origin: `${proto}://${host}`, rpId: host.replace(/:\d+$/, '') };
  };

  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const secure = (req) => site(req).origin.startsWith('https:');
  const cookie = (req, name, value, maxAgeSec) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure(req) ? '; Secure' : ''}`;

  async function sessionUser(req) {
    const s = unsign(cookies(req).recon_session);
    if (!s?.uid) return null;
    const u = await db.user(s.uid);
    if (!u || u.sessionVersion !== s.v) return null;
    return u;
  }

  function startSession(req, user) {
    return cookie(req, 'recon_session', sign({ uid: user.id, v: user.sessionVersion || 1, exp: Date.now() + SESSION_DAYS * 86400_000 }), SESSION_DAYS * 86400);
  }

  // A challenge travels in a short-lived signed cookie: no table, no state on the server.
  function challengeCookie(req, kind, extra = {}) {
    const challenge = rand(32);
    return { challenge, setCookie: cookie(req, 'recon_challenge', sign({ kind, challenge, exp: Date.now() + CHALLENGE_MINUTES * 60_000, ...extra }), CHALLENGE_MINUTES * 60) };
  }
  function takeChallenge(req, kind) {
    const c = unsign(cookies(req).recon_challenge);
    if (!c || c.kind !== kind) throw new AuthError(400, 'this sign-in took too long or was started elsewhere; try again');
    return c;
  }
  const clearChallenge = (req) => cookie(req, 'recon_challenge', '', 0);

  function newRecoveryCode() {
    const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
    return raw.match(/.{4}/g).join('-');
  }

  const pubKeyParams = [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }];

  // ---------- the routes ----------
  // Each returns { status, json, setCookies }.

  const routes = {
    async 'POST /auth/register/options'(req, body) {
      const name = String(body?.name || '').trim().slice(0, 60);
      if (!name) throw new AuthError(400, 'choose a name for your account');
      const { origin, rpId } = site(req);
      void origin;
      const userId = rand(16);
      const { challenge, setCookie } = challengeCookie(req, 'register', { userId, name });
      return {
        json: {
          challenge, rp: { name: 'recon', id: rpId }, user: { id: userId, name, displayName: name },
          pubKeyCredParams: pubKeyParams, timeout: 300000, attestation: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
        },
        setCookies: [setCookie],
      };
    },
    async 'POST /auth/register/verify'(req, body) {
      const c = takeChallenge(req, 'register');
      const { origin, rpId } = site(req);
      let key;
      try { key = verifyRegistration(body?.credential, { challenge: c.challenge, origin, rpId }); } catch (err) { throw new AuthError(400, `the passkey was not accepted: ${err.message}`); }
      const recovery = newRecoveryCode();
      const user = { id: `u_${c.userId}`, name: c.name, createdAt: Date.now(), recoveryHash: sha256hex(recovery), sessionVersion: 1 };
      await db.createUser(user, { ...key, label: String(body?.label || 'First passkey').slice(0, 60), createdAt: Date.now() });
      return { json: { ok: true, user: { id: user.id, name: user.name }, recoveryCode: recovery }, setCookies: [clearChallenge(req), startSession(req, user)] };
    },
    async 'POST /auth/login/options'(req) {
      const { rpId } = site(req);
      const { challenge, setCookie } = challengeCookie(req, 'login');
      return { json: { challenge, rpId, timeout: 300000, userVerification: 'preferred', allowCredentials: [] }, setCookies: [setCookie] };
    },
    async 'POST /auth/login/verify'(req, body) {
      const c = takeChallenge(req, 'login');
      const cred = body?.credential;
      const stored = cred?.id ? await db.passkey(cred.id) : null;
      if (!stored) throw new AuthError(401, 'this passkey is not registered here');
      const { origin, rpId } = site(req);
      let r;
      try { r = verifyAssertion(cred, stored, { challenge: c.challenge, origin, rpId }); } catch (err) { throw new AuthError(401, `sign-in failed: ${err.message}`); }
      await db.touchPasskey(stored.id, r.counter);
      const user = await db.user(stored.userId);
      if (!user) throw new AuthError(401, 'this account no longer exists');
      return { json: { ok: true, user: { id: user.id, name: user.name } }, setCookies: [clearChallenge(req), startSession(req, user)] };
    },
    // Every passkey lost: the recovery code signs you in once, and is replaced.
    async 'POST /auth/recover'(req, body) {
      const code = String(body?.code || '').trim().toUpperCase();
      const uid = String(body?.account || '').trim();
      const user = uid ? await db.user(uid) : null;
      if (!user || !user.recoveryHash || !code || !crypto.timingSafeEqual(Buffer.from(sha256hex(code)), Buffer.from(user.recoveryHash))) throw new AuthError(401, 'that account id and recovery code do not match');
      const next = newRecoveryCode();
      await db.updateUser(user.id, { recoveryHash: sha256hex(next), bumpSessions: true });
      const fresh = await db.user(user.id);
      return { json: { ok: true, user: { id: user.id, name: user.name }, recoveryCode: next, addPasskey: true }, setCookies: [startSession(req, fresh)] };
    },
    async 'POST /auth/logout'(req) {
      return { json: { ok: true }, setCookies: [cookie(req, 'recon_session', '', 0)] };
    },
    async 'GET /auth/me'(req) {
      const u = await sessionUser(req);
      if (!u) return { json: { user: null } };
      const [keys, passkeys] = await Promise.all([db.apiKeys(u.id), db.passkeys(u.id)]);
      return { json: { user: { id: u.id, name: u.name, createdAt: u.createdAt }, apiKeys: keys, passkeys: passkeys.map((k) => ({ id: k.id, label: k.label, createdAt: k.createdAt, lastUsed: k.lastUsed })) } };
    },
    // signed in: add another passkey (another device), or the first one after recovery
    async 'POST /auth/passkeys/options'(req) {
      const u = await must(req);
      const { rpId } = site(req);
      const existing = await db.passkeys(u.id);
      const { challenge, setCookie } = challengeCookie(req, 'add-passkey', { uid: u.id });
      return {
        json: {
          challenge, rp: { name: 'recon', id: rpId }, user: { id: u.id.replace(/^u_/, ''), name: u.name, displayName: u.name },
          pubKeyCredParams: pubKeyParams, timeout: 300000, attestation: 'none',
          excludeCredentials: existing.map((k) => ({ type: 'public-key', id: k.id })),
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
        },
        setCookies: [setCookie],
      };
    },
    async 'POST /auth/passkeys/verify'(req, body) {
      const u = await must(req);
      const c = takeChallenge(req, 'add-passkey');
      if (c.uid !== u.id) throw new AuthError(400, 'start again');
      const { origin, rpId } = site(req);
      let key;
      try { key = verifyRegistration(body?.credential, { challenge: c.challenge, origin, rpId }); } catch (err) { throw new AuthError(400, `the passkey was not accepted: ${err.message}`); }
      await db.addPasskey(u.id, { ...key, label: String(body?.label || 'Passkey').slice(0, 60), createdAt: Date.now() });
      return { json: { ok: true }, setCookies: [clearChallenge(req)] };
    },
    async 'POST /auth/passkeys/remove'(req, body) {
      const u = await must(req);
      const keys = await db.passkeys(u.id);
      if (keys.length <= 1) throw new AuthError(400, 'this is your only passkey: add another before removing it');
      await db.removePasskey(u.id, String(body?.id || ''));
      return { json: { ok: true } };
    },
    async 'POST /auth/keys'(req, body) {
      const u = await must(req);
      const key = `rk_${rand(32)}`;
      const label = String(body?.label || 'agent').trim().slice(0, 60) || 'agent';
      await db.addApiKey(u.id, { hash: sha256hex(key), label, prefix: key.slice(0, 9), createdAt: Date.now() });
      return { json: { ok: true, key, label } };
    },
    async 'POST /auth/keys/remove'(req, body) {
      const u = await must(req);
      await db.removeApiKey(u.id, String(body?.id || ''));
      return { json: { ok: true } };
    },
    async 'POST /auth/recovery/rotate'(req) {
      const u = await must(req);
      const next = newRecoveryCode();
      await db.updateUser(u.id, { recoveryHash: sha256hex(next) });
      return { json: { ok: true, recoveryCode: next } };
    },
    async 'POST /auth/signout-everywhere'(req) {
      const u = await must(req);
      await db.updateUser(u.id, { bumpSessions: true });
      return { json: { ok: true }, setCookies: [cookie(req, 'recon_session', '', 0)] };
    },
    async 'POST /auth/delete'(req, body) {
      const u = await must(req);
      if (String(body?.confirm || '') !== u.name) throw new AuthError(400, `type your account name (${u.name}) to confirm`);
      await db.deleteUser(u.id);
      return { json: { ok: true }, setCookies: [cookie(req, 'recon_session', '', 0)] };
    },
  };

  async function must(req) {
    const u = await sessionUser(req);
    if (!u) throw new AuthError(401, 'sign in first');
    return u;
  }

  // Who is calling the board: a signed-in person (cookie) or an agent (API key).
  async function identify(req) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-recon-key'] || '');
    if (token) {
      if (!token.startsWith('rk_')) throw new AuthError(401, 'invalid api key');
      const k = await db.apiKey(sha256hex(token));
      if (!k) throw new AuthError(401, 'invalid or revoked api key: make a new one on your account page');
      return { tenant: k.userId, role: 'any', via: 'key' };
    }
    const u = await sessionUser(req);
    if (!u) throw new AuthError(401, 'sign in at /login, or send an api key as a bearer token');
    return { tenant: u.id, role: 'any', via: 'session', user: u };
  }

  return { routes, identify, sessionUser, site };
}
