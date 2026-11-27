// The system map: one full page for how a target fits together. Who uses it on
// the left, the code in the middle, what it depends on on the right, and every
// connection as a colored arrow. Click a part and everything unrelated fades, so
// you can read what it calls and what reaches it at a glance.

import { h, icon, setChildren, toast, hash, truncate } from './ui.js';
import { list, byId, get, write } from './state.js';
import { RELATION, COMPONENT_TYPE, REVIEW } from './labels.js';
import { arrow, rect, svgEl } from './sketch.js';
import { openSteerComposer } from './steer.js';
import { bus } from './bus.js';
import { layout, phaseStepper, addRelation, sidePanel, NODE } from './architecture.js';
import { storyFor } from './story.js';

const MIN_Z = 0.2;
const MAX_Z = 2.2;
const LABELS_WHEN_FEWER_THAN = 10;

const isCode = (c) => c.type !== 'actor' && c.type !== 'external';
// "Vault.withdraw()" belongs to Vault; so does a part named just "Vault" when its functions are on the map.
function contractOf(c, all) {
  if (!isCode(c)) return null;
  if (c.name.includes('.')) return c.name.split('.')[0];
  return all.some((o) => o !== c && isCode(o) && o.name.startsWith(`${c.name}.`)) ? c.name : null;
}
const shortName = (c) => (isCode(c) && c.name.includes('.') ? c.name.slice(c.name.indexOf('.') + 1) : c.name);

