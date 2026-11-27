#!/usr/bin/env node
// recon: the hub, the mcp server, and a cli for humans, scripts and agents.

import fs from 'node:fs';
import path from 'node:path';
import { createClient, defaultUrl, ReconError } from '../src/client.js';

const HELP = `recon - a shared cockpit where you and your agents hunt vulnerabilities together

one-line setup
  recon setup                           add recon's tools to every agent cli found (claude code, codex,
                                        gemini, opencode, cursor, windsurf, claude desktop), open the board.
                                        --here also adds it to project-scoped clients (grok) in this folder
  recon agent [--as NAME]               for agents: start the board if needed and print how to use it

run the hub
  recon serve [--port 4317] [--data ./.recon] [--watch file.json|url]... [--empty] [--no-demo]
              [--mode local|server|multi] [--host 127.0.0.1] [--key KEY] [--open]
  recon mcp [--name my-agent]           mcp server over stdio (starts a local hub if none is running)

read
  recon status                          hub, agents, coverage at a glance
  recon briefing                        what to do next (as an agent: --as NAME)
  recon list <kind> [--field value]     kinds: target component assumption hypothesis finding steer proposal agent
  recon get <id|name>                   one item with evidence and history
  recon steers [--mine] [--all]         open steers (--mine: addressed to you)
  recon suggestions                     where recon suggests looking next
  recon playbook [type]                 exploit classes for a protocol type
  recon watch                           stream activity live
  recon model                           every field and enum

write (as the human, or as an agent with --as NAME)
  recon add target <name> [--type lending] [--chain mainnet] [--components "A(),B()"]
  recon add component <name> --target <target> [--type function] [--summary ...] [--location path:line]
  recon add actor|external <name> [--summary ...]          people/roles, and dependencies like tokens and oracles
  recon relate <from> <to> <calls|reads|writes|transfers|mints|owns|configures|trusts|delegates|inherits> [label]
  recon phase <target> <mapping|assumptions|hunting|reporting>
  recon add assumption <text> [--origin developer|agent] [--category trust|invariant|input|external|economic]
                              [--target T] [--component C] [--rationale ...]
  recon add hypothesis <text> [--component C] [--confidence low|med|high] [--class reentrancy]
  recon add finding <title> [--severity high] [--component C] [--stage testing] [--hypothesis H]
      any add takes --evidence "ref" or --evidence "ref|what it shows" (repeatable)
  recon coverage <component> <untouched|scanning|reviewed|flagged> [--reasoning ...] [--evidence ...]
  recon set <id|name> field=value [field=value...]
  recon evidence <id|name> <ref> [note]
  recon check <component> <checkId> [checked|na|unchecked]
  recon focus <text> [--item <id|name>]
  recon claim <component>...
  recon propose <text> [--rationale ...] [--item <id|name>]
  recon ack <steerId> [response]        acknowledge a steer
  recon address <steerId> <response>    report back on a steer
  recon steer <id|name|agent> <recheck|challenge|cover|verify|note> [note] [--to agent]   (human)
  recon verify|dispute|unverify <id|name>                                                   (human)
  recon accept|decline <proposalId>                                                         (human)

move data
  recon push <file.json>                merge a json document into the board
  recon export [file.json]              the whole project (stdout if no file)
  recon import <file.json>              replace the project with an export
  recon start <name>                    replace the example with a real engagement (agents may do this)
  recon reset [--example] [--name N]    start over (empty, or the example)

global
  --url URL     hub url (env RECON_URL, default ${defaultUrl()})
  --key KEY     hub key (env RECON_KEY), for server mode
  --as NAME     act as an agent (env RECON_AGENT). without it you act as the human
  --json        raw json output
`;

