// Live client state. One websocket keeps a local copy of the project in sync;
// every view reads from here and re-renders on change. Writes go through the
// rest api and come back over the socket, so every tab and agent sees the same thing.

const listeners = new Set();
const KEY_STORE = 'recon.key';

export const live = {
  state: null,
  connected: false,
  recent: new Map(), // itemId -> ts of last change (drives glow)
  lastWriteBy: new Map(), // author -> ts (drives agent pulses)
  lastEvent: 0,
};

export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(evt) {
  for (const fn of listeners) {
    try { fn(evt); } catch (err) { console.error(err); }
  }
}

function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}

export function setKey(k) {
  try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
}

// ---------- rest ----------

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  const headers = {};
  const key = getKey();
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401) emit({ type: 'auth' });
    throw new ApiError(res.status, data?.error || res.statusText);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

export const write = {
  create: (kind, fields) => post(`/api/items/${kind}`, fields),
  update: (kind, id, fields) => patch(`/api/items/${kind}/${id}`, fields),
  remove: (kind, id) => del(`/api/items/${kind}/${id}`),
  evidence: (kind, id, ev) => post(`/api/items/${kind}/${id}/evidence`, ev),
  removeEvidence: (kind, id, eid) => del(`/api/items/${kind}/${id}/evidence/${eid}`),
};

// ---------- socket ----------

let ws = null;
let backoff = 500;
let pingTimer = null;

export function connect() {
  const key = getKey();
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${key ? `?token=${encodeURIComponent(key)}` : ''}`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    backoff = 500;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'ping' })); }, 20000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (live.connected) { live.connected = false; emit({ type: 'status' }); }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.7, 8000);
  };
  ws.onerror = () => {
    // a failed upgrade is often an auth problem in server mode
    fetch('/api/state', { headers: key ? { authorization: `Bearer ${key}` } : {} }).then((r) => { if (r.status === 401) emit({ type: 'auth' }); }).catch(() => {});
  };
}

function handle(msg) {
  const now = Date.now();
  live.lastEvent = now;
  switch (msg.t) {
    case 'hello': {
      const first = !live.state;
      live.state = normalize(msg.state);
      live.connected = true;
      emit({ type: first ? 'hello' : 'reset', first });
      emit({ type: 'status' });
      break;
    }
    case 'reset':
      live.state = normalize(msg.state);
      live.recent.clear();
      emit({ type: 'reset' });
      break;
    case 'change': {
      if (!live.state) return;
      const { op, kind, item, activity } = msg;
      const bucket = live.state.items[kind] || (live.state.items[kind] = {});
      const prev = bucket[item.id];
      if (op === 'remove') delete bucket[item.id];
      else bucket[item.id] = item;
      if (activity) {
        live.state.activity.push(activity);
        if (live.state.activity.length > 400) live.state.activity.splice(0, live.state.activity.length - 400);
        live.lastWriteBy.set(activity.by, now);
        if (activity.itemId) live.recent.set(activity.itemId, now);
      } else {
        live.recent.set(item.id, now);
      }
      emit({ type: 'change', op, kind, item, prev, activity });
      break;
    }
    case 'health':
      if (live.state) { live.state.health = msg.health; emit({ type: 'health' }); }
      break;
    case 'suggestions':
      if (live.state) { live.state.suggestions = msg.list; emit({ type: 'suggestions' }); }
      break;
    case 'project':
      if (live.state) { live.state.project = msg.project; emit({ type: 'project' }); }
      break;
    default:
  }
}

function normalize(s) {
  for (const k of ['agent', 'target', 'component', 'assumption', 'hypothesis', 'finding', 'steer', 'proposal']) {
    s.items[k] = s.items[k] || {};
  }
  s.activity = s.activity || [];
  s.health = s.health || {};
  s.suggestions = s.suggestions || [];
  return s;
}

// ---------- selectors ----------

export const KIND_LABEL = {
  agent: 'agent', target: 'target', component: 'component', assumption: 'assumption',
  hypothesis: 'hypothesis', finding: 'finding', steer: 'steer', proposal: 'proposal',
};

export function list(kind, pred) {
  const all = Object.values(live.state?.items[kind] || {});
  const out = pred ? all.filter(pred) : all;
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function byId(id) {
  if (!id || !live.state) return null;
  for (const map of Object.values(live.state.items)) if (map[id]) return map[id];
  return null;
}

export function titleOf(item) {
  if (!item) return '';
  return item.name || item.title || item.text || item.note || item.id;
}

export function agentOf(author) {
  if (!author) return null;
  return live.state?.items.agent[author] || null;
}

export function authorName(author) {
  if (!author) return 'someone';
  if (author.startsWith('human')) return 'You';
  return agentOf(author)?.name || author.replace(/^ag_/, '');
}

export function authorColor(author) {
  if (!author || author.startsWith('human')) return null;
  return agentOf(author)?.color || '#a5d8ff';
}

export function healthOf(agentId) {
  return live.state?.health?.[agentId] || { status: 'idle', flags: [] };
}

export function activeAgents() {
  return list('agent').filter((a) => healthOf(a.id).status !== 'offline');
}

export function coverage(targetId) {
  const comps = list('component', (c) => !targetId || c.targetId === targetId);
  const counts = { untouched: 0, scanning: 0, reviewed: 0, flagged: 0 };
  for (const c of comps) counts[c.reviewState] = (counts[c.reviewState] || 0) + 1;
  const total = comps.length;
  const done = counts.reviewed + counts.flagged;
  return { counts, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

export function steersFor(itemId, { includeAddressed = false } = {}) {
  return list('steer', (s) => s.itemId === itemId && (includeAddressed || s.state !== 'addressed'));
}

export function historyOf(itemId) {
  return (live.state?.activity || []).filter((a) => a.itemId === itemId);
}

export function isRecent(id, ms = 2500) {
  const t = live.recent.get(id);
  return t && Date.now() - t < ms;
}

export function agentIsWriting(agentId, ms = 4000) {
  const t = live.lastWriteBy.get(agentId);
  return t && Date.now() - t < ms;
}

export function agentsCount() {
  return Object.keys(live.state?.items.agent || {}).length;
}