export function createSystemMap() {
  let targetId = null;
  let picked = null;
  let query = '';
  let showAssumptions = false;
  let showRules = false;
  let activeRule = null; // the rule lens: what can change the state this rule is about
  let ruleData = null;
  let ruleSig = '';
  const hidden = new Set();
  const cam = { x: 0, y: 0, z: 1 };
  const fitted = new Set();
  let el = null;
  let parts = null; // the dom pieces that survive re-renders
  let size = { W: 0, H: 0 };
  let last = null; // the latest layout, for the flow panel and the overview

  function build() {
    const search = h('input.input.sm-search', { type: 'search', placeholder: 'Find a part…', 'aria-label': 'Find a part' });
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(true); });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const hit = list('component', (c) => c.targetId === targetId && c.name.toLowerCase().includes(query))[0];
      if (hit) { picked = hit.id; draw(true); centerOn(hit.id); }
    });
    const viewport = h('div.sm-viewport', { tabindex: 0 });
    const world = h('div.sm-world');
    const zoomLabel = h('button.zoom-value', { 'aria-label': 'Reset zoom', 'data-tip': 'Reset to 100%', on: { click: () => zoomTo(1) } }, '100%');
    viewport.append(world);
    const side = h('aside.sm-side');
    const full = h('button.tool.sm', { 'aria-label': 'Full screen', 'data-tip': 'Full screen (browser)', on: { click: () => toggleFullscreen() } }, icon('fit'));
    // The map fills the page; everything else floats on it.
    el = h('div.sysmap',
      viewport,
      h('div.sm-overlay',
        h('div.sm-bar.island', h('div.sm-title'), h('div.sm-tools', search)),
        h('div.sm-filters'),
        h('div.sm-gaps')),
      side,
      h('div.sm-zoom.island',
        h('button.tool.sm', { 'aria-label': 'Zoom out', 'data-tip': 'Zoom out ( - )', on: { click: () => zoomBy(0.8) } }, icon('minus')),
        zoomLabel,
        h('button.tool.sm', { 'aria-label': 'Zoom in', 'data-tip': 'Zoom in ( + )', on: { click: () => zoomBy(1.25) } }, icon('plus')),
        h('span.sep'),
        h('button.tool.sm', { 'aria-label': 'Fit to screen', 'data-tip': 'Fit everything ( F )', on: { click: () => fit() } }, icon('target')),
        full),
      h('div.sm-flow.island'),
      h('div.sm-mini.island', { 'aria-label': 'Overview: click to jump there' }),
      h('div.sm-hint', 'Drag to move · scroll or pinch to zoom · click a part to follow its connections · Esc to let go'));
    parts = { search, viewport, world, side, zoomLabel, full, flow: el.querySelector('.sm-flow'), mini: el.querySelector('.sm-mini') };
    parts.mini.addEventListener('pointerdown', (e) => { e.stopPropagation(); jumpFromMini(e); });
    document.addEventListener('fullscreenchange', () => { el.classList.toggle('is-full', document.fullscreenElement === el); requestAnimationFrame(() => fit()); });
    panZoom(viewport);
    viewport.addEventListener('click', (e) => {
      if (viewport.dataset.justPanned) return;
      if (!e.target.closest('.sm-node, .sm-label')) { picked = null; draw(true); }
    });
    addEventListener('resize', () => { if (el?.isConnected && targetId) { fitted.delete(targetId); draw(true); } });
  }

  function render(inner) {
    if (!el) build();
    inner.classList.add('wide');
    if (el.parentNode !== inner) inner.replaceChildren(el);
    const targets = list('target');
    if (!targets.length) {
      setChildren(el.querySelector('.sm-title'), h('h1', icon('graph'), 'System map'));
      parts.world.replaceChildren(h('div.empty.sm-empty', h('span.hand', 'No target yet'), 'Add the target you are researching. Agents map it first: every contract, who uses it, what it depends on, and how they connect.'));
      return;
    }
    const t = targets.find((x) => x.id === targetId) || targets[0];
    if (t.id !== targetId) { targetId = t.id; picked = null; }
    const comps = list('component', (c) => c.targetId === t.id);
    const rels = list('relation', (r) => r.targetId === t.id);
    const code = comps.filter((c) => c.type !== 'actor' && c.type !== 'external');

    setChildren(el.querySelector('.sm-title'),
      h('h1', icon('graph'), 'System map'),
      targets.length > 1
        ? h('select.select.sm-target', { 'aria-label': 'Target', on: { change: (e) => { targetId = e.target.value; picked = null; render(el.parentNode); } } },
          ...targets.map((x) => h('option', { value: x.id, selected: x.id === t.id }, x.name)))
        : h('span.sm-name', t.name),
      h('span.meta', `${code.length} code parts · ${comps.filter((c) => c.type === 'actor').length} people and roles · ${comps.filter((c) => c.type === 'external').length} outside · ${rels.length} connections`),
      phaseStepper(t, { compact: true }));
    if (!parts.search.isConnected) el.querySelector('.sm-tools').prepend(parts.search);
    setChildren(el.querySelector('.sm-tools'), parts.search,
      h(`button.btn${showRules ? '.on' : ''}`, { 'aria-pressed': String(showRules), on: { click: () => { showRules = !showRules; if (showRules) { picked = null; showAssumptions = false; } else activeRule = null; refreshRules(true); } } }, icon('shield'), `Rules${list('rule', (r) => r.targetId === t.id).length ? ` · ${list('rule', (r) => r.targetId === t.id).length}` : ''}`),
      h(`button.btn${showAssumptions ? '.on' : ''}`, { 'aria-pressed': String(showAssumptions), on: { click: () => { showAssumptions = !showAssumptions; if (showAssumptions) { picked = null; showRules = false; activeRule = null; } draw(true); } } }, icon('sticky'), 'Developers\' assumptions'),
      h('button.btn', { on: { click: () => addRelation(t) } }, icon('link'), 'Add connection'),
      h('button.btn.btn-primary', { on: { click: () => bus.newItem('component', { targetId: t.id }) } }, icon('plus'), 'Add part'));

    // the legend doubles as a filter: click a kind of connection to hide it
    const used = [...new Set(rels.map((r) => r.type))];
    setChildren(el.querySelector('.sm-filters'),
      ...used.map((k) => {
        const m = RELATION[k] || RELATION.other;
        const n = rels.filter((r) => r.type === k).length;
        return h('button.sm-chip', {
          'aria-pressed': String(!hidden.has(k)), style: { '--c': m.color }, 'data-tip': hidden.has(k) ? `Show "${m.label}" arrows` : `Hide "${m.label}" arrows`,
          on: { click: () => { if (hidden.has(k)) hidden.delete(k); else hidden.add(k); draw(true); } },
        }, h('i'), m.label, h('span.n', String(n)));
      }),
      used.length ? h('span.sm-key', h('span.k-actor'), 'person or role', h('span.k-ext'), 'outside dependency', h('span.k-code'), 'code (dot = review state)') : null);

    const linked = new Set(rels.flatMap((r) => [r.from, r.to]));
    const loose = comps.filter((c) => !linked.has(c.id));
    const gaps = el.querySelector('.sm-gaps');
    if (!loose.length || !comps.length) gaps.replaceChildren();
    else {
      setChildren(gaps, h('div.gap-banner.sm-gap',
        h('div', h('b', `${loose.length} of ${comps.length} parts are not connected to anything yet`), ' ', h('span.gap-names', loose.slice(0, 8).map((c) => c.name).join(', '), loose.length > 8 ? ', …' : '')),
        h('div.gap-acts',
          h('button.btn.btn-sm.btn-primary', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: t, action: 'cover', to: ['all'], text: `Map how these connect to the rest of ${t.name} (run recon scan on the source first, then recon map for what it cannot see): ${loose.map((c) => c.name).join(', ')}` }) } }, icon('send'), 'Ask an agent to map these'))));
    }
    if (showRules || activeRule) refreshRules(false);
    draw(false);
  }

  // ---------- rules: the lens ----------

  async function refreshRules(force) {
    const sig = `${targetId}|${list('rule', (r) => r.targetId === targetId).map((r) => `${r.id}:${r.updatedAt}`).join()}|${list('component', (c) => c.targetId === targetId).map((c) => c.updatedAt).join()}`;
    if (!force && sig === ruleSig) return;
    ruleSig = sig;
    try { ruleData = await get(`/api/rules?target=${encodeURIComponent(targetId)}`); } catch (err) { toast(err.message, 'error'); }
    sideSig = '';
    draw(true);
  }

  // parts that can change the active rule's state, with who can reach them
  function lensWriters() {
    if (!activeRule || !ruleData) return null;
    const r = ruleData.rules.find((x) => x.id === activeRule);
    if (!r) return null;
    const out = new Map();
    for (const w of r.exposure.writers) {
      const level = w.access === 'anyone' ? 'open' : w.access.startsWith('role:') ? 'role' : 'internal';
      const fnPart = list('component', (c) => c.targetId === targetId && c.name === `${w.component}.${w.fn}`)[0];
      for (const id of [w.componentId, fnPart?.id].filter(Boolean)) {
        const cur = out.get(id);
        if (!cur || (level === 'open' && cur !== 'open')) out.set(id, level);
      }
    }
    return { rule: r, parts: out };
  }

  // ---------- drawing ----------

  let lastSig = '';
  function draw(force) {
    if (!el || !targetId) return;
    const comps = list('component', (c) => c.targetId === targetId);
    const rels = list('relation', (r) => r.targetId === targetId);
    const sig = `${targetId}|${comps.map((c) => `${c.id}:${c.updatedAt}`).join()}|${rels.map((r) => `${r.id}:${r.updatedAt}`).join()}|${[...hidden].join()}|${picked}|${query}|${showAssumptions}|${showRules}|${activeRule}|${ruleSig}|${document.documentElement.dataset.theme}`;
    if (!force && sig === lastSig) { renderSide(comps, rels); return; }
    lastSig = sig;
    const { world } = parts;
    if (!comps.length) {
      world.replaceChildren(h('div.empty.sm-empty', h('span.hand', 'Nothing mapped yet'), 'In the mapping phase, agents add every contract, person and outside dependency here, and draw how they connect. recon scan draws most of it from the Solidity source.'));
      renderSide(comps, rels);
      return;
    }
    const shown = rels.filter((r) => !hidden.has(r.type));
    const { pos, edges, W, H } = layout(comps, shown);
    size = { W, H: H + 56 };
    const top = 56; // room for the column headings
    const focus = picked;
    const near = new Set(focus ? [focus, ...edges.filter((e) => e.from === focus || e.to === focus).flatMap((e) => [e.from, e.to])] : []);
    const matches = query ? new Set(comps.filter((c) => c.name.toLowerCase().includes(query) || (c.summary || '').toLowerCase().includes(query)).map((c) => c.id)) : null;

    const lens = lensWriters();
    const canvas = h(`div.sm-canvas${focus ? '.focusing' : ''}${matches ? '.searching' : ''}${lens && !focus ? '.lensing' : ''}`, { style: { width: `${W}px`, height: `${size.H}px` } });

    // column headings: who uses it, the code, what it depends on
    const cols = new Map();
    for (const c of comps) { const p = pos.get(c.id); if (!cols.has(p.x)) cols.set(p.x, []); cols.get(p.x).push(c); }
    const xs = [...cols.keys()].sort((a, b) => a - b);
    let codeCol = 0;
    for (const x of xs) {
      const cs = cols.get(x);
      const kind = cs.every((c) => c.type === 'actor') ? 'actor' : cs.every((c) => c.type === 'external') ? 'external' : 'code';
      const label = kind === 'actor' ? 'Who uses it' : kind === 'external' ? 'What it depends on' : codeCol++ === 0 ? 'The code they reach' : 'Called from the left';
      canvas.append(h(`div.sm-colhead.k-${kind}`, { style: { left: `${x}px`, width: `${NODE.w}px` } }, label));
    }

    // contract frames: functions of the same contract sit together in a light box
    const framed = new Set();
    for (const x of xs) {
      const cs = cols.get(x).slice().sort((a, b) => pos.get(a.id).y - pos.get(b.id).y);
      let i = 0;
      while (i < cs.length) {
        const k = contractOf(cs[i], comps);
        let j = i;
        while (j + 1 < cs.length && k && contractOf(cs[j + 1], comps) === k) j++;
        if (k && j > i) {
          const a = pos.get(cs[i].id);
          const b = pos.get(cs[j].id);
          for (let q = i; q <= j; q++) framed.add(cs[q].id);
          canvas.append(h('div.sm-frame', { style: { left: `${a.x - 10}px`, top: `${a.y + top - 24}px`, width: `${a.w + 20}px`, height: `${b.y - a.y + b.h + 34}px` } }, h('span', k)));
        }
        i = j + 1;
      }
    }

    const svg = svgEl('svg', { class: 'sm-edges', width: W, height: size.H, viewBox: `0 0 ${W} ${size.H}` });
    const labels = h('div.sm-labels');
    const showAllLabels = edges.length < LABELS_WHEN_FEWER_THAN;
    for (const e of edges) {
      const a = { ...pos.get(e.from) };
      const b = { ...pos.get(e.to) };
      a.y += top; b.y += top;
      const meta = RELATION[e.type] || RELATION.other;
      const forward = b.x > a.x;
      const x1 = forward ? a.x + a.w : a.x + a.w / 2;
      const y1 = forward ? a.y + a.h / 2 : a.y + (b.y > a.y ? a.h : 0);
      const x2 = forward ? b.x - 4 : b.x + b.w / 2;
      const y2 = forward ? b.y + b.h / 2 : b.y + (b.y > a.y ? -4 : b.h + 4);
      const ar = arrow(x1, y1, x2, y2, { seed: hash(e.id), curve: forward ? 0.08 : 0.35 });
      const hot = focus && (e.from === focus || e.to === focus);
      const g = svgEl('g', { class: `sm-edge${hot ? ' hot' : ''}`, style: `--c:${meta.color}`, 'data-from': e.from, 'data-to': e.to });
      g.append(svgEl('path', { d: ar.body }), svgEl('path', { d: ar.head }));
      svg.append(g);
      if (hot || (!focus && showAllLabels)) {
        const t = forward ? Math.max(0.5, 1 - 90 / Math.max(1, x2 - x1)) : 0.5;
        labels.append(h(`div.sm-label${hot ? '.hot' : ''}`, { style: { left: `${x1 + (x2 - x1) * t}px`, top: `${y1 + (y2 - y1) * t}px`, '--c': meta.color } },
          e.label ? `${meta.label} · ${truncate(e.label, 26)}` : meta.label));
      }
    }
    // nudge labels that land on each other
    const placed = [...labels.children].map((l) => ({ l, x: parseFloat(l.style.left), y: parseFloat(l.style.top) })).sort((p, q) => p.y - q.y);
    for (let i = 0; i < placed.length; i++) {
      for (let j = 0; j < i; j++) if (Math.abs(placed[j].x - placed[i].x) < 170 && Math.abs(placed[j].y - placed[i].y) < 22) placed[i].y = placed[j].y + 22;
      placed[i].l.style.top = `${placed[i].y}px`;
    }
    canvas.append(svg, labels);

    for (const c of comps) {
      const p = pos.get(c.id);
      const t = COMPONENT_TYPE[c.type] || COMPONENT_TYPE.other;
      const ext = c.type === 'actor' || c.type === 'external';
      const node = h('button.sm-node', {
        style: { left: `${p.x}px`, top: `${p.y + top}px`, width: `${p.w}px`, height: `${p.h}px`, '--c': ext ? 'var(--muted)' : REVIEW[c.reviewState].color },
        'data-type': c.type, 'data-id': c.id, 'data-ver': c.verification,
        class: [
          'sm-node',
          picked === c.id ? 'picked' : '',
          focus && near.has(c.id) ? 'near' : '',
          matches && matches.has(c.id) ? 'match' : '',
          !linked(c.id, rels) ? 'loose' : '',
          lens && lens.parts.has(c.id) ? `writer w-${lens.parts.get(c.id)}` : '',
        ].filter(Boolean).join(' '),
        title: `${c.name}${c.summary ? `\n${c.summary}` : ''}`,
        on: {
          click: (e) => { e.stopPropagation(); picked = picked === c.id ? null : c.id; showAssumptions = false; draw(true); },
          dblclick: () => bus.open(c.id),
        },
      });
      node.addEventListener('pointerenter', () => { if (!picked) hoverOn(canvas, c.id, true); });
      node.addEventListener('pointerleave', () => { if (!picked) hoverOn(canvas, c.id, false); });
      const sk = svgEl('svg', { class: 'sketch', viewBox: `0 0 ${p.w} ${p.h}`, width: p.w, height: p.h });
      sk.append(svgEl('path', { d: rect(p.w, p.h, { seed: hash(c.id), rough: 1 }) }));
      node.append(...[sk,
        lens && lens.parts.has(c.id) ? h('span.sm-writes', { 'data-level': lens.parts.get(c.id) }, lens.parts.get(c.id) === 'open' ? 'anyone can change it' : lens.parts.get(c.id) === 'role' ? 'a role can change it' : 'changes it') : null,
        h('span.sm-top', icon(t.icon), h('span', t.label), ext ? null : h('span.state-dot', { title: REVIEW[c.reviewState].label })),
        h('span.sm-nm', framed.has(c.id) && c.name.includes('.') ? shortName(c) : c.name),
        h('span.sm-sum', c.summary || (ext ? '' : 'no summary yet'))].filter(Boolean));
      canvas.append(node);
    }
    world.replaceChildren(canvas);
    last = { comps, edges, pos, W, H: size.H, top, canvas };
    renderFlow();
    renderMini();
    if (!fitted.has(targetId)) { fitted.add(targetId); requestAnimationFrame(() => fit(false)); }
    renderSide(comps, rels);
  }

  // ---------- the flow: every path through the picked part, start to end ----------

  // Paths from where things start (people, or parts nothing reaches) through the
  // picked part to where they end. Bounded so a large map stays readable.
  function flowsThrough(id, edges) {
    const out = new Map();
    const inc = new Map();
    for (const e of edges) {
      if (!out.has(e.from)) out.set(e.from, []);
      if (!inc.has(e.to)) inc.set(e.to, []);
      out.get(e.from).push(e);
      inc.get(e.to).push(e);
    }
    const walk = (start, next, end) => {
      const paths = [];
      const go = (node, path, seen) => {
        if (paths.length >= 24) return;
        const steps = (next.get(node) || []).filter((e) => !seen.has(end(e)));
        if (!steps.length || path.length >= 5) { paths.push(path); return; }
        for (const e of steps) go(end(e), [...path, e], new Set([...seen, end(e)]));
      };
      go(start, [], new Set([start]));
      return paths;
    };
    const ups = walk(id, inc, (e) => e.from).map((p) => p.reverse());
    const downs = walk(id, out, (e) => e.to);
    const rows = [];
    for (const u of ups) for (const d of downs) { rows.push([...u, ...d]); if (rows.length >= 40) break; }
    rows.sort((a, b) => b.length - a.length);
    return { rows: rows.slice(0, 12), total: rows.length };
  }

  // Every way from a person to the part that changes the rule's state.
  function upstream(id, edges) {
    const inc = new Map();
    for (const e of edges) { if (!inc.has(e.to)) inc.set(e.to, []); inc.get(e.to).push(e); }
    const paths = [];
    const go = (node, path, seen) => {
      if (paths.length >= 12) return;
      const steps = (inc.get(node) || []).filter((e) => !seen.has(e.from));
      if (!steps.length || path.length >= 4) { paths.push(path); return; }
      for (const e of steps) go(e.from, [e, ...path], new Set([...seen, e.from]));
    };
    go(id, [], new Set([id]));
    return paths;
  }

  function renderRuleFlow(lens) {
    const panel = parts.flow;
    const r = lens.rule;
    panel.hidden = false;
    el.classList.add('with-flow');
    const chip = (id) => {
      const c = byId(id);
      return h(`button.flow-node${lens.parts.has(id) ? `.w-${lens.parts.get(id)}` : ''}`, { 'data-type': c?.type || '', on: { click: () => { activeRule = null; picked = id; draw(true); requestAnimationFrame(() => centerOn(id)); } } },
        c && !isCode(c) ? icon((COMPONENT_TYPE[c.type] || COMPONENT_TYPE.other).icon) : null, c?.name || '?');
    };
    // one row per function that writes the state: exactly who may call it, the call, the part, what it writes
    const actorFor = (name) => list('component', (c) => c.targetId === targetId && c.type === 'actor' && c.name.toLowerCase() === name.toLowerCase())[0];
    const rows = [];
    for (const w of r.exposure.writers) {
      const level = w.access === 'anyone' ? 'open' : w.access.startsWith('role:') ? 'role' : 'internal';
      const callers = level === 'open' ? ['Anyone'] : level === 'role' ? w.access.slice(5).split('|') : [];
      const fnPart = list('component', (c) => c.targetId === targetId && c.name === `${w.component}.${w.fn}`)[0];
      const row = h('div.flow-row');
      for (const [i, who] of callers.entries()) {
        const a = actorFor(who);
        if (i) row.append(h('span.flow-or', 'or'));
        row.append(a ? chip(a.id) : h(`span.flow-node.w-${level}`, who));
      }
      if (!callers.length) row.append(h('span.flow-node', 'its own code'));
      row.append(h('span.flow-step', { style: { '--c': RELATION.calls.color } }, h('span.v', 'calls'), h('span.l', w.fn), h('span.arrow', '→')),
        chip(fnPart?.id || w.componentId),
        h(`span.flow-writes.w-${level}`, `writes ${w.writes.join(', ')}${level === 'open' ? ' · no check on the caller' : level === 'role' ? ` · only ${callers.join(' or ')}` : ''}`),
        w.location ? h('span.flow-loc', `${w.location.split(':')[0]}:${w.line}`) : null);
      rows.push(row);
    }
    setChildren(panel,
      h('div.flow-head',
        h('b', 'Who can break ', h('span.flow-here', `"${truncate(r.text, 60)}"`)),
        h('span.meta', r.exposure.why),
        h('button.tool.sm', { 'aria-label': 'Close the lens', on: { click: () => { activeRule = null; draw(true); } } }, icon('x'))),
      h('div.flow-rows', ...(rows.length ? rows : [h('div.sm-none', r.exposure.why)])));
  }

  function renderFlow() {
    const panel = parts.flow;
    const lens = !picked && lensWriters();
    if (lens && last) { renderRuleFlow(lens); return; }
    if (!picked || !last) { panel.hidden = true; el.classList.remove('with-flow'); return; }
    const it = byId(picked);
    const { rows, total } = flowsThrough(picked, last.edges);
    panel.hidden = false;
    el.classList.add('with-flow');
    const chip = (id) => {
      const c = byId(id);
      const ext = c && !isCode(c);
      return h(`button.flow-node${id === picked ? '.here' : ''}`, {
        'data-type': c?.type || '', title: c?.summary || '',
        on: { click: () => { picked = id; showAssumptions = false; draw(true); requestAnimationFrame(() => centerOn(id)); } },
      }, ext ? icon((COMPONENT_TYPE[c.type] || COMPONENT_TYPE.other).icon) : null, c?.name || '?');
    };
    const step = (e) => {
      const m = RELATION[e.type] || RELATION.other;
      return h('span.flow-step', { style: { '--c': m.color }, title: e.label || '' }, h('span.v', m.label), e.label ? h('span.l', truncate(e.label, 22)) : null, h('span.arrow', '→'));
    };
    const row = (path) => {
      const ids = [path[0]?.from ?? picked, ...path.map((e) => e.to)];
      const r = h('div.flow-row');
      if (!path.length) r.append(chip(picked));
      else { r.append(chip(path[0].from)); for (const e of path) r.append(step(e), chip(e.to)); }
      r.addEventListener('pointerenter', () => lightPath(ids, path, true));
      r.addEventListener('pointerleave', () => lightPath(ids, path, false));
      return r;
    };
    setChildren(panel,
      h('div.flow-head',
        h('b', 'Flow through ', h('span.flow-here', it?.name || '')),
        h('span.meta', rows.length && rows[0].length ? `${total} path${total === 1 ? '' : 's'} from where it starts to where it ends${total > rows.length ? `, longest ${rows.length} shown` : ''} · click a step to follow it` : 'Nothing connects to it yet'),
        h('button.tool.sm', { 'aria-label': 'Close the flow', on: { click: () => { picked = null; draw(true); } } }, icon('x'))),
      h('div.flow-rows', ...(rows.length ? rows : [[]]).map(row)));
  }

  function lightPath(ids, path, on) {
    const canvas = last?.canvas;
    if (!canvas) return;
    canvas.classList.toggle('pathing', on);
    const set = new Set(ids);
    for (const n of canvas.querySelectorAll('.sm-node')) n.classList.toggle('on-path', on && set.has(n.dataset.id));
    const keys = new Set(path.map((e) => `${e.from}>${e.to}`));
    for (const g of canvas.querySelectorAll('.sm-edge')) g.classList.toggle('on-path', on && keys.has(`${g.dataset.from}>${g.dataset.to}`));
  }

  // ---------- the overview: the whole map small, with where you are ----------

  const MINI_W = 200;
  function renderMini() {
    const box = parts.mini;
    if (!last || !last.comps.length) { box.hidden = true; return; }
    box.hidden = false;
    const k = MINI_W / last.W;
    const hgt = Math.max(60, Math.min(150, last.H * k));
    const kk = Math.min(k, hgt / last.H);
    const svg = svgEl('svg', { width: MINI_W, height: hgt, viewBox: `0 0 ${MINI_W} ${hgt}` });
    const ox = (MINI_W - last.W * kk) / 2;
    const near = new Set(picked ? [picked, ...last.edges.filter((e) => e.from === picked || e.to === picked).flatMap((e) => [e.from, e.to])] : []);
    for (const e of last.edges) {
      const a = last.pos.get(e.from);
      const b = last.pos.get(e.to);
      const hot = picked && (e.from === picked || e.to === picked);
      svg.append(svgEl('line', { x1: ox + (a.x + a.w / 2) * kk, y1: (a.y + last.top + a.h / 2) * kk, x2: ox + (b.x + b.w / 2) * kk, y2: (b.y + last.top + b.h / 2) * kk, class: `mini-edge${hot ? ' hot' : ''}`, style: `--c:${(RELATION[e.type] || RELATION.other).color}` }));
    }
    for (const c of last.comps) {
      const p = last.pos.get(c.id);
      svg.append(svgEl('rect', { x: ox + p.x * kk, y: (p.y + last.top) * kk, width: Math.max(3, p.w * kk), height: Math.max(2, p.h * kk), rx: 1.5, class: `mini-node${c.id === picked ? ' here' : near.has(c.id) ? ' near' : ''}`, 'data-type': c.type }));
    }
    const view = svgEl('rect', { class: 'mini-view', rx: 2 });
    svg.append(view);
    box.replaceChildren(svg);
    parts.miniMap = { kk, ox, view, hgt };
    paintMiniView();
  }

  function paintMiniView() {
    const m = parts.miniMap;
    if (!m || parts.mini.hidden) return;
    const r = parts.viewport.getBoundingClientRect();
    const x = (-cam.x / cam.z) * m.kk + m.ox;
    const y = (-cam.y / cam.z) * m.kk;
    m.view.setAttribute('x', Math.max(0, x));
    m.view.setAttribute('y', Math.max(0, y));
    m.view.setAttribute('width', Math.max(4, Math.min(MINI_W, (r.width / cam.z) * m.kk)));
    m.view.setAttribute('height', Math.max(4, Math.min(m.hgt, (r.height / cam.z) * m.kk)));
  }

  function jumpFromMini(e) {
    const m = parts.miniMap;
    if (!m) return;
    const b = parts.mini.querySelector('svg').getBoundingClientRect();
    const wx = (e.clientX - b.left - m.ox) / m.kk;
    const wy = (e.clientY - b.top) / m.kk;
    const r = parts.viewport.getBoundingClientRect();
    cam.x = r.width / 2 - wx * cam.z;
    cam.y = r.height / 2 - wy * cam.z;
    apply();
  }

  // Hover only toggles classes: no redraw while the mouse moves.
  function hoverOn(canvas, id, on) {
    canvas.classList.toggle('hovering', on);
    const near = new Set([id]);
    for (const g of canvas.querySelectorAll('.sm-edge')) {
      const hit = g.dataset.from === id || g.dataset.to === id;
      g.classList.toggle('lit', on && hit);
      if (hit) { near.add(g.dataset.from); near.add(g.dataset.to); }
    }
    for (const n of canvas.querySelectorAll('.sm-node')) n.classList.toggle('lit', on && near.has(n.dataset.id));
  }

  function linked(id, rels) { return rels.some((r) => r.from === id || r.to === id); }

  // ---------- the side card ----------

  let sideSig = '';
  function renderSide(comps, rels) {
    const { side } = parts;
    const it = picked ? byId(picked) : null;
    const t = byId(targetId);
    el.classList.toggle('with-side', Boolean(it || showAssumptions || showRules));
    if (it) {
      const sig = `p|${it.id}|${it.updatedAt}|${rels.map((r) => r.updatedAt).join()}`;
      if (sig === sideSig) return;
      sideSig = sig;
      const story = storyFor(it);
      const out = rels.filter((r) => r.from === it.id);
      const inc = rels.filter((r) => r.to === it.id);
      const row = (r, other) => h('button.sm-conn', { style: { '--c': (RELATION[r.type] || RELATION.other).color }, on: { click: () => { picked = other; draw(true); centerOn(other); } } },
        h('i'), h('span.v', (RELATION[r.type] || RELATION.other).label), h('b', byId(other)?.name || '?'), r.label ? h('span.l', r.label) : null);
      setChildren(side,
        h('div.sm-side-head', h('h3', it.name), h('button.tool.sm', { 'aria-label': 'Close', on: { click: () => { picked = null; draw(true); } } }, icon('x'))),
        h('div.sm-story', ...story.lines.filter(Boolean)),
        story.status ? h(`div.story-status.${story.tone}`, story.status) : null,
        h('div.sm-sec', `It reaches (${out.length})`), out.length ? h('div.sm-conns', ...out.map((r) => row(r, r.to))) : h('div.sm-none', 'Nothing. If it calls, pays or reads anything, that is missing from the map.'),
        h('div.sm-sec', `Reached by (${inc.length})`), inc.length ? h('div.sm-conns', ...inc.map((r) => row(r, r.from))) : h('div.sm-none', it.type === 'actor' ? 'A person or role: they start things.' : 'Nothing on the map reaches it yet.'),
        h('div.sm-acts',
          h('button.btn.btn-sm', { on: { click: () => bus.open(it.id) } }, icon('eye'), 'Full details'),
          h('button.btn.btn-sm', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: it, action: 'cover' }) } }, icon('send'), 'Point an agent here'),
          h('button.btn.btn-sm', { on: { click: () => addRelation(t) } }, icon('link'), 'Add connection')));
      return;
    }
    if (showRules && t) {
      const sig = `r|${t.id}|${ruleSig}|${activeRule}|${ruleData ? 1 : 0}`;
      if (sig === sideSig) return;
      sideSig = sig;
      renderRules(t);
      return;
    }
    if (showAssumptions && t) {
      const sig = `a|${t.id}|${list('assumption', (a) => a.targetId === t.id).map((a) => a.updatedAt).join()}`;
      if (sig === sideSig) return;
      sideSig = sig;
      side.replaceChildren();
      sidePanel(t, side);
      return;
    }
    sideSig = '';
    side.replaceChildren();
    void comps;
  }

  let draftState = new Set();
  function renderRules(t) {
    const { side } = parts;
    const vars = [...new Set(list('component', (c) => c.targetId === t.id).flatMap((c) => (c.surface || []).flatMap((f) => [...(f.writes || []), ...(f.reads || [])])))].sort();
    const text = h('textarea.textarea', { rows: 2, placeholder: 'A rule it must never break, e.g. "nobody withdraws more than they deposited"' });
    const cat = h('select.select', ...['conservation', 'solvency', 'accounting', 'bound', 'access', 'ordering', 'other'].map((c) => h('option', { value: c }, c)));
    const add = async (fields) => {
      try { const r = await write.create('rule', { targetId: t.id, ...fields }); activeRule = r.id; draftState = new Set(); refreshRules(true); } catch (err) { toast(err.message, 'error'); }
    };
    const statusPill = (r) => h(`span.rule-status.s-${r.status}`, { untested: 'not tried yet', holds: 'holds', broken: 'broken', inconclusive: 'inconclusive' }[r.status]);
    const rules = ruleData?.rules || [];
    setChildren(side,
      h('div.sm-side-head', h('h3', 'Rules'), h('button.tool.sm', { 'aria-label': 'Close', on: { click: () => { showRules = false; activeRule = null; draw(true); } } }, icon('x'))),
      h('p.rule-lead', 'What this protocol must never break. Click one to see every part that can change the state it depends on; an agent then tries to break it with an invariant test, a fuzzer or a symbolic run.'),
      h('div.rule-list', ...rules.map((r) => h(`div.rule-card${r.id === activeRule ? '.on' : ''}`, { 'data-level': r.exposure.level, on: { click: (e) => { if (e.target.closest('button')) return; activeRule = activeRule === r.id ? null : r.id; draw(true); } } },
        h('div.rule-top', statusPill(r), h('span.rule-cat', r.category), h(`span.rule-exp.x-${r.exposure.level}`, { open: 'anyone can touch it', guarded: 'a role can touch it', internal: 'internal only', untouched: 'nothing writes it', unscoped: 'no state yet', unmapped: 'not scanned' }[r.exposure.level])),
        h('div.rule-text', r.text),
        r.state?.length ? h('div.rule-state', ...r.state.map((v) => h('code', v))) : null,
        r.status === 'holds' ? h('div.rule-note', `Not broken by ${r.engine} (${r.runs}).`) : null,
        r.status === 'broken' ? h('div.rule-note.bad', `Broken by ${r.engine}: ${truncate(r.counterexample || '', 160)}`) : null,
        r.status === 'untested' ? h('div.rule-acts', h('button.btn.btn-xs', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: r, action: 'verify', to: ['all'], text: `Try to break this rule with an engine (Foundry invariant test, Halmos or Echidna), then record the result with recon_rule_result: "${r.text}"` }) } }, icon('send'), 'Ask an agent to break it')) : null))),
      rules.length ? null : h('div.sm-none', ruleData ? 'No rules yet. Add one below, or start from a suggestion.' : 'Loading…'),
      h('div.sm-sec', 'Add a rule'),
      text,
      vars.length ? h('div.rule-vars', h('span.help', 'It is about:'), ...vars.map((v) => h(`button.rule-var${draftState.has(v) ? '.on' : ''}`, { type: 'button', on: { click: (e) => { if (draftState.has(v)) draftState.delete(v); else draftState.add(v); e.currentTarget.classList.toggle('on'); } } }, v))) : h('div.help', 'Run recon scan to pick the state it is about from the code.'),
      h('div.rule-add', cat, h('button.btn.btn-primary.btn-sm', { on: { click: () => { const v = text.value.trim(); if (!v) { toast('Write the rule first.', 'error'); return; } add({ text: v, category: cat.value, state: [...draftState] }); } } }, icon('plus'), 'Add rule')),
      ruleData?.suggested?.length ? h('div.sm-sec', 'Suggested for this protocol') : null,
      ...(ruleData?.suggested || []).slice(0, 8).map((x) => h('div.rule-sug',
        h('div', h('div.rule-text', x.text), x.state.length ? h('div.rule-state', ...x.state.map((v) => h('code', v))) : null),
        h('button.btn.btn-xs', { on: { click: () => add({ text: x.text, category: x.category, state: x.state }) } }, icon('plus'), 'Add'))),
    );
  }

  // ---------- pan and zoom, local to this page ----------

  function apply() {
    parts.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    parts.zoomLabel.textContent = `${Math.round(cam.z * 100)}%`;
    paintMiniView();
  }
  function zoomTo(z) { const r = parts.viewport.getBoundingClientRect(); zoomAt(z, r.left + r.width / 2, r.top + r.height / 2); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => toast('Your browser did not allow full screen here.', 'error'));
  }
  // The part of the screen not covered by the floating panels.
  function free() {
    const r = parts.viewport.getBoundingClientRect();
    const top = el.querySelector('.sm-overlay').getBoundingClientRect();
    const sideOn = el.classList.contains('with-side');
    const sideR = parts.side.getBoundingClientRect();
    const flowOn = el.classList.contains('with-flow');
    const flowR = parts.flow.getBoundingClientRect();
    return { left: 16, top: top.bottom - r.top + 12, right: (sideOn ? sideR.left - r.left : r.width) - 16, bottom: (flowOn ? flowR.top - r.top - 12 : r.height - 64) };
  }
  function zoomAt(z, sx, sy) {
    const r = parts.viewport.getBoundingClientRect();
    z = Math.max(MIN_Z, Math.min(MAX_Z, z));
    const px = sx - r.left;
    const py = sy - r.top;
    const wx = (px - cam.x) / cam.z;
    const wy = (py - cam.y) / cam.z;
    cam.z = z; cam.x = px - wx * z; cam.y = py - wy * z;
    apply();
  }
  function zoomBy(f) { const r = parts.viewport.getBoundingClientRect(); zoomAt(cam.z * f, r.left + r.width / 2, r.top + r.height / 2); }
  function fit() {
    const r = parts.viewport.getBoundingClientRect();
    if (!size.W || !r.width) return;
    const f = free();
    const w = Math.max(200, f.right - f.left);
    const hh = Math.max(200, f.bottom - f.top);
    const z = Math.max(MIN_Z, Math.min(1.15, w / size.W, hh / size.H));
    cam.z = z; cam.x = f.left + (w - size.W * z) / 2; cam.y = f.top + Math.max(0, (hh - size.H * z) / 2);
    apply();
  }
  function centerOn(id) {
    const n = parts.world.querySelector(`[data-id="${id}"]`);
    if (!n) return;
    const f = free();
    const x = n.offsetLeft + n.offsetWidth / 2;
    const y = n.offsetTop + n.offsetHeight / 2;
    cam.z = Math.max(cam.z, 0.8);
    cam.x = (f.left + f.right) / 2 - x * cam.z;
    cam.y = (f.top + f.bottom) / 2 - y * cam.z;
    apply();
  }
  function panZoom(vp) {
    let pan = null;
    const pointers = new Map();
    let pinch = null;
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const mouse = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || e.metaKey || mouse) zoomAt(cam.z * Math.exp(-e.deltaY * (e.ctrlKey && !mouse ? 0.01 : 0.0018) * (e.deltaMode === 1 ? 33 : 1)), e.clientX, e.clientY);
      else { cam.x -= e.deltaX; cam.y -= e.deltaY; apply(); }
    }, { passive: false });
    vp.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.z }; pan = null; return; }
      if (e.target.closest('.sm-node')) return;
      pan = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
      vp.setPointerCapture(e.pointerId);
      vp.classList.add('panning');
    });
    vp.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; zoomAt(pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2); return; }
      if (!pan) return;
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      cam.x = pan.cx + dx; cam.y = pan.cy + dy;
      apply();
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pan) return;
      vp.classList.remove('panning');
      if (pan.moved) { vp.dataset.justPanned = '1'; setTimeout(() => delete vp.dataset.justPanned, 0); }
      pan = null;
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
    vp.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') zoomBy(1.2);
      else if (e.key === '-') zoomBy(0.83);
      else if (e.key === 'f' || e.key === 'F') fit();
      else if (e.key === 'Escape' && picked) { picked = null; draw(true); }
      else return;
      e.stopPropagation();
    });
  }

  return {
    render,
    zoomBy,
    release() { if (!picked) return false; picked = null; draw(true); return true; },
    pick(tid, id) {
      targetId = tid;
      if (byId(id)?.kind === 'rule') { showRules = true; activeRule = id; picked = null; refreshRules(true); return; }
      picked = id; showAssumptions = false; draw(true); requestAnimationFrame(() => centerOn(id));
    },
    fit,
  };
}

void toast;
