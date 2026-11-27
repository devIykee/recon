// The recon hub: one process that holds live state and serves everything else.
//   - the web ui (static files)
//   - the rest api        /api/*
//   - the live feed       /ws (websocket)
//   - drop-in json        watched files/urls merged into state
//   - the mcp server and cli talk to it over the same api

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, agentIdFor, label } from './store.js';
import { WsServer } from './ws.js';
import { suggest, briefing, playbook, allPlaybooks, GLOSSARY, checklistFor, CLASSES } from './knowledge.js';
import { describeModel, isKind, ENUMS, KINDS } from './model.js';
import { healthAll } from './health.js';
import { DemoAgent } from './demo.js';
import { Engagements } from './engagements.js';
import { mustDo, pulse, whereWeLeftOff } from './proactive.js';
import { cardGaps, severityProblem, evidenceGaps, duplicateOf, reportedMatch, openSteersFor } from './quality.js';
import { buildReport, reportBrief, checkSubmission } from './report.js';
import { Skills, SkillError } from './skills.js';
import { playbookFor } from './knowledge.js';
import { watchSource } from './dropin.js';
import { loadConfig, ROOT } from './config.js';
import { createClient } from './client.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- tenants ----------

// What should wake a waiting agent: steers to it that it has not acknowledged,
// and its proposals the human decided since it last woke.
function wakeEvents(state, agentId, since) {
  const steers = openSteersFor(state, agentId).map((s) => {
    const item = s.itemId ? Object.values(state.items).map((m) => m[s.itemId]).find(Boolean) : null;
    return { type: 'steer', id: s.id, action: s.action, note: s.note, item: item ? { id: item.id, kind: item.kind, title: label(item) } : null, at: s.createdAt };
  });
  const decided = Object.values(state.items.proposal)
    .filter((p) => p.createdBy === agentId && p.state !== 'pending' && p.updatedAt > since)
    .map((p) => ({ type: 'decision', id: p.id, text: p.text, state: p.state, choice: p.choice || '', at: p.updatedAt }));
  return [...steers, ...decided];
}

// What the human already decided about the report, so agents do not ask again.
// The reasons and the documents are on recon_write_report.
function reportStatus(t) {
  const r = buildReport(t.store.state);
  const cfg = r.config;
  return {
    shape: cfg.shape || 'not chosen: ask with recon_propose',
    signedBy: cfg.signOff || 'not set: ask with recon_propose',
    ready: r.included.map((f) => f.id),
    notReady: r.excluded.map((f) => f.id),
    due: r.missing.length + r.stale.length || undefined,
  };
}

function stopListening(store, agentId) {
  const agent = store.get('agent', agentId);
  if (!agent?.waitingSince) return;
  delete agent.waitingSince;
  agent.updatedAt = store.tick();
  store.emitChange('upsert', 'agent', agent, null);
}

class Tenant {
  constructor(id, cfg) {
    this.id = id;
    this.cfg = cfg;
    const dir = cfg.mode === 'multi' ? path.join(cfg.dataDir, 'tenants', id) : cfg.dataDir;
    this.store = new Store({ encryptionKey: cfg.encryptionKey });
    this.engagements = new Engagements(dir, this.store, { seed: cfg.mode === 'multi' ? 'empty' : cfg.seed, log: cfg.log, encryptionKey: cfg.encryptionKey });
    try { this.engagements.init(); } catch (err) {
      cfg.log(`recon: could not open the engagements in ${dir}: ${err.message}`);
      throw err;
    }
    this.skills = new Skills(dir);
    this.demo = new DemoAgent(this.store, { log: cfg.log });
    this.watchers = [];
    this.lastHealth = '';
    this.syncDemo();
    this.store.on('reset', () => this.syncDemo());
    this.store.on('project', () => this.syncDemo());
  }

  syncDemo() {
    const want = this.cfg.demo && this.store.state.project.example && !this.store.state.project.demoPaused;
    if (want) this.demo.start(); else this.demo.stop();
  }

  close() {
    this.demo.stop();
    for (const w of this.watchers) w.close();
    this.store.flush();
    this.engagements.close();
  }
}

// ---------- hub ----------

