// Outbound webhooks: push steers and proposal decisions to sleeping agents.
//
// Zero dependencies: uses node:crypto for Stripe-style HMAC-SHA256 signing and
// global fetch for delivery. Works identically on a local hub (JSON file store
// with in-process debounce + retry timers) and on hosted Vercel (Postgres queue
// in src/cloud/db.js + inline first attempt + cron retry endpoint).

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const WEBHOOK_EVENTS = Object.freeze(['steer.created', 'steer.reopened', 'proposal.decided', 'agent.test']);
export const DEFAULT_EVENTS = Object.freeze(['steer.created', 'steer.reopened', 'proposal.decided']);
export const BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000, 3_600_000]);
export const MAX_RETRY_AGE_MS = 24 * 60 * 60_000;
const RETRY_STATUS = new Set([408, 429]);

// ---------- signing & verification ----------

function hmacHex(secret, timestampSec, rawBody) {
  return crypto.createHmac('sha256', String(secret)).update(`${timestampSec}.${rawBody}`).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Stripe-style signature header: t=<unix>,v1=<hex>[,v1=<prevHex>]
export function sign(secretOrSecrets, timestampSec, rawBody) {
  const secrets = (Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets]).filter(Boolean);
  const t = Math.floor(Number(timestampSec));
  const sigs = secrets.map((s) => `v1=${hmacHex(s, t, rawBody)}`);
  return `t=${t},${sigs.join(',')}`;
}

export function verifySignature(header, secretOrSecrets, rawBody, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(header || '').split(',').map((p) => p.trim()).filter(Boolean);
  let t = null;
  const v1 = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === 't') t = Number(v);
    else if (k === 'v1') v1.push(v);
  }
  if (!Number.isFinite(t) || !v1.length) return { ok: false, error: 'missing timestamp or v1 signature' };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, error: `timestamp outside ${toleranceSec}s tolerance window` };
  const secrets = (Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets]).filter(Boolean);
  for (const s of secrets) {
    const expected = hmacHex(s, t, rawBody);
    if (v1.some((got) => safeEqual(got, expected))) return { ok: true, timestamp: t };
  }
  return { ok: false, error: 'signature mismatch' };
}

export function newSecret(prefix = 'whsec_') {
  return `${prefix}${crypto.randomBytes(24).toString('hex')}`;
}

