// A small client for the hub's api, shared by the cli and the mcp server.

import { DEFAULT_PORT } from './config.js';

const PREFIX_KIND = {
  ag: 'agent', tg: 'target', cp: 'component', as: 'assumption', hy: 'hypothesis', fd: 'finding', st: 'steer', pr: 'proposal',
  rl: 'relation', ch: 'chain', ld: 'lead', ms: 'message', ru: 'rule',
};

export class ReconError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export function defaultUrl(env = process.env) {
  return (env.RECON_URL || `http://127.0.0.1:${env.RECON_PORT || DEFAULT_PORT}`).replace(/\/$/, '');
}

export function createClient({ url = defaultUrl(), key = process.env.RECON_KEY, agent = null, transport = 'cli', model = null, hunt = null, headers: extra = {}, fetch: fetchImpl = globalThis.fetch } = {}) {
  const base = url.replace(/\/$/, '');

  async function req(method, path, body) {
    const headers = { accept: 'application/json', ...extra };
    if (hunt) headers['x-recon-hunt'] = encodeURIComponent(hunt);
    if (key) headers.authorization = `Bearer ${key}`;
    if (agent) { headers['x-recon-agent'] = agent; headers['x-recon-transport'] = transport; }
    if (model) headers['x-recon-model'] = model;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new ReconError(0, `cannot reach the recon hub at ${base} (${err.cause?.code || err.message}). start it with: recon serve`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new ReconError(res.status, data?.error || `${res.status} ${res.statusText}`, data?.details);
    return data;
  }

  const api = {
    url: base,
    agent,
    hunt,
    req,
    health: () => req('GET', '/api/health'),
    pulse: () => req('GET', '/api/pulse'),
    report: () => req('GET', '/api/report'),
    setReport: (fields) => req('PATCH', '/api/report', fields),
    rules: (target) => req('GET', `/api/rules${target ? `?target=${encodeURIComponent(target)}` : ''}`),
    dismiss: (id, reason) => req('POST', `/api/suggestions/${encodeURIComponent(id)}/dismiss`, { reason }),
    wait: (timeout = 25) => req('GET', `/api/wait?timeout=${timeout}`),
    say: (text, extra = {}) => req('POST', '/api/items/message', { text, ...extra }),
    reportBrief: () => req('GET', '/api/report/brief'),
    submitReport: (documents) => req('POST', '/api/report/submit', { documents }),
    skills: () => req('GET', '/api/skills'),
    skill: (id) => req('GET', `/api/skills/${encodeURIComponent(id)}`),
    addSkill: (skill) => req('POST', '/api/skills', skill),
    updateSkill: (id, fields) => req('PUT', `/api/skills/${encodeURIComponent(id)}`, fields),
    removeSkill: (id) => req('DELETE', `/api/skills/${encodeURIComponent(id)}`),
    checkFinding: (id) => req('GET', `/api/findings/${encodeURIComponent(id)}/check`),
    state: () => req('GET', '/api/state'),
    model: () => req('GET', '/api/model'),
    briefing: (name) => req('GET', `/api/briefing${!agent && name ? `?agent=${encodeURIComponent(name)}` : ''}`),
    list: (kind, filter = {}) => req('GET', `/api/items/${kind}${qs(filter)}`),
    get: (kind, id) => req('GET', `/api/items/${kind}/${encodeURIComponent(id)}`),
    create: (kind, fields) => req('POST', `/api/items/${kind}`, fields),
    update: (kind, id, fields) => req('PATCH', `/api/items/${kind}/${encodeURIComponent(id)}`, fields),
    remove: (kind, id) => req('DELETE', `/api/items/${kind}/${encodeURIComponent(id)}`),
    evidence: (kind, id, ev) => req('POST', `/api/items/${kind}/${encodeURIComponent(id)}/evidence`, ev),
    steer: (id, verb, response) => req('POST', `/api/steers/${encodeURIComponent(id)}/${verb}`, response ? { response } : {}),
    proposal: (id, verb, choice) => req('POST', `/api/proposals/${encodeURIComponent(id)}/${verb}`, choice ? { choice } : {}),
    claim: (ids) => req('POST', '/api/claim', { componentIds: ids }),
    heartbeat: (fields) => req('POST', '/api/heartbeat', fields),
    suggestions: () => req('GET', '/api/suggestions'),
    acceptSuggestion: (id, body = {}) => req('POST', `/api/suggestions/${id}/accept`, body),
    playbooks: () => req('GET', '/api/playbooks'),
    playbook: (type) => req('GET', `/api/playbooks/${encodeURIComponent(type)}`),
    activity: (since = 0) => req('GET', `/api/activity?since=${since}`),
    merge: (doc) => req('POST', '/api/merge', doc),
    exportProject: () => req('GET', '/api/export'),
    importProject: (doc) => req('POST', '/api/import', doc),
    reset: (mode, name) => req('POST', '/api/reset', { mode, name }),
    start: (name) => req('POST', '/api/start', { name }),
    engagements: () => req('GET', '/api/engagements'),
    newEngagement: (name, mode = 'empty') => req('POST', '/api/engagements', { name, mode }),
    openEngagement: (id) => req('POST', `/api/engagements/${encodeURIComponent(id)}/open`, {}),
    snapshots: (id) => req('GET', `/api/engagements/${encodeURIComponent(id)}/snapshots`),
    snapshot: (id) => req('POST', `/api/engagements/${encodeURIComponent(id)}/snapshots`, {}),
    restore: (id, snapshot) => req('POST', `/api/engagements/${encodeURIComponent(id)}/restore`, { snapshot }),

    // Resolve "cp_abc", or a name/title like "Vault.withdraw()", to {kind, item}.
    async resolve(ref, kindHint) {
      const k = kindHint || PREFIX_KIND[String(ref).split('_')[0]];
      if (k) {
        try { const r = await api.get(k, ref); return { kind: k, item: r.item }; } catch (err) { if (err.status !== 404) throw err; }
      }
      const s = await api.state();
      const needle = String(ref).toLowerCase();
      const kinds = kindHint ? [kindHint] : Object.keys(s.items);
      for (const kind of kinds) {
        for (const it of Object.values(s.items[kind] || {})) {
          if (it.id === ref) return { kind, item: it };
        }
      }
      const matches = [];
      for (const kind of kinds) {
        for (const it of Object.values(s.items[kind] || {})) {
          const name = String(it.name || it.title || it.text || '').toLowerCase();
          if (name === needle) return { kind, item: it };
          if (name.includes(needle)) matches.push({ kind, item: it });
        }
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new ReconError(400, `"${ref}" matches ${matches.length} items: ${matches.slice(0, 5).map((m) => `${m.item.id} (${m.item.name || m.item.title || m.item.text})`).join(', ')}`);
      throw new ReconError(404, `nothing called "${ref}"`);
    },
  };
  return api;
}

function qs(filter) {
  const entries = Object.entries(filter).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

export function kindOfId(id) {
  return PREFIX_KIND[String(id).split('_')[0]] || null;
}