export function createHub(overrides = {}) {
  const cfg = loadConfig(overrides);
  const log = cfg.log;
  const tenants = new Map();
  const ws = new WsServer();
  // Requests the hub makes to itself (the http mcp endpoint) carry this; nobody else knows it.
  const internalToken = crypto.randomBytes(24).toString('hex');
  const mcpSessions = new Map();

  function tenant(id = 'default') {
    let t = tenants.get(id);
    if (!t) {
      t = new Tenant(id, cfg);
      tenants.set(id, t);
      wire(t);
    }
    return t;
  }

  // Live broadcast for one tenant.
  function wire(t) {
    const send = (msg) => ws.broadcast(msg, (c) => c.meta.tenant === t.id);
    let sugTimer = null;
    const pushSuggestions = () => {
      clearTimeout(sugTimer);
      sugTimer = setTimeout(() => send({ t: 'suggestions', list: suggest(t.store.state, { limit: 12 }) }), 400);
    };
    t.store.on('change', ({ op, kind, item, activity }) => {
      send({ t: 'change', op, kind, item, activity });
      pushSuggestions();
    });
    t.store.on('reset', () => send({ t: 'reset', state: statePayload(t) }));
    // an agent working in a hunt that is not on screen: tell the board so the human can switch
    let lastHuntPing = 0;
    t.engagements.onSide = (id, s, evt) => {
      if (!evt.activity || Date.now() - lastHuntPing < 4000) return;
      lastHuntPing = Date.now();
      send({ t: 'hunt-activity', hunt: { id, name: s.state.project.name }, activity: evt.activity, agent: s.state.items.agent[evt.activity.by]?.name || evt.activity.by });
    };
    t.store.on('project', (project) => { send({ t: 'project', project }); pushSuggestions(); });
  }

  // ---------- auth ----------

  function authenticate(req, url) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (url.searchParams.get('token') || req.headers['x-recon-key'] || '');
    if (cfg.mode === 'multi') {
      if (!token) throw new HttpError(401, 'missing api key');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const entry = cfg.tenants.find((k) => (k.key && safeEqual(k.key, token)) || (k.hash && safeEqual(k.hash, hash)));
      if (!entry) throw new HttpError(401, 'invalid api key');
      return { tenant: entry.tenant, role: entry.role || 'any', agent: entry.agent || null };
    }
    if (cfg.key) {
      if (!token || !safeEqual(cfg.key, token)) throw new HttpError(401, 'missing or invalid key');
    }
    return { tenant: 'default', role: 'any', agent: null };
  }

  // DNS-rebinding guard: a local hub only answers to localhost names.
  function checkHost(req) {
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const allowed = cfg.allowedHosts || (cfg.mode === 'local' ? ['localhost', '127.0.0.1', '::1'] : null);
    if (allowed && !allowed.includes(host)) throw new HttpError(403, `host "${host}" not allowed`);
  }

  // CSRF guard: browsers must be same-origin to write.
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return;
    let o;
    try { o = new URL(origin); } catch { throw new HttpError(403, 'bad origin'); }
    if (o.host !== req.headers.host) throw new HttpError(403, 'cross-origin request refused');
  }

  // Who is writing: an agent (named by header or by key) or the human.
  function actor(req, auth, t) {
    const name = auth.agent || req.headers['x-recon-agent'];
    if (name || auth.role === 'agent') {
      const agentName = String(name || 'agent').slice(0, 60);
      const transport = ENUMS.transport.includes(req.headers['x-recon-transport']) ? req.headers['x-recon-transport'] : 'api';
      const agent = t.store.touchAgent(agentName, { transport, model: req.headers['x-recon-model'] });
      return agent.id;
    }
    return 'human';
  }

  // ---------- routing ----------

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', ({ auth }) => ({
    ok: true, name: 'recon', version: VERSION, mode: cfg.mode, auth: Boolean(cfg.key || cfg.mode === 'multi'), tenant: auth?.tenant,
  }));

  route('GET', '/api/state', ({ t }) => statePayload(t));
  route('GET', '/api/model', () => describeModel());
  route('GET', '/api/connect', ({ req }) => connectInfo(req));

  route('GET', '/api/items/:kind', ({ t, params, query }) => {
    kindOr404(params.kind);
    const filter = Object.fromEntries([...query.entries()].filter(([k]) => k !== 'token'));
    return t.store.list(params.kind, filter);
  });

  route('GET', '/api/items/:kind/:id', ({ t, params }) => {
    kindOr404(params.kind);
    const item = t.store.get(params.kind, params.id);
    if (!item) throw new HttpError(404, `${params.kind} "${params.id}" not found`);
    const history = t.store.state.activity.filter((a) => a.itemId === item.id).slice(-50);
    const extra = {};
    if (params.kind === 'component') extra.checklist = checklistFor(t.store.get('target', item.targetId), item);
    return { item, history, ...extra };
  });

  route('POST', '/api/items/:kind', ({ t, params, body, who }) => {
    kindOr404(params.kind);
    return t.store.upsert(params.kind, body || {}, who);
  });

  route('PATCH', '/api/items/:kind/:id', ({ t, params, body, who }) => {
    kindOr404(params.kind);
    return t.store.patch(params.kind, params.id, body || {}, who);
  });

  route('DELETE', '/api/items/:kind/:id', ({ t, params, who }) => {
    kindOr404(params.kind);
    return t.store.remove(params.kind, params.id, who);
  });

  route('POST', '/api/items/:kind/:id/evidence', ({ t, params, body, who }) => {
    kindOr404(params.kind);
    return t.store.addEvidence(params.kind, params.id, body?.evidence || body, who);
  });

  route('DELETE', '/api/items/:kind/:id/evidence/:eid', ({ t, params, who }) => {
    kindOr404(params.kind);
    return t.store.removeEvidence(params.kind, params.id, params.eid, who);
  });

  route('POST', '/api/claim', ({ t, body, who }) => {
    if (who === 'human') throw new HttpError(400, 'claim is for agents. humans assign with PATCH agent.assignment or component.owner');
    return t.store.claim(asArray(body?.componentIds || body?.ids), who);
  });

  route('POST', '/api/steers/:id/:verb', ({ t, params, body, who }) => {
    const state = { ack: 'acknowledged', acknowledge: 'acknowledged', address: 'addressed', reopen: 'open' }[params.verb];
    if (!state) throw new HttpError(404, 'use ack, address or reopen');
    const patch = { state };
    if (body?.response) patch.response = String(body.response);
    return t.store.patch('steer', params.id, patch, who);
  });

  route('POST', '/api/proposals/:id/:verb', ({ t, params, body, who }) => {
    const state = { accept: 'accepted', decline: 'declined' }[params.verb];
    if (!state) throw new HttpError(404, 'use accept or decline');
    if (who !== 'human') throw new HttpError(403, 'only a human accepts or declines proposals');
    const cur = t.store.get('proposal', params.id);
    const choice = typeof body?.choice === 'string' ? body.choice.slice(0, 500) : '';
    if (choice && cur?.options?.length && !cur.options.includes(choice)) throw new HttpError(400, `choice must be one of: ${cur.options.join(' | ')}`);
    const p = t.store.patch('proposal', params.id, { state, ...(choice ? { choice } : {}) }, who);
    if (state === 'accepted' && body?.steer !== false) {
      // Accepting a proposal tells the proposer to go ahead, through the same steer channel.
      t.store.create('steer', {
        action: p.steerKind || 'note', itemId: p.itemId || '', itemKind: p.itemKind || '',
        to: [p.createdBy], note: choice ? `Decision: ${choice} (re: ${p.text})` : `Go ahead: ${p.text}`, state: 'acknowledged',
      }, who);
    }
    return p;
  });

  route('GET', '/api/suggestions', ({ t, query }) => suggest(t.store.state, { limit: Number(query.get('limit')) || 12 }));

  route('POST', '/api/suggestions/:id/:verb', ({ t, params, body, who }) => {
    const all = suggest(t.store.state, { limit: 500 });
    const s = all.find((x) => x.id === params.id);
    if (params.verb === 'dismiss') {
      if (t.store.state.project.dismissed.includes(params.id)) return { ok: true, already: true };
      if (!s) throw new HttpError(404, `no current suggestion "${params.id}": the briefing lists the current ones`);
      const reason = String(body?.reason || '').trim().slice(0, 300);
      if (who !== 'human' && !reason) throw new HttpError(400, 'say why it does not apply (reason), so the human can see it');
      t.store.setProject({ dismissed: [...t.store.state.project.dismissed, params.id] }, who);
      t.store.log({ by: who, action: 'note', kind: s.itemKind || 'project', itemId: s.itemId, summary: `dismissed "${s.title}"${reason ? `: ${reason}` : ''}` });
      return { ok: true, dismissed: { id: s.id, title: s.title, reason: reason || undefined } };
    }
    if (params.verb !== 'accept') throw new HttpError(404, 'use accept or dismiss');
    if (!s) throw new HttpError(404, 'that suggestion is no longer current');
    const item = t.store.find(s.itemId);
    const owner = item?.owner || (item?.createdBy && item.createdBy !== 'human' ? item.createdBy : null);
    const to = asArray(body?.to).length ? asArray(body.to) : owner ? [owner] : ['all'];
    return t.store.create('steer', {
      action: s.action, itemId: s.itemId, itemKind: s.itemKind, to,
      note: body?.note || `${s.title}. ${s.why}`,
    }, who);
  });

  route('GET', '/api/playbooks', () => allPlaybooks());
  route('GET', '/api/playbooks/:type', ({ params }) => playbook(params.type));
  route('GET', '/api/glossary', () => ({ glossary: GLOSSARY, classes: CLASSES }));

  route('GET', '/api/briefing', ({ t, who, query }) => {
    const id = who !== 'human' ? who : query.get('agent') ? agentIdFor(query.get('agent')) : null;
    if (!id) throw new HttpError(400, 'send X-Recon-Agent: <name> (or ?agent=<name>) to get a briefing');
    const todo = mustDo(t.store.state, id);
    const b = briefing(t.store.state, id);
    const left = whereWeLeftOff(t.store.state, id);
    return {
      ...b,
      next: todo.length ? `${todo[0].do} (${todo[0].how})` : b.next,
      mustDo: todo.map((x) => ({ kind: x.kind, id: x.id, do: x.do, how: x.how, urgent: x.urgent || undefined })),
      openLeads: left.openLeads.map((l) => l.id),
      skills: t.skills.list().map((s) => s.id),
      report: reportStatus(t),
    };
  });

  // ---------- the report slot ----------

  route('GET', '/api/report', ({ t }) => buildReport(t.store.state));

  route('PATCH', '/api/report', ({ t, body, who }) => {
    const cur = t.store.state.project.report || {};
    const patch = {};
    if (who === 'human') {
      for (const k of ['shape', 'path', 'includeIds', 'skill', 'signOff']) if (body?.[k] !== undefined) patch[k] = body[k];
      if (patch.skill && !t.skills.get(patch.skill)) throw new HttpError(400, `no skill "${patch.skill}"`);
    } else {
      if (['shape', 'includeIds', 'skill', 'signOff'].some((k) => body?.[k] !== undefined)) throw new HttpError(403, 'the report shape, which findings go in, the writing skill and whose name signs it are the human\'s call: ask with recon_propose and options');
      if (body?.path !== undefined && cur.path) throw new HttpError(403, `the report already has a path (${cur.path}); ask the human to change it`);
      if (body?.path !== undefined) patch.path = body.path;
    }
    if (patch.shape !== undefined && !['combined', 'separate', ''].includes(patch.shape)) throw new HttpError(400, 'shape must be combined or separate');
    t.store.setProject({ report: patch }, who);
    t.store.log({ by: who, action: 'updated', kind: 'project', summary: `report set to ${t.store.state.project.report.shape || 'undecided'}${t.store.state.project.report.path ? ` at ${t.store.state.project.report.path}` : ''}` });
    return buildReport(t.store.state);
  });

  const needShape = (t) => {
    if (!(t.store.state.project.report || {}).shape) throw new HttpError(409, 'the human has not chosen the report shape yet. Ask with recon_propose and options ["combined: one document, a section per finding", "separate: one report per finding"], then write.');
  };

  // Everything the writer needs: the report skill as the system prompt, and the facts.
  route('GET', '/api/report/brief', ({ t }) => {
    needShape(t);
    const r = buildReport(t.store.state);
    if (!r.included.length) throw new HttpError(409, `no finding passes every check yet, so there is nothing to report. Left out: ${r.excluded.map((x) => `${x.title} (${x.reasons.join('; ')})`).join(' | ') || 'none'}`);
    return reportBrief(t.store.state, t.skills.reportSkill(t.store.state.project.report?.skill));
  });
  route('POST', '/api/report/write', ({ t }) => {
    needShape(t);
    return reportBrief(t.store.state, t.skills.reportSkill(t.store.state.project.report?.skill));
  });

  route('POST', '/api/report/submit', ({ t, who, body }) => {
    needShape(t);
    const st = t.store.state;
    const { docs, problems } = checkSubmission(st, body?.documents);
    if (problems.length) {
      const err = new HttpError(422, `the report does not follow the writing skill yet (${problems.length} problem${problems.length === 1 ? '' : 's'}); fix and resubmit`);
      err.details = problems;
      throw err;
    }
    const skill = t.skills.reportSkill(st.project.report?.skill);
    const at = Date.now();
    const keep = (st.project.report?.documents || []).filter((d) => !docs.some((n) => n.key === d.key && n.shape === d.shape));
    const stored = docs.map((d) => ({ ...d, at, by: who, skill: skill.id }));
    t.store.setProject({ report: { documents: [...keep, ...stored], last: { at, by: who, shape: docs[0].shape, files: stored.map((d) => d.name), included: stored.flatMap((d) => d.findingIds) } } }, who);
    t.store.log({ by: who, action: 'note', kind: 'project', summary: `wrote ${stored.map((d) => d.name).join(', ')} following "${skill.name}"` });
    const r = buildReport(t.store.state);
    return { ...r, written: stored.map((d) => d.name) };
  });

  // ---------- skills: kept per machine, shared by every hunt ----------

  const skillErr = (fn) => { try { return fn(); } catch (err) { if (err instanceof SkillError) throw new HttpError(err.status, err.message); throw err; } };
  const humanOnly = (who, what) => { if (who !== 'human') throw new HttpError(403, `${what} is the human's call; suggest it with recon_propose`); };
  route('GET', '/api/skills', ({ t }) => ({ skills: t.skills.list(), reportSkill: t.skills.reportSkill(t.store.state.project.report?.skill).id }));
  route('GET', '/api/skills/:id', ({ t, params }) => {
    const s = t.skills.get(decodeURIComponent(params.id));
    if (!s) throw new HttpError(404, `no skill "${params.id}"`);
    return s;
  });
  route('POST', '/api/skills', ({ t, who, body }) => {
    humanOnly(who, 'adding a skill');
    const s = skillErr(() => t.skills.save(typeof body?.text === 'string' && !body.body ? body.text : body || {}));
    t.store.log({ by: who, action: 'created', kind: 'project', summary: `added the skill "${s.name}"` });
    return s;
  });
  route('PUT', '/api/skills/:id', ({ t, who, body, params }) => {
    humanOnly(who, 'editing a skill');
    const cur = t.skills.get(params.id);
    if (!cur) throw new HttpError(404, `no skill "${params.id}"`);
    const s = skillErr(() => t.skills.save({ ...cur, ...body }, { id: cur.id }));
    t.store.log({ by: who, action: 'updated', kind: 'project', summary: `edited the skill "${s.name}"` });
    return s;
  });
  route('DELETE', '/api/skills/:id', ({ t, who, params }) => {
    humanOnly(who, 'removing a skill');
    return skillErr(() => t.skills.remove(params.id));
  });

  route('GET', '/api/targets/:id/playbook', ({ t, params }) => {
    const target = t.store.get('target', params.id);
    if (!target) throw new HttpError(404, `target "${params.id}" not found`);
    return playbookFor(target);
  });

  // An agent with nothing left to do waits here instead of ending its turn. It
  // returns the moment the human writes to it from the board (a steer) or decides
  // one of its proposals, so the human never has to type into the agent's terminal.
  route('GET', '/api/wait', async ({ t, who, query, res }) => {
    if (who === 'human') throw new HttpError(400, 'wait is for agents; send X-Recon-Agent');
    const store = t.store;
    const agent = store.get('agent', who);
    const now = Date.now();
    if (agent.lastWokeAt === undefined) agent.lastWokeAt = now;
    const since = agent.lastWokeAt;
    let events = wakeEvents(store.state, who, since);
    if (!events.length) {
      if (!agent.waitingSince) { agent.waitingSince = now; agent.updatedAt = store.tick(); store.emitChange('upsert', 'agent', agent, null); }
      const ms = Math.min(Math.max(Number(query.get('timeout')) || 25, 1), 55) * 1000;
      events = await new Promise((resolve) => {
        const onChange = () => { const e = wakeEvents(store.state, who, since); if (e.length) done(e); };
        const onClose = () => done([]);
        const timer = setTimeout(() => done([]), ms);
        function done(e) { clearTimeout(timer); store.off('change', onChange); res.off('close', onClose); resolve(e); }
        store.on('change', onChange);
        res.on('close', onClose);
      });
    }
    store.touchAgent(agent.name, {});
    if (!events.length) return { woke: false, waitedSince: agent.waitingSince };
    agent.lastWokeAt = Date.now();
    stopListening(store, who);
    return {
      woke: true,
      events,
      next: events.some((e) => e.type === 'steer')
        ? 'The human wrote to you. Acknowledge each steer now (recon_steer state=acknowledged), do what it asks, report back (recon_steer state=addressed response="..."), then call recon_wait again.'
        : 'The human decided. Act on the choice, tell them what you did with recon_say, then call recon_wait again when you are done.',
    };
  });

  route('GET', '/api/pulse', ({ t, who }) => {
    if (who === 'human') return { pulse: null, mustDo: [] };
    return { pulse: pulse(t.store.state, who), mustDo: mustDo(t.store.state, who) };
  });

  // Re-run every gate against a finding and say what stands between it and a valid report.
  route('GET', '/api/findings/:id/check', ({ t, params }) => {
    const f = t.store.get('finding', params.id);
    if (!f) throw new HttpError(404, `finding "${params.id}" not found`);
    const s = t.store.state;
    const dup = duplicateOf(s, f);
    const prior = reportedMatch(s, f);
    const card = cardGaps(f);
    const evidence = evidenceGaps(f);
    const severity = severityProblem(f);
    const testOk = !['fork', 'unit', 'fuzz'].includes(f.verificationMethod) || f.testResult === 'pass';
    return {
      id: f.id, title: f.title, severity: f.severity,
      ready: !card.length && !evidence.length && !severity && testOk && !dup && !(prior && f.alreadyReported !== 'yes'),
      card, evidence, severity, testPassing: testOk,
      duplicateOf: dup ? { id: dup.id, title: dup.title } : null,
      matchesAlreadyReported: prior,
    };
  });

  route('POST', '/api/heartbeat', ({ t, who, body }) => {
    if (who === 'human') throw new HttpError(400, 'heartbeat is for agents; send X-Recon-Agent');
    const patch = {};
    for (const k of ['focus', 'focusItem', 'status', 'model']) if (body?.[k] !== undefined) patch[k] = body[k];
    if (Object.keys(patch).length) t.store.patch('agent', who, patch, who);
    return t.store.get('agent', who);
  });

  route('GET', '/api/activity', ({ t, query }) => {
    const since = Number(query.get('since')) || 0;
    const limit = Math.min(Number(query.get('limit')) || 200, 1000);
    return t.store.state.activity.filter((a) => a.at > since).slice(-limit);
  });

  route('PATCH', '/api/project', ({ t, body, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human renames the project');
    const p = t.store.setProject(body || {}, who);
    if (typeof body?.demoPaused === 'boolean') { p.demoPaused = body.demoPaused; t.syncDemo(); t.store.emit('project', p); t.store.save(); }
    return p;
  });

  route('POST', '/api/merge', ({ t, body, who }) => t.store.merge(body, who));
  route('GET', '/api/export', ({ t }) => ({ recon: VERSION, exportedAt: Date.now(), ...t.store.state }));

  // Importing adds a new engagement; it never replaces the one you are in.
  route('POST', '/api/import', ({ t, body, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human imports engagements');
    const doc = body?.state || body;
    if (!doc?.items) throw new HttpError(400, 'expected an exported recon project (with "items")');
    t.engagements.create({ doc });
    return { ok: true, project: t.store.state.project };
  });

  // Start (or resume) an engagement by name. Agents may do this. Nothing is ever
  // overwritten: the previous engagement stays saved and listed.
  route('POST', '/api/start', ({ t, body, who }) => {
    const name = String(body?.name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'give the engagement a name');
    const eng = t.engagements;
    const main = eng.store;
    const mainIdle = Date.now() - Math.max(0, ...main.state.activity.slice(-1).map((a) => a.at)) > 30 * 60_000;
    // The board follows the agent only when nothing real is on it (the example, or a long-idle hunt).
    const takeOver = main.state.project.example || mainIdle;
    if (!main.state.project.example && main.state.project.name.toLowerCase() === name.toLowerCase()) return { ok: true, hunt: { id: main.state.project.id, name: main.state.project.name }, project: main.state.project, existing: true };
    const found = eng.findByName(name);
    if (found && !found.example) {
      if (takeOver) eng.open(found.id);
      return { ok: true, hunt: { id: found.id, name: found.name }, project: { id: found.id, name: found.name }, resumed: true, onScreen: takeOver };
    }
    if (takeOver) {
      eng.create({ name, mode: 'empty' });
      main.log({ by: who, action: 'note', kind: 'project', summary: `started the hunt "${name}"` });
      return { ok: true, hunt: { id: main.state.project.id, name }, project: main.state.project, onScreen: true };
    }
    const e = eng.createDetached({ name });
    return { ok: true, hunt: { id: e.id, name: e.name }, project: { id: e.id, name: e.name }, onScreen: false };
  });

  route('GET', '/api/engagements', ({ t }) => t.engagements.list());

  route('POST', '/api/engagements', ({ t, body, who }) => {
    if (who !== 'human') throw new HttpError(403, 'agents start engagements with POST /api/start');
    t.engagements.create({ name: body?.name, mode: body?.mode === 'example' ? 'example' : 'empty' });
    return t.engagements.list();
  });

  route('POST', '/api/engagements/:id/open', ({ t, params }) => {
    t.engagements.open(params.id);
    return t.engagements.list();
  });

  route('PATCH', '/api/engagements/:id', ({ t, params, body, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human renames or archives engagements');
    return t.engagements.update(params.id, body || {});
  });

  route('DELETE', '/api/engagements/:id', ({ t, params, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human removes engagements');
    try { return t.engagements.remove(params.id); } catch (err) { throw new HttpError(err.status || 409, err.message); }
  });

  route('GET', '/api/engagements/:id/snapshots', ({ t, params }) => t.engagements.snapshots(params.id));

  route('POST', '/api/engagements/:id/snapshots', ({ t, params, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human takes manual snapshots');
    if (params.id !== t.store.state.project.id) throw new HttpError(409, 'open the engagement first');
    return { snapshot: t.engagements.snapshot({ force: true }) };
  });

  route('POST', '/api/engagements/:id/restore', ({ t, params, body, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human restores snapshots');
    return t.engagements.restore(params.id, body?.snapshot);
  });

  // Kept for older clients: starts a new engagement (empty or the example). Nothing is deleted.
  route('POST', '/api/reset', ({ t, body, who }) => {
    if (who !== 'human') throw new HttpError(403, 'only a human starts a new engagement this way');
    t.engagements.create({ name: body?.name, mode: body?.mode === 'example' ? 'example' : 'empty' });
    return { ok: true, project: t.store.state.project };
  });

  // ---------- payloads ----------

  function statePayload(t) {
    const s = t.store.state;
    return {
      project: s.project,
      items: s.items,
      activity: s.activity.slice(-300),
      health: healthAll(s),
      suggestions: suggest(s, { limit: 12 }),
      demo: { running: t.demo.running },
      engagements: t.engagements.list(),
      server: { version: VERSION, mode: cfg.mode, now: Date.now() },
    };
  }

  function connectInfo(req) {
    const base = `http://${req.headers.host || `${cfg.host}:${cfg.port}`}`;
    const bin = path.join(ROOT, 'bin', 'recon.js');
    return {
      base, mode: cfg.mode, bin, needsKey: Boolean(cfg.key || cfg.mode === 'multi'),
      watching: [...tenants.values()].flatMap((t) => t.watchers.map((w) => w.source)),
      dropinExample: path.join(cfg.dataDir, 'inbox.json'),
    };
  }

  // ---------- http plumbing ----------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      const internal = internalToken && req.headers['x-recon-internal'] === internalToken;
      if (!internal) checkHost(req);
      if (url.pathname === '/mcp') return await handleMcp(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, internal);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return serveStatic(req, res, url);
    } catch (err) {
      sendError(res, err);
    }
  }

  async function handleApi(req, res, url, internal = false) {
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    if (isWrite && !internal) checkOrigin(req);
    let auth = null;
    if (internal) {
      auth = { tenant: String(req.headers['x-recon-tenant'] || 'default'), role: 'any', agent: null };
    } else if (url.pathname === '/api/health') {
      try { auth = authenticate(req, url); } catch { auth = null; }
    } else {
      auth = authenticate(req, url);
    }
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    const m = url.pathname.match(match.re);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let body = null;
    if (isWrite) {
      const ct = req.headers['content-type'] || '';
      const raw = await readBody(req);
      if (raw.length) {
        if (!ct.includes('application/json')) throw new HttpError(415, 'send json with content-type: application/json');
        try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid json body'); }
      }
    }
    const base = auth ? tenant(auth.tenant) : null;
    const huntRef = req.headers['x-recon-hunt'] ? decodeURIComponent(String(req.headers['x-recon-hunt'])) : url.searchParams.get('hunt');
    let t = base;
    if (base && huntRef) {
      try { t = Object.assign(Object.create(base), { store: base.engagements.storeFor(huntRef) }); } catch (err) {
        if (!url.pathname.startsWith('/api/start') && !url.pathname.startsWith('/api/engagements') && url.pathname !== '/api/health') throw new HttpError(err.status || 404, err.message);
      }
    }
    const who = t ? actor(req, auth, t) : 'human';
    if (t && who !== 'human' && url.pathname !== '/api/wait') stopListening(t.store, who);
    const result = await match.handler({ req, res, url, params, query: url.searchParams, body, auth, t, who });
    const extra = {};
    if (t && who !== 'human') {
      const todo = mustDo(t.store.state, who).filter((x) => x.urgent);
      if (todo.length) extra['x-recon-pulse'] = `${todo.length} urgent: ${todo[0].do}`.replace(/[^\x20-\x7e]/g, '').slice(0, 300);
    }
    sendJson(res, 200, result, extra);
  }

  // MCP over HTTP (streamable http, json responses). Lets a remote agent use a hosted
  // hub with nothing installed: claude mcp add --transport http recon https://host/mcp
  async function handleMcp(req, res, url) {
    checkOrigin(req);
    const auth = authenticate(req, url);
    if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }
    if (req.method === 'DELETE') { mcpSessions.delete(req.headers['mcp-session-id']); res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') throw new HttpError(405, 'use POST');
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { throw new HttpError(400, 'invalid json-rpc body'); }
    const { dispatch } = await import('./mcp.js');
    const t = tenant(auth.tenant);
    let sid = req.headers['mcp-session-id'];
    let session = sid ? mcpSessions.get(sid) : null;
    const messages = Array.isArray(body) ? body : [body];
    const init = messages.find((m) => m?.method === 'initialize');
    const named = auth.agent || req.headers['x-recon-agent'] || url.searchParams.get('agent');
    const huntAsked = req.headers['x-recon-hunt'] ? decodeURIComponent(String(req.headers['x-recon-hunt'])) : url.searchParams.get('hunt');
    if (init || !session) {
      sid = crypto.randomUUID();
      session = { tenant: auth.tenant, agent: String(named || init?.params?.clientInfo?.name || 'agent').slice(0, 60), at: Date.now() };
      mcpSessions.set(sid, session);
    }
    if (named) session.agent = String(named).slice(0, 60);
    if (huntAsked) session.hunt = huntAsked;
    session.at = Date.now();
    const host = ['0.0.0.0', '::'].includes(cfg.host) ? '127.0.0.1' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
    const mk = () => createClient({
      url: `http://${host}:${server.address().port}`, agent: session.agent, transport: 'mcp', hunt: session.hunt || null,
      headers: { 'x-recon-internal': internalToken, 'x-recon-tenant': session.tenant },
    });
    let client = mk();
    const out = [];
    for (const m of messages) {
      const r = await dispatch(m, {
        getClient: async () => client,
        onInitialize: () => t.store.touchAgent(session.agent, { transport: 'mcp' }),
        ctx: { setHunt: (h) => { session.hunt = h; client = mk(); } },
      });
      if (r) out.push(r);
    }
    if (!out.length) { res.writeHead(202, { 'mcp-session-id': sid }); res.end(); return; }
    const payload = JSON.stringify(Array.isArray(body) ? out : out[0]);
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid, 'cache-control': 'no-store' });
    res.end(payload);
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(cfg.webDir, rel));
    if (!file.startsWith(cfg.webDir + path.sep)) throw new HttpError(403, 'forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendError(res, new HttpError(404, 'not found'));
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': rel.startsWith('/fonts/') ? 'public, max-age=604800' : 'no-cache',
        ...securityHeaders(),
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(handle);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname !== '/ws') throw new HttpError(404, 'not found');
      checkHost(req);
      checkOrigin(req);
      const auth = authenticate(req, url);
      const t = tenant(auth.tenant);
      const name = url.searchParams.get('agent');
      const client = ws.handleUpgrade(req, socket, head, { tenant: t.id, agent: name || null });
      if (!client) return;
      if (name) t.store.touchAgent(name, { transport: 'api' });
      client.send({ t: 'hello', state: statePayload(t) });
      client.on('message', (msg) => {
        if (msg?.t === 'ping') client.send({ t: 'pong', now: Date.now() });
        if (msg?.t === 'presence' && name) t.store.touchAgent(name, {});
      });
    } catch (err) {
      const status = err.status || 400;
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n\r\n`);
    }
  });

  // Periodic health: idle/stuck/offline are time-based, so recompute and push.
  const healthTimer = setInterval(() => {
    for (const t of tenants.values()) {
      const h = healthAll(t.store.state);
      const sig = JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, [v.status, v.flags]])));
      if (sig !== t.lastHealth) {
        t.lastHealth = sig;
        ws.broadcast({ t: 'health', health: h }, (c) => c.meta.tenant === t.id);
      }
    }
    for (const c of ws.clients) { if (!c.alive) c.terminate(); else c.ping(); }
    for (const [id, sess] of mcpSessions) if (Date.now() - sess.at > 24 * 3600_000) mcpSessions.delete(id);
    for (const t of tenants.values()) { try { t.engagements.maybeSnapshot(); } catch (err) { log(`recon: snapshot failed: ${err.message}`); } }
  }, 5000);
  healthTimer.unref();

  return {
    cfg,
    server,
    ws,
    tenant,
    tenants,
    async listen() {
      if (cfg.mode !== 'multi') {
        const t = tenant('default');
        for (const src of cfg.watch) t.watchers.push(watchSource(t.store, src, { log }));
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, resolve);
      });
      const addr = server.address();
      this.port = addr.port;
      this.url = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${addr.port}`;
      return this;
    },
    async close() {
      clearInterval(healthTimer);
      ws.closeAll();
      for (const t of tenants.values()) t.close();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

// ---------- helpers ----------

function kindOr404(kind) {
  if (!isKind(kind)) throw new HttpError(404, `unknown kind "${kind}". kinds: ${KINDS.join(', ')}`);
}

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function readBody(req, limit = 4 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
  };
}

function sendJson(res, status, data, extra = {}) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders(), ...extra });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  if (res.headersSent) { res.end(); return; }
  sendJson(res, status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export { label, VERSION };