export function newEventId() {
  return `evt_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

// ---------- URL validation (SSRF guard) ----------

function isPrivateIp(host) {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v = net.isIP(clean);
  if (v === 4) {
    const [a, b] = clean.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    if (clean === '::1' || clean === '::') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true; // ULA
    if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) return true; // link-local
    if (clean.startsWith('::ffff:')) return isPrivateIp(clean.slice(7));
    return false;
  }
  return false;
}

export function validateWebhookUrl(rawUrl, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch { throw new Error('webhook url must be a valid URL'); }
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:')) {
    throw new Error('webhook url must use https://');
  }
  if (u.username || u.password) throw new Error('webhook url must not include credentials');
  const host = u.hostname.toLowerCase();
  if (!allowLocal) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new Error(`webhook host "${host}" is private/loopback and refused`);
    }
    if (isPrivateIp(host)) throw new Error(`webhook IP "${host}" is private/loopback and refused`);
  }
  return { url: u.toString(), host: u.host };
}

// ---------- local file-backed webhook store ----------

export function fileWebhookStore(filePath) {
  let data = { webhooks: {}, deliveries: [] };
  if (filePath && fs.existsSync(filePath)) {
    try { data = { webhooks: {}, deliveries: [], ...JSON.parse(fs.readFileSync(filePath, 'utf8')) }; } catch { /* fresh */ }
  }
  const save = () => {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  };
  const key = (tenant, agentId) => `${tenant}\n${agentId}`;
  return {
    async getWebhook(tenant, agentId) { return data.webhooks[key(tenant, agentId)] ? { ...data.webhooks[key(tenant, agentId)] } : null; },
    async listWebhooks(tenant) {
      return Object.entries(data.webhooks).filter(([k]) => k.startsWith(`${tenant}\n`)).map(([, v]) => ({ ...v }));
    },
    async saveWebhook(w) { data.webhooks[key(w.tenant, w.agentId)] = { ...w }; save(); return { ...w }; },
    async deleteWebhook(tenant, agentId) { delete data.webhooks[key(tenant, agentId)]; save(); },
    async saveDelivery(d) {
      const idx = data.deliveries.findIndex((x) => x.id === d.id);
      if (idx >= 0) data.deliveries[idx] = { ...d };
      else data.deliveries.push({ ...d });
      if (data.deliveries.length > 500) data.deliveries = data.deliveries.slice(-500);
      save();
      return { ...d };
    },
    async listDeliveries(tenant, agentId, limit = 20) {
      return data.deliveries
        .filter((d) => d.tenant === tenant && (!agentId || d.agentId === agentId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    },
    async dueDeliveries(nowMs, limit = 50) {
      return data.deliveries
        .filter((d) => d.status === 'retrying' && d.nextAttemptAt && d.nextAttemptAt <= nowMs)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit);
    },
  };
}

// ---------- webhook sender & manager ----------

export function sanitizeConfig(w) {
  if (!w) return null;
  return {
    agentId: w.agentId,
    url: w.url,
    host: w.host,
    events: w.events,
    auth: w.auth,
    status: w.status || 'active',
    lastStatus: w.lastStatus || null,
    lastDeliveryAt: w.lastDeliveryAt || null,
    failCount: w.failCount || 0,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function wakeSummary(w) {
  if (!w) return {};
  return {
    via: 'webhook',
    host: w.host,
    auth: w.auth,
    events: w.events,
    lastStatus: w.lastStatus || 'ready',
    lastDeliveryAt: w.lastDeliveryAt || null,
    failCount: w.failCount || 0,
  };
}

export function createWebhookManager({
  store,
  fetch: fetchImpl = globalThis.fetch,
  hosted = false,
  allowLocal = false,
  debounceMs = 3000,
  attemptTimeoutMs = 3000,
  now = () => Date.now(),
  waitUntil = null,
  onStatus = null,
} = {}) {
  const pending = new Map(); // `${tenant}\n${agentId}` -> { timer, events: [] }
  const retryTimers = new Map();

  function scheduleLocalRetry(d) {
    if (hosted || !d.nextAttemptAt) return;
    const delay = Math.max(50, d.nextAttemptAt - now());
    if (retryTimers.has(d.id)) clearTimeout(retryTimers.get(d.id));
    const t = setTimeout(() => {
      retryTimers.delete(d.id);
      deliverRecord(d).catch(() => {});
    }, Math.min(delay, 2_147_000_000));
    t.unref?.();
    retryTimers.set(d.id, t);
  }

  async function deliverRecord(record) {
    const cfg = await store.getWebhook(record.tenant, record.agentId);
    if (!cfg) {
      record.status = 'failed';
      record.error = 'webhook removed';
      record.nextAttemptAt = null;
      await store.saveDelivery(record);
      return record;
    }
    const tsSec = Math.floor(now() / 1000);
    const rawBody = typeof record.payload === 'string' ? record.payload : JSON.stringify(record.payload);
    const secrets = [cfg.secret, cfg.prevSecret && cfg.prevSecretUntil > now() ? cfg.prevSecret : null].filter(Boolean);
    const headers = {
      'content-type': 'application/json',
      'recon-event-id': record.eventId,
      'recon-delivery-attempt': String(record.attempt),
      'recon-signature': sign(secrets, tsSec, rawBody),
    };
    if (cfg.auth === 'bearer') headers.authorization = `Bearer ${cfg.secret}`;

    let httpStatus = 0;
    let error = null;
    try {
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });
      httpStatus = res.status;
      if (res.ok) {
        record.status = 'delivered';
        record.httpStatus = httpStatus;
        record.error = null;
        record.deliveredAt = now();
        record.nextAttemptAt = null;
        cfg.lastStatus = 'delivered';
        cfg.lastDeliveryAt = record.deliveredAt;
        cfg.failCount = 0;
        cfg.status = 'active';
        await store.saveDelivery(record);
        await store.saveWebhook(cfg);
        onStatus?.(record.tenant, record.agentId, wakeSummary(cfg));
        return record;
      }
      error = `HTTP ${res.status} ${res.statusText || ''}`.trim();
    } catch (err) {
      error = err?.name === 'TimeoutError' ? 'request timed out' : (err?.cause?.code || err?.message || 'network error');
    }

    const retryable = httpStatus === 0 || httpStatus >= 500 || RETRY_STATUS.has(httpStatus);
    const age = now() - record.createdAt;
    const nextBackoff = BACKOFF_MS[Math.min(record.attempt - 1, BACKOFF_MS.length - 1)];

    record.httpStatus = httpStatus || null;
    record.error = error;
    if (retryable && age + nextBackoff <= MAX_RETRY_AGE_MS) {
      record.status = 'retrying';
      record.attempt += 1;
      record.nextAttemptAt = now() + nextBackoff;
      cfg.failCount = (cfg.failCount || 0) + 1;
      cfg.lastStatus = cfg.failCount >= 3 ? 'failing' : 'retrying';
      cfg.status = cfg.failCount >= 3 ? 'failing' : 'active';
    } else {
      record.status = 'failed';
      record.nextAttemptAt = null;
      cfg.failCount = (cfg.failCount || 0) + 1;
      cfg.lastStatus = 'failing';
      cfg.status = 'failing';
    }
    await store.saveDelivery(record);
    await store.saveWebhook(cfg);
    onStatus?.(record.tenant, record.agentId, wakeSummary(cfg));
    if (record.status === 'retrying') scheduleLocalRetry(record);
    return record;
  }

  async function sendPayload(tenant, agentId, { type, hunt, agent, data, reply, steerIds = [] }) {
    const eventId = newEventId();
    const created = Math.floor(now() / 1000);
    const payload = { id: eventId, type, created, hunt, agent, data, reply };
    const record = {
      id: `dlv_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
      eventId,
      tenant,
      agentId,
      type,
      steerIds,
      payload: JSON.stringify(payload),
      attempt: 1,
      status: 'queued',
      httpStatus: null,
      error: null,
      nextAttemptAt: null,
      createdAt: now(),
      deliveredAt: null,
    };
    await store.saveDelivery(record);
    return deliverRecord(record);
  }

  async function flushBatch(key) {
    const bucket = pending.get(key);
    if (!bucket) return null;
    pending.delete(key);
    if (bucket.timer) clearTimeout(bucket.timer);
    const list = bucket.events;
    if (!list.length) return null;
    const last = list[list.length - 1];
    const steers = list.map((e) => e.data?.steer).filter(Boolean);
    const steerIds = steers.map((s) => s.id);
    const data = steers.length > 1
      ? { steer: steers[steers.length - 1], steers, pending: last.data?.pending ?? steers.length }
      : last.data;
    return sendPayload(last.tenant, last.agentId, {
      type: last.type,
      hunt: last.hunt,
      agent: last.agent,
      data,
      reply: last.reply,
      steerIds,
    });
  }

  return {
    async register(tenant, agentId, { url, events, auth = 'hmac', secret } = {}) {
      const parsed = validateWebhookUrl(url, { allowLocal });
      const mode = auth === 'bearer' ? 'bearer' : 'hmac';
      const evs = Array.isArray(events) && events.length
        ? events.filter((e) => WEBHOOK_EVENTS.includes(e))
        : [...DEFAULT_EVENTS];
      if (!evs.length) throw new Error(`events must include at least one of: ${WEBHOOK_EVENTS.join(', ')}`);
      const existing = await store.getWebhook(tenant, agentId);
      const sec = (mode === 'bearer' && typeof secret === 'string' && secret.trim()) ? secret.trim() : newSecret();
      const ts = now();
      const w = {
        tenant,
        agentId,
        url: parsed.url,
        host: parsed.host,
        events: evs,
        auth: mode,
        secret: sec,
        prevSecret: null,
        prevSecretUntil: 0,
        status: 'active',
        lastStatus: existing?.lastStatus || 'ready',
        lastDeliveryAt: existing?.lastDeliveryAt || null,
        failCount: 0,
        createdAt: existing?.createdAt || ts,
        updatedAt: ts,
      };
      await store.saveWebhook(w);
      onStatus?.(tenant, agentId, wakeSummary(w));
      return { secret: sec, config: sanitizeConfig(w) };
    },

    async rotate(tenant, agentId, { secret, graceMs = 24 * 60 * 60_000 } = {}) {
      const w = await store.getWebhook(tenant, agentId);
      if (!w) throw new Error(`no webhook registered for agent "${agentId}"`);
      const next = (w.auth === 'bearer' && typeof secret === 'string' && secret.trim()) ? secret.trim() : newSecret();
      w.prevSecret = w.secret;
      w.prevSecretUntil = now() + graceMs;
      w.secret = next;
      w.updatedAt = now();
      await store.saveWebhook(w);
      return { secret: next, config: sanitizeConfig(w) };
    },

    async get(tenant, agentId) {
      const w = await store.getWebhook(tenant, agentId);
      if (!w) return null;
      const recent = await store.listDeliveries(tenant, agentId, 1);
      return { config: sanitizeConfig(w), lastDelivery: recent[0] ? publicDelivery(recent[0]) : null };
    },

    async remove(tenant, agentId) {
      await store.deleteWebhook(tenant, agentId);
      onStatus?.(tenant, agentId, null);
      return { ok: true };
    },

    async deliveries(tenant, agentId, limit = 20) {
      const rows = await store.listDeliveries(tenant, agentId, Math.min(Math.max(Number(limit) || 20, 1), 100));
      return rows.map(publicDelivery);
    },

    async steerStatuses(tenant) {
      const rows = await store.listDeliveries(tenant, null, 100);
      const out = {};
      for (const r of rows) {
        for (const sid of r.steerIds || []) {
          if (!out[sid]) out[sid] = { status: r.status, attempt: r.attempt, httpStatus: r.httpStatus, error: r.error, at: r.deliveredAt || r.createdAt };
        }
      }
      return out;
    },

    async sendTest(tenant, agentId, { hunt, agent, board }) {
      const w = await store.getWebhook(tenant, agentId);
      if (!w) throw new Error(`no webhook registered for agent "${agentId}"`);
      const rec = await sendPayload(tenant, agentId, {
        type: 'agent.test',
        hunt,
        agent,
        data: { message: 'Test event from recon board' },
        reply: { mcp_tool: 'recon_briefing', board },
      });
      return publicDelivery(rec);
    },

    async notify(tenant, agentId, { type, hunt, agent, data, reply, steerIds = [], isListening = false }) {
      if (isListening) return { skipped: 'listening' };
      const w = await store.getWebhook(tenant, agentId);
      if (!w || !w.events.includes(type)) return { skipped: 'not-subscribed' };

      if (hosted || debounceMs <= 0 || !['steer.created', 'steer.reopened'].includes(type)) {
        const p = sendPayload(tenant, agentId, { type, hunt, agent, data, reply, steerIds });
        if (waitUntil) { waitUntil(p); return { queued: true }; }
        return publicDelivery(await p);
      }

      const key = `${tenant}\n${agentId}`;
      let bucket = pending.get(key);
      if (!bucket) {
        bucket = { events: [], timer: null };
        pending.set(key, bucket);
      }
      bucket.events.push({ tenant, agentId, type, hunt, agent, data, reply, steerIds });
      if (bucket.timer) clearTimeout(bucket.timer);
      bucket.timer = setTimeout(() => { flushBatch(key).catch(() => {}); }, debounceMs);
      bucket.timer.unref?.();
      return { debounced: true };
    },

    async retryDue(limit = 50) {
      const due = await store.dueDeliveries(now(), limit);
      const results = [];
      for (const d of due) results.push(publicDelivery(await deliverRecord(d)));
      return { checked: due.length, results };
    },

    close() {
      for (const b of pending.values()) if (b.timer) clearTimeout(b.timer);
      pending.clear();
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
    },
  };
}

function publicDelivery(d) {
  return {
    id: d.id,
    eventId: d.eventId,
    agentId: d.agentId,
    type: d.type,
    steerIds: d.steerIds || [],
    attempt: d.attempt,
    status: d.status,
    httpStatus: d.httpStatus,
    error: d.error,
    nextAttemptAt: d.nextAttemptAt,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt,
  };
}