// ---------- args ----------

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let v = eq > 0 ? a.slice(eq + 1) : null;
      if (k.startsWith('no-')) { k = k.slice(3); v = false; }
      else if (v === null) v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (flags[k] !== undefined && v !== true && v !== false) flags[k] = [].concat(flags[k], v);
      else flags[k] = v;
    } else if (a.startsWith('-') && a.length === 2) {
      const map = { h: 'help', j: 'json', p: 'port' };
      const k = map[a[1]] || a[1];
      flags[k] = k === 'port' ? argv[++i] : true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const { pos, flags } = parse(process.argv.slice(2));
const cmd = pos.shift();
const agentName = flags.as || process.env.RECON_AGENT || null;
const asJson = Boolean(flags.json);
const many = (v) => (v === undefined || v === true ? [] : [].concat(v));

// ---------- output ----------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2);
const bold = c(1);
const COLORS = {
  untouched: c(90), scanning: c(36), reviewed: c(32), flagged: c(33),
  critical: c(31), high: c(33), medium: c(93), low: c(36), info: c(90),
  open: c(33), acknowledged: c(93), addressed: c(32), pending: c(35), accepted: c(32), declined: c(90),
  testing: c(35), confirmed: c(31), dropped: c(90), assumed: c(93), verified: c(32), invalidated: c(31), disputed: c(31),
};
const tint = (v) => (COLORS[v] ? COLORS[v](v) : v);

function out(data, human) {
  if (asJson || !human) { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); return; }
  const text = human(data);
  if (text !== undefined) process.stdout.write(`${text}\n`);
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function line(it) {
  const title = it.name || it.title || it.text || it.note || '';
  const state = it.reviewState || it.status || it.stage || it.state || '';
  const extra = [it.severity && tint(it.severity), it.confidence && `conf ${it.confidence}`, it.verification && it.verification !== 'unverified' && tint(it.verification)].filter(Boolean).join(' ');
  return `${dim(it.id.padEnd(22))} ${state ? `${tint(state).padEnd(tty ? 21 : 12)} ` : ''}${title}${extra ? `  ${extra}` : ''}`;
}

function evidenceArgs(v) {
  return many(v).map((e) => {
    const [ref, ...note] = String(e).split('|');
    return { ref: ref.trim(), note: note.join('|').trim() };
  });
}

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[[{]/.test(v)) { try { return JSON.parse(v); } catch { /* keep string */ } }
  return v;
}

function need(v, what) {
  if (v === undefined || v === null || v === true || v === '') throw new ReconError(2, `missing ${what}. see: recon help`);
  return v;
}

// ---------- commands ----------

const client = () => createClient({ url: flags.url, key: flags.key ?? process.env.RECON_KEY, agent: agentName, transport: 'cli' });

async function serve() {
  const { createHub } = await import('../src/hub.js');
  const hub = createHub({
    mode: flags.mode, host: flags.host, port: flags.port !== undefined ? Number(flags.port) : undefined,
    dataDir: flags.data, key: typeof flags.key === 'string' ? flags.key : undefined, keysFile: flags.keys,
    watch: many(flags.watch), seed: flags.empty ? 'empty' : undefined, demo: flags.demo === false ? false : undefined,
    insecure: flags.insecure === true ? true : undefined,
  });
  await hub.listen();
  const t = hub.cfg.mode === 'multi' ? null : hub.tenant('default');
  const bin = path.resolve(process.argv[1]);
  process.stderr.write([
    '',
    `  ${bold('recon')} is running  ${dim(`(${hub.cfg.mode} mode)`)}`,
    '',
    `  board      ${bold(hub.url)}`,
    `  data       ${dim(hub.cfg.dataDir)}${hub.cfg.encryptionKey ? dim(' (encrypted)') : ''}`,
    ...(hub.cfg.watch.length ? [`  watching   ${hub.cfg.watch.join(', ')}`] : []),
    t?.store.state.project.example ? `  example    ${dim('an example project with a simulated agent is loaded. start your own from the board.')}` : '',
    '',
    `  connect an agent`,
    `    mcp      ${dim(`claude mcp add recon -- node ${bin} mcp --name my-agent`)}`,
    `    cli      ${dim(`RECON_AGENT=my-agent node ${bin} briefing`)}`,
    `    http     ${dim(`curl ${hub.url}/api/briefing -H 'X-Recon-Agent: my-agent'`)}`,
    '',
  ].join('\n'));
  if (flags.open) (await import('../src/launch.js')).openBrowser(hub.url);
  const stop = async () => { process.stderr.write('\n  saving and shutting down…\n'); await hub.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function mcp() {
  const { runMcp } = await import('../src/mcp.js');
  await runMcp({ name: flags.name || agentName || 'agent', url: flags.url, key: flags.key ?? process.env.RECON_KEY, model: flags.model });
}

async function status() {
  const api = client();
  const s = await api.state();
  out(s, () => {
    const comps = Object.values(s.items.component);
    const counts = { untouched: 0, scanning: 0, reviewed: 0, flagged: 0 };
    for (const x of comps) counts[x.reviewState]++;
    const pct = comps.length ? Math.round(((counts.reviewed + counts.flagged) / comps.length) * 100) : 0;
    const findings = Object.values(s.items.finding);
    const lines = [
      `${bold(s.project.name)} ${dim(`· ${api.url} · ${s.server.mode} mode${s.project.example ? ' · example' : ''}`)}`,
      '',
      `coverage    ${bold(`${pct}%`)} of ${comps.length} parts  ${Object.entries(counts).map(([k, v]) => `${tint(k)} ${v}`).join('  ')}`,
      `hypotheses  ${Object.values(s.items.hypothesis).filter((h) => h.status === 'testing').length} testing, ${Object.values(s.items.hypothesis).filter((h) => h.status === 'confirmed').length} confirmed`,
      `findings    ${findings.length} ${findings.length ? `(${['critical', 'high', 'medium', 'low', 'info'].map((k) => [k, findings.filter((f) => f.severity === k).length]).filter(([, n]) => n).map(([k, n]) => `${n} ${tint(k)}`).join(', ')})` : ''}`,
      `steers      ${Object.values(s.items.steer).filter((x) => x.state === 'open').length} open, ${Object.values(s.items.steer).filter((x) => x.state === 'acknowledged').length} seen`,
      '',
      bold('agents'),
      ...(Object.values(s.items.agent).map((a) => {
        const h = s.health[a.id] || {};
        return `  ${a.name.padEnd(16)} ${tint(h.status || a.status).padEnd(tty ? 17 : 8)} ${dim(a.transport.padEnd(5))} ${a.focus || ''}${h.flags?.length ? `  ${COLORS.flagged(h.flags.join(','))}` : ''}`;
      })),
      ...(Object.keys(s.items.agent).length ? [] : [dim('  none connected. try: recon mcp --name my-agent')]),
    ];
    return lines.join('\n');
  });
}

async function briefing() {
  const api = client();
  const b = await api.briefing(flags.agent);
  out(b, () => [
    `${bold('next:')} ${b.next}`,
    '',
    bold(`steers for you (${b.steers.length})`),
    ...b.steers.map((s) => `  ${dim(s.id)} ${tint(s.state)} ${s.action}${s.item ? ` → ${s.item.label}` : ''}${s.note ? `\n      ${s.note}` : ''}`),
    ...(b.disputed.length ? ['', bold('disputed by the human'), ...b.disputed.map((d) => `  ${dim(d.id)} ${d.kind}: ${d.label}`)] : []),
    '',
    bold(`untouched (${b.untouched.length})`),
    ...b.untouched.slice(0, 10).map((u) => `  ${dim(u.id)} ${u.name}`),
    '',
    bold('suggested'),
    ...b.suggestions.map((s) => `  ${s.action.padEnd(9)} ${s.title}`),
  ].join('\n'));
}

async function list() {
  const kind = need(pos[0], 'kind');
  const filter = {};
  for (const [k, v] of Object.entries(flags)) if (!['json', 'as', 'url', 'key'].includes(k) && typeof v === 'string') filter[k] = v;
  const items = await client().list(kind, filter);
  out(items, (xs) => (xs.length ? xs.map(line).join('\n') : dim(`no ${kind}s`)));
}

async function get() {
  const api = client();
  const { kind, item } = await api.resolve(need(pos[0], 'id or name'));
  const r = await api.get(kind, item.id);
  out(r, () => {
    const it = r.item;
    const skip = new Set(['id', 'kind', '_f', 'evidence', 'createdAt', 'updatedAt', 'createdBy', 'lastTouchedBy', 'meta', 'checklist']);
    return [
      `${bold(it.name || it.title || it.text || it.note)} ${dim(`${kind} ${it.id}`)}`,
      dim(`by ${it.createdBy}, last touched by ${it.lastTouchedBy} ${ago(it.updatedAt)}`),
      '',
      ...Object.entries(it).filter(([k, v]) => !skip.has(k) && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k.padEnd(14)} ${typeof v === 'object' ? JSON.stringify(v) : tint(String(v))}`),
      ...(it.evidence?.length ? ['', bold('evidence'), ...it.evidence.map((e) => `  ${e.ref}${e.note ? dim(` — ${e.note}`) : ''} ${dim(`(${e.by})`)}`)] : []),
      ...(r.checklist ? ['', bold('checklist'), ...r.checklist.flatMap((g) => [`  ${g.name}`, ...g.items.map((i) => `    ${i.state === 'checked' ? COLORS.reviewed('✓') : i.state === 'na' ? dim('–') : dim('○')} ${dim(i.id.padEnd(24))} ${i.text}`)])] : []),
      ...(r.history?.length ? ['', bold('history'), ...r.history.slice(-8).map((a) => `  ${dim(ago(a.at).padEnd(9))} ${a.by}: ${a.summary}`)] : []),
    ].join('\n');
  });
}

async function add() {
  const api = client();
  const kind = need(pos[0], 'kind');
  const text = pos.slice(1).join(' ');
  const ev = evidenceArgs(flags.evidence);
  const ref = async (v, k) => (v && v !== true ? (await api.resolve(v, k)).item.id : undefined);
  const base = { ...(ev.length ? { evidence: ev } : {}), ...(flags.reasoning ? { reasoning: flags.reasoning } : {}) };
  let fields;
  switch (kind) {
    case 'target': {
      fields = { name: need(text, 'name'), protocolType: flags.type || 'other', chain: flags.chain, description: flags.description, scope: flags.scope };
      const t = await api.create('target', clean(fields));
      const comps = many(flags.components).flatMap((s) => String(s).split(/[,;\n](?![^(]*\))/)).map((s) => s.trim()).filter(Boolean);
      for (const name of comps) await api.create('component', { targetId: t.id, name, type: /\(.*\)/.test(name) ? 'function' : 'contract' });
      out(t, () => `added target ${bold(t.name)} ${dim(t.id)}${comps.length ? ` with ${comps.length} components` : ''}`);
      return;
    }
    case 'component':
    case 'actor':
    case 'external': {
      const type = kind === 'component' ? flags.type : kind;
      const it = await api.create('component', clean({
        ...base, name: need(text, 'name'), targetId: need(await ref(flags.target, 'target') || await onlyTarget(api), '--target'),
        type, summary: flags.summary, location: flags.location, ...(kind !== 'component' ? { reviewState: 'reviewed' } : {}),
      }));
      out(it, () => `added ${type || 'component'} ${dim(it.id)}`);
      return;
    }
    case 'assumption':
      fields = {
        text: need(text, 'text'), targetId: await ref(flags.target, 'target') || await onlyTarget(api), componentId: await ref(flags.component, 'component'),
        scope: flags.scope, rationale: flags.rationale, origin: flags.origin, category: flags.category,
      };
      break;
    case 'hypothesis':
      fields = { text: need(text, 'text'), targetId: await ref(flags.target, 'target'), componentId: await ref(flags.component, 'component'), bugClass: flags.class, confidence: flags.confidence };
      break;
    case 'finding':
      fields = {
        title: need(text, 'title'), targetId: await ref(flags.target, 'target'), componentId: await ref(flags.component, 'component'),
        hypothesisId: await ref(flags.hypothesis, 'hypothesis'), severity: flags.severity, stage: flags.stage, bugClass: flags.class,
        bounty: flags.bounty !== undefined ? Number(flags.bounty) : undefined, notes: flags.notes, repro: flags.repro,
      };
      break;
    default:
      throw new ReconError(2, `cannot add "${kind}". add target, component, assumption, hypothesis or finding`);
  }
  if (fields.componentId && !fields.targetId && kind !== 'component') fields.targetId = (await api.resolve(fields.componentId, 'component')).item.targetId;
  const it = await api.create(kind, clean({ ...base, ...fields }));
  out(it, () => `added ${kind} ${dim(it.id)}`);
}

// With a single target on the board, --target can be left out.
async function onlyTarget(api) {
  const ts = await api.list('target');
  return ts.length === 1 ? ts[0].id : undefined;
}

async function relate() {
  const api = client();
  const from = (await api.resolve(need(pos[0], 'from component'), 'component')).item;
  const to = (await api.resolve(need(pos[1], 'to component'), 'component')).item;
  const r = await api.create('relation', clean({ targetId: from.targetId, from: from.id, to: to.id, type: flags.type || pos[2], label: flags.label || pos.slice(3).join(' ') }));
  out(r, () => `mapped ${from.name} ${r.type} ${to.name}`);
}

async function phase() {
  const api = client();
  const t = (await api.resolve(need(pos[0], 'target'), 'target')).item;
  const r = await api.update('target', t.id, { phase: need(pos[1], 'phase (mapping|assumptions|hunting|reporting)') });
  out(r, () => `${r.name} → ${r.phase}`);
}

async function coverage() {
  const api = client();
  const { item } = await api.resolve(need(pos[0], 'component'), 'component');
  const fields = clean({ reviewState: pos[1], reasoning: flags.reasoning });
  const ev = evidenceArgs(flags.evidence);
  if (ev.length) fields.evidence = ev;
  const it = await api.update('component', item.id, fields);
  if (pos[1] === 'scanning' && agentName) await api.heartbeat({ focus: `Reviewing ${item.name}`, focusItem: item.id }).catch(() => {});
  out(it, () => `${it.name} → ${tint(it.reviewState)}`);
}

async function set() {
  const api = client();
  const { kind, item } = await api.resolve(need(pos[0], 'id or name'));
  const fields = {};
  for (const kv of pos.slice(1)) {
    const i = kv.indexOf('=');
    if (i < 1) throw new ReconError(2, `expected field=value, got "${kv}"`);
    fields[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
  }
  const it = await api.update(kind, item.id, fields);
  out(it, () => `updated ${kind} ${dim(it.id)}: ${Object.keys(fields).join(', ')}`);
}

async function evidence() {
  const api = client();
  const { kind, item } = await api.resolve(need(pos[0], 'id or name'));
  const it = await api.evidence(kind, item.id, { ref: need(pos[1], 'reference'), note: pos.slice(2).join(' ') });
  out(it, () => `attached evidence to ${dim(it.id)} (${it.evidence.length} total)`);
}

async function check() {
  const api = client();
  const { item } = await api.resolve(need(pos[0], 'component'), 'component');
  const it = await api.update('component', item.id, { checklist: { [need(pos[1], 'check id')]: pos[2] || 'checked' } });
  out(it, () => `${it.name}: ${pos[1]} → ${pos[2] || 'checked'}`);
}

async function focus() {
  const api = client();
  if (!agentName) throw new ReconError(2, 'focus is for agents: pass --as NAME or set RECON_AGENT');
  const fields = { focus: need(pos.join(' '), 'text') };
  if (flags.item) fields.focusItem = (await api.resolve(flags.item)).item.id;
  out(await api.heartbeat(fields), (a) => `${a.name}: ${a.focus}`);
}

async function claim() {
  const api = client();
  const ids = [];
  for (const r of pos) ids.push((await api.resolve(r, 'component')).item.id);
  out(await api.claim(ids), (r) => `claimed ${r.claimed.length}${r.refused.length ? `, refused ${r.refused.map((x) => `${x.id} (${x.reason})`).join(', ')}` : ''}`);
}

async function propose() {
  const api = client();
  const fields = { text: need(pos.join(' '), 'text'), rationale: flags.rationale, steerKind: flags.kind };
  if (flags.item) { const r = await api.resolve(flags.item); fields.itemId = r.item.id; fields.itemKind = r.kind; }
  const p = await api.create('proposal', clean(fields));
  out(p, () => `proposed ${dim(p.id)}. the human will say yes or no; check \`recon briefing\`.`);
}

async function steers() {
  const api = client();
  const all = await api.list('steer');
  const me = agentName ? `ag_${agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : null;
  const xs = all.filter((s) => (flags.all ? true : s.state !== 'addressed') && (!flags.mine || !me || s.to.includes('all') || s.to.includes(me)));
  out(xs, () => (xs.length ? xs.map((s) => `${dim(s.id)} ${tint(s.state).padEnd(tty ? 21 : 12)} ${s.action.padEnd(9)} → ${s.to.join(',')}${s.note ? `\n${' '.repeat(23)}${s.note}` : ''}${s.response ? `\n${' '.repeat(23)}${dim(`↳ ${s.response}`)}` : ''}`).join('\n') : dim('no open steers')));
}

async function steerVerb(verb) {
  const api = client();
  const id = need(pos[0], 'steer id');
  const response = pos.slice(1).join(' ');
  if (verb === 'address' && !response) throw new ReconError(2, 'say what you did: recon address <steerId> "what you found"');
  const s = await api.steer(id, verb, response || undefined);
  out(s, () => `steer ${dim(s.id)} → ${tint(s.state)}`);
}

async function steer() {
  const api = client();
  const target = need(pos[0], 'item, name or agent');
  const action = pos[1] || 'note';
  const note = pos.slice(2).join(' ');
  const r = await api.resolve(target);
  const to = many(flags.to).length ? await Promise.all(many(flags.to).map(async (t) => (t === 'all' ? 'all' : (await api.resolve(t, 'agent')).item.id))) : r.kind === 'agent' ? [r.item.id] : [r.item.owner || (r.item.createdBy?.startsWith('ag_') ? r.item.createdBy : 'all')];
  const s = await api.create('steer', clean({ action, itemId: r.kind === 'agent' ? '' : r.item.id, itemKind: r.kind === 'agent' ? '' : r.kind, to, note }));
  out(s, () => `steer ${dim(s.id)} sent to ${to.join(', ')}`);
}

async function verdict(v) {
  const api = client();
  const { kind, item } = await api.resolve(need(pos[0], 'id or name'));
  const it = await api.update(kind, item.id, { verification: v });
  out(it, () => `${kind} ${dim(it.id)} → ${tint(v)}`);
}

async function decide(verb) {
  const api = client();
  const p = await api.proposal(need(pos[0], 'proposal id'), verb);
  out(p, () => `proposal ${dim(p.id)} → ${tint(p.state)}`);
}

async function suggestions() {
  const xs = await client().suggestions();
  out(xs, () => xs.map((s) => `${dim(s.id)} ${s.action.padEnd(9)} ${s.title}\n${' '.repeat(24)}${dim(s.why)}`).join('\n'));
}

async function playbook() {
  const api = client();
  if (!pos[0]) {
    out(await api.playbooks(), (xs) => xs.map((p) => `${bold(p.type.padEnd(12))} ${p.summary}`).join('\n'));
    return;
  }
  const pb = await api.playbook(pos[0]);
  out(pb, () => [
    `${bold(pb.name)}  ${dim(pb.type)}`, pb.summary, '', `${bold('start here:')} ${pb.startHere}`, '',
    ...pb.classes.flatMap((cls) => [bold(cls.name), `  ${cls.plain}`, ...cls.checks.map((ch) => `    ${dim(ch.id.padEnd(26))} ${ch.text}`), '']),
  ].join('\n'));
}

async function watch() {
  const api = client();
  const url = `${api.url.replace(/^http/, 'ws')}/ws${flags.key || process.env.RECON_KEY ? `?token=${encodeURIComponent(flags.key || process.env.RECON_KEY)}` : ''}`;
  const ws = new WebSocket(url);
  ws.onopen = () => process.stderr.write(dim(`watching ${api.url} (ctrl+c to stop)\n`));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') { for (const a of m.state.activity.slice(-10)) print(a); return; }
    if (m.t === 'change' && m.activity) print(m.activity);
  };
  ws.onclose = () => { process.stderr.write('disconnected\n'); process.exit(1); };
  const print = (a) => {
    if (asJson) { process.stdout.write(`${JSON.stringify(a)}\n`); return; }
    const t = new Date(a.at).toLocaleTimeString();
    process.stdout.write(`${dim(t)} ${bold(a.by)} ${tint(a.action)} ${a.summary}\n`);
  };
  await new Promise(() => {});
}

async function push() {
  const file = need(pos[0], 'file');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await client().merge(doc);
  out(r, () => `merged ${file}: ${r.created} created, ${r.updated} updated${r.errors.length ? `\n${COLORS.flagged(r.errors.join('\n'))}` : ''}`);
}

async function exportCmd() {
  const doc = await client().exportProject();
  if (pos[0]) { fs.writeFileSync(pos[0], JSON.stringify(doc, null, 2), { mode: 0o600 }); process.stderr.write(`exported to ${pos[0]}\n`); }
  else process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

async function importCmd() {
  const doc = JSON.parse(fs.readFileSync(need(pos[0], 'file'), 'utf8'));
  await client().importProject(doc);
  process.stderr.write('imported\n');
}

async function reset() {
  await client().reset(flags.example ? 'example' : 'empty', typeof flags.name === 'string' ? flags.name : undefined);
  process.stderr.write(flags.example ? 'loaded the example project\n' : 'started a new, empty engagement\n');
}

async function setup() {
  const { runSetup } = await import('../src/setup.js');
  const only = flags.only ? String(flags.only).split(',') : null;
  await runSetup({ url: flags.url, key: flags.key ?? process.env.RECON_KEY, open: flags.open !== false, only, here: Boolean(flags.here) });
}

async function agentCmd() {
  const { runAgent } = await import('../src/setup.js');
  await runAgent({ name: agentName, url: flags.url, key: flags.key ?? process.env.RECON_KEY });
}

async function start() {
  const r = await client().start(need(pos.join(' '), 'engagement name'));
  out(r, () => (r.existing ? `already working on "${r.project.name}"` : `started "${r.project.name}". add the target next: recon add target "<name>" --type <protocol type>`));
}

async function model() {
  out(await client().model(), (m) => Object.entries(m.kinds).map(([k, fields]) => `${bold(k)}\n${Object.entries(fields).map(([f, s]) => `  ${f.padEnd(14)} ${s.type}${s.enum ? ` ${dim(s.enum.join(' | '))}` : ''}${s.required ? ' required' : ''}${s.owner === 'human-only' ? ` ${COLORS.flagged('human only')}` : ''}`).join('\n')}`).join('\n\n'));
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== true));
}

const COMMANDS = {
  serve, mcp, status, briefing, list, ls: list, get, show: get, add, coverage, set, evidence, check, focus, claim, propose,
  steers, ack: () => steerVerb('ack'), address: () => steerVerb('address'), steer,
  verify: () => verdict('verified'), dispute: () => verdict('disputed'), unverify: () => verdict('unverified'),
  accept: () => decide('accept'), decline: () => decide('decline'),
  setup, agent: agentCmd, start, relate, phase, suggestions, playbook, watch, push, export: exportCmd, pull: exportCmd, import: importCmd, reset, model,
};

async function main() {
  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(HELP); return; }
  if (cmd === 'version' || flags.version) { process.stdout.write('recon 0.1.0\n'); return; }
  const fn = COMMANDS[cmd];
  if (!fn) { process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
  await fn();
}

main().catch((err) => {
  const details = [].concat(err.details || []).filter((d) => d !== err.message);
  process.stderr.write(`recon: ${err.message}${details.length ? `\n  ${details.join('\n  ')}` : ''}\n`);
  process.exit(err.status === 2 ? 2 : 1);
});
