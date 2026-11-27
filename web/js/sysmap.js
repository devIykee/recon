// The system map: one full page for how a target fits together. Who uses it on
// the left, the code in the middle, what it depends on on the right, and every
// connection as a colored arrow. Click a part and everything unrelated fades, so
// you can read what it calls and what reaches it at a glance.

import { h, icon, setChildren, toast, hash, truncate } from './ui.js';
import { list, byId } from './state.js';
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
  const hidden = new Set();
  const cam = { x: 0, y: 0, z: 1 };
  const fitted = new Set();
  let el = null;
  let parts = null; // the dom pieces that survive re-renders
  let size = { W: 0, H: 0 };

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
    viewport.append(world, h('div.sm-zoom',
      h('button.tool.sm', { 'aria-label': 'Zoom in', 'data-tip': 'Zoom in', on: { click: () => zoomBy(1.25) } }, icon('plus')),
      h('button.tool.sm', { 'aria-label': 'Zoom out', 'data-tip': 'Zoom out', on: { click: () => zoomBy(0.8) } }, icon('minus')),
      h('button.tool.sm', { 'aria-label': 'Fit to screen', 'data-tip': 'Fit to screen', on: { click: () => fit() } }, icon('fit'))),
    h('div.sm-hint', 'Drag to move · scroll or pinch to zoom · click a part to see only its connections'));
    const side = h('aside.sm-side');
    el = h('div.sysmap',
      h('div.sm-bar', h('div.sm-title'), h('div.sm-tools', search)),
      h('div.sm-filters'),
      h('div.sm-gaps'),
      h('div.sm-body', viewport, side));
    parts = { search, viewport, world, side };
    panZoom(viewport);
    viewport.addEventListener('click', (e) => {
      if (viewport.dataset.justPanned) return;
      if (!e.target.closest('.sm-node, .sm-label, .sm-zoom')) { picked = null; draw(true); }
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
      h(`button.btn${showAssumptions ? '.on' : ''}`, { 'aria-pressed': String(showAssumptions), on: { click: () => { showAssumptions = !showAssumptions; if (showAssumptions) picked = null; draw(true); } } }, icon('sticky'), 'Developers\' assumptions'),
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
    draw(false);
  }

  // ---------- drawing ----------

  let lastSig = '';
  function draw(force) {
    if (!el || !targetId) return;
    const comps = list('component', (c) => c.targetId === targetId);
    const rels = list('relation', (r) => r.targetId === targetId);
    const sig = `${targetId}|${comps.map((c) => `${c.id}:${c.updatedAt}`).join()}|${rels.map((r) => `${r.id}:${r.updatedAt}`).join()}|${[...hidden].join()}|${picked}|${query}|${showAssumptions}|${document.documentElement.dataset.theme}`;
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

    const canvas = h(`div.sm-canvas${focus ? '.focusing' : ''}${matches ? '.searching' : ''}`, { style: { width: `${W}px`, height: `${size.H}px` } });

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
      node.append(sk,
        h('span.sm-top', icon(t.icon), h('span', t.label), ext ? null : h('span.state-dot', { title: REVIEW[c.reviewState].label })),
        h('span.sm-nm', framed.has(c.id) && c.name.includes('.') ? shortName(c) : c.name),
        h('span.sm-sum', c.summary || (ext ? '' : 'no summary yet')));
      canvas.append(node);
    }
    world.replaceChildren(canvas);
    if (!fitted.has(targetId)) { fitted.add(targetId); requestAnimationFrame(() => fit(false)); }
    renderSide(comps, rels);
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
    el.classList.toggle('with-side', Boolean(it || showAssumptions));
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

  // ---------- pan and zoom, local to this page ----------

  function apply() { parts.world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; }
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
    const z = Math.max(MIN_Z, Math.min(1.15, (r.width - 48) / size.W, (r.height - 48) / size.H));
    cam.z = z; cam.x = (r.width - size.W * z) / 2; cam.y = Math.max(16, (r.height - size.H * z) / 2);
    apply();
  }
  function centerOn(id) {
    const n = parts.world.querySelector(`[data-id="${id}"]`);
    if (!n) return;
    const r = parts.viewport.getBoundingClientRect();
    const x = n.offsetLeft + n.offsetWidth / 2;
    const y = n.offsetTop + n.offsetHeight / 2;
    cam.z = Math.max(cam.z, 0.8);
    cam.x = r.width / 2 - x * cam.z - (picked ? 160 : 0);
    cam.y = r.height / 2 - y * cam.z;
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
      if (e.target.closest('.sm-zoom, .sm-node')) return;
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
    pick(tid, id) { targetId = tid; picked = id; showAssumptions = false; draw(true); requestAnimationFrame(() => centerOn(id)); },
    fit,
  };
}

void toast;
