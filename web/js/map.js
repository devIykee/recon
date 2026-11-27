// The project map: the home view. Zoomed out it is a few big blocks (coverage,
// findings, hypotheses, agents, what to do next). Zoomed in, each target is a
// frame of component tiles colored by review state, with hypotheses and findings
// in lanes beside it, assumptions pinned below, and agents walking to whatever
// they are focused on. Any node expands in place.

import { h, icon, keyed, flash, setChildren, hash, truncate, plural } from './ui.js';
import { live, list, byId, coverage, healthOf, agentIsWriting, authorName, steersFor, titleOf } from './state.js';
import { createCamera } from './canvas.js';
import { sketchInto, arrow, ellipse, svgEl } from './sketch.js';
import { REVIEW, SEVERITY, STAGES, HYP_STATUS, PROTOCOL_ICON, PRIORITY } from './labels.js';
import { createDetail } from './detail.js';
import { avatar, authorAvatar } from './steer.js';
import { bus } from './bus.js';

const SUM = { w: 330, h: 196, gap: 28 };
const COMP = { w: 224, h: 124, gap: 24 };
const PAD = { x: 26, top: 58, bottom: 26 };
const LANE = { w: 280, hyp: 132, find: 120, gap: 18, offset: 96, between: 56 };
const STICKY = { w: 236, h: 150, gap: 28 };
const TARGET_TOP = 360;
const REGION_GAP = 220;

export function createMap({ stage, world, edges, nodes, markers, expandLayer }) {
  let layout = { nodes: [], byItem: new Map(), bounds: null };
  let expanded = null;
  const versions = new Map();
  let fitted = false;
  let emptyEl = null;

  const camera = createCamera(stage, world, {
    onChange: (cam) => {
      const zv = document.querySelector('.zoom-value');
      if (zv) zv.textContent = `${Math.round(cam.z * 100)}%`;
    },
  });

  // ---------- layout ----------

  function computeLayout() {
    const out = [];
    const byItem = new Map();
    const add = (n) => { out.push(n); if (n.item) byItem.set(n.item.id, n); return n; };
    const targets = list('target');
    const comps = list('component');
    const hyps = list('hypothesis');
    const finds = list('finding');
    const asms = list('assumption');

    // glance blocks
    const blocks = ['coverage', 'findings', 'hypotheses', 'agents', 'next'];
    blocks.forEach((b, i) => add({ key: `sum:${b}`, type: 'summary', block: b, x: i * (SUM.w + SUM.gap), y: 0, w: SUM.w, h: SUM.h }));
    const sumWidth = blocks.length * (SUM.w + SUM.gap) - SUM.gap;

    let x = 0;
    const regions = targets.map((t) => ({ t, comps: comps.filter((c) => c.targetId === t.id) }));
    const known = new Set(targets.map((t) => t.id));
    const orphanH = hyps.filter((x2) => !known.has(x2.targetId));
    const orphanF = finds.filter((x2) => !known.has(x2.targetId));
    const orphanA = asms.filter((x2) => !known.has(x2.targetId));

    for (const { t, comps: cs } of regions) {
      const n = cs.length + 1;
      const cols = Math.max(2, Math.min(5, Math.ceil(Math.sqrt(n * 1.5))));
      const rows = Math.ceil(n / cols);
      const fw = PAD.x * 2 + cols * COMP.w + (cols - 1) * COMP.gap;
      const fh = PAD.top + rows * COMP.h + (rows - 1) * COMP.gap + PAD.bottom;
      const fx = x;
      const fy = TARGET_TOP;
      add({ key: `frame:${t.id}`, type: 'frame', item: t, x: fx, y: fy, w: fw, h: fh });
      const order = cs.slice().sort((a, b) => a.createdAt - b.createdAt);
      order.forEach((c, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        add({ key: c.id, type: 'comp', item: c, x: fx + PAD.x + col * (COMP.w + COMP.gap), y: fy + PAD.top + row * (COMP.h + COMP.gap), w: COMP.w, h: COMP.h });
      });
      const ai = order.length;
      add({ key: `add:${t.id}`, type: 'add', target: t, x: fx + PAD.x + (ai % cols) * (COMP.w + COMP.gap), y: fy + PAD.top + Math.floor(ai / cols) * (COMP.h + COMP.gap), w: COMP.w, h: COMP.h });

      const hx = fx + fw + LANE.offset;
      const fxl = hx + LANE.w + LANE.between;
      const th = hyps.filter((y) => y.targetId === t.id).sort(laneSort);
      const tf = finds.filter((y) => y.targetId === t.id).sort(findSort);
      add({ key: `lane-h:${t.id}`, type: 'lane', label: 'hypotheses', x: hx, y: fy, w: LANE.w, h: 0 });
      add({ key: `lane-f:${t.id}`, type: 'lane', label: 'findings', x: fxl, y: fy, w: LANE.w, h: 0 });
      th.forEach((y, i) => add({ key: y.id, type: 'hyp', item: y, x: hx, y: fy + i * (LANE.hyp + LANE.gap), w: LANE.w, h: LANE.hyp }));
      // Place each finding level with what it came from, so arrows stay short and do not cross.
      const anchorY = (f) => {
        const src = byItem.get(f.hypothesisId) || byItem.get(f.componentId);
        return src ? src.y : Infinity;
      };
      let nextFree = fy;
      tf.slice().sort((a, b) => anchorY(a) - anchorY(b) || findSort(a, b)).forEach((y) => {
        const want = anchorY(y);
        const top = Math.max(nextFree, Number.isFinite(want) ? want : nextFree);
        add({ key: y.id, type: 'find', item: y, x: fxl, y: top, w: LANE.w, h: LANE.find });
        nextFree = top + LANE.find + LANE.gap;
      });

      const ta = asms.filter((y) => y.targetId === t.id);
      const perRow = Math.max(1, Math.floor((fw + STICKY.gap) / (STICKY.w + STICKY.gap)));
      const ay = fy + fh + 96;
      if (ta.length) add({ key: `lane-a:${t.id}`, type: 'lane', label: 'assumptions', x: fx, y: ay, w: fw, h: 0 });
      ta.forEach((y, i) => add({
        key: y.id, type: 'sticky', item: y,
        x: fx + (i % perRow) * (STICKY.w + STICKY.gap), y: ay + Math.floor(i / perRow) * (STICKY.h + STICKY.gap), w: STICKY.w, h: STICKY.h,
      }));

      const laneBottom = fy + Math.max(th.length * (LANE.hyp + LANE.gap), tf.length * (LANE.find + LANE.gap));
      void laneBottom;
      x = fxl + LANE.w + REGION_GAP;
    }

    if (orphanH.length || orphanF.length || orphanA.length) {
      const fy = TARGET_TOP;
      add({ key: 'lane-h:none', type: 'lane', label: 'hypotheses (no target)', x, y: fy, w: LANE.w, h: 0 });
      orphanH.forEach((y, i) => add({ key: y.id, type: 'hyp', item: y, x, y: fy + i * (LANE.hyp + LANE.gap), w: LANE.w, h: LANE.hyp }));
      const fx2 = x + LANE.w + LANE.between;
      add({ key: 'lane-f:none', type: 'lane', label: 'findings (no target)', x: fx2, y: fy, w: LANE.w, h: 0 });
      orphanF.forEach((y, i) => add({ key: y.id, type: 'find', item: y, x: fx2, y: fy + i * (LANE.find + LANE.gap), w: LANE.w, h: LANE.find }));
      const ax = fx2 + LANE.w + LANE.between;
      orphanA.forEach((y, i) => add({ key: y.id, type: 'sticky', item: y, x: ax, y: fy + i * (STICKY.h + STICKY.gap), w: STICKY.w, h: STICKY.h }));
    }

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of out) {
      if (n.type === 'lane') continue;
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y - (n.type === 'frame' ? 50 : 0));
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    }
    void sumWidth;
    return { nodes: out, byItem, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
  }

  // ---------- nodes ----------

  function createNode(n) {
    const el = h(`div.node.${n.type}`);
    if (['summary', 'frame', 'comp', 'hyp', 'find', 'add'].includes(n.type)) el.append(svgEl('svg', { class: 'sketch' }));
    if (n.type === 'comp' || n.type === 'hyp' || n.type === 'find') el.append(h('div.fill'), h('div.node-body'));
    if (n.type === 'hyp' || n.type === 'find') el.classList.add('lane-card');
    if (n.type === 'sticky') { el.append(h('div.paper'), h('div.node-body')); el.style.setProperty('--tilt', `${((hash(n.key) % 50) / 10 - 2.5).toFixed(1)}deg`); }
    if (n.type === 'summary') el.append(h('div.sum-body'));
    if (n.type === 'frame') el.append(h('div.frame-label'), h('div.frame-bar'), h('div.frame-tip'));
    if (n.type === 'add') el.append(h('div.add-body', icon('plus'), ' add component'));
    if (n.type === 'lane') el.className = 'lane-label';
    el.addEventListener('click', (e) => onNodeClick(e, el));
    return el;
  }

  function onNodeClick(e, el) {
    if (stage.dataset.justPanned) return;
    const n = el._node;
    if (!n) return;
    if (n.type === 'summary') { summaryClick(n.block); return; }
    if (n.type === 'add') { bus.newItem('component', { targetId: n.target.id }); return; }
    if (n.type === 'frame') { if (e.target.closest('.frame-label, .frame-bar')) expand(n.item.id); return; }
    if (n.item) expand(n.item.id);
  }

  function summaryClick(block) {
    if (block === 'coverage') bus.view('coverage');
    else if (block === 'findings') bus.view('findings');
    else if (block === 'hypotheses') bus.view('hypotheses');
    else if (block === 'agents') bus.view('agents');
    else bus.sidebar('next');
  }

  function updateNode(el, n, fresh) {
    el._node = n;
    if (n.type === 'lane') {
      el.textContent = n.label;
      el.style.translate = `${n.x}px ${n.y - 30}px`;
      return;
    }
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    el.style.width = `${n.w}px`;
    el.style.height = `${n.h}px`;
    const svg = el.querySelector(':scope > .sketch');
    if (svg) sketchInto(svg, n.w, n.h, hash(n.key), { rough: n.type === 'frame' ? 1.6 : n.type === 'summary' ? 1.4 : 1 });

    const it = n.item;
    const v = it ? `${it.updatedAt}:${steerSig(it.id)}:${focusSig(it.id)}` : summarySig(n);
    if (!fresh && versions.get(n.key) === v) return;
    const changed = !fresh && versions.has(n.key) && it && live.recent.get(it.id) && Date.now() - live.recent.get(it.id) < 3000;
    versions.set(n.key, v);

    switch (n.type) {
      case 'summary': el.dataset.block = n.block; renderSummary(el, n); break;
      case 'frame': renderFrame(el, n); break;
      case 'comp': renderComp(el, it); break;
      case 'hyp': renderHyp(el, it); break;
      case 'find': renderFind(el, it); break;
      case 'sticky': renderSticky(el, it); break;
      default:
    }
    if (changed) flash(el);
  }

  function steerSig(id) {
    return steersFor(id).map((s) => s.state[0]).join('');
  }

  function focusSig(id) {
    return list('agent').filter((a) => a.focusItem === id).map((a) => a.id).join(',');
  }

  function summarySig(n) {
    if (n.type !== 'summary') return n.key;
    const s = live.state;
    return `${n.block}:${s.activity.length}:${JSON.stringify(s.health)}:${s.suggestions.map((x) => x.id).join()}`;
  }

  function badges(it) {
    const out = [];
    const steers = steersFor(it.id);
    if (steers.length) out.push(h(`span.badge.steer${steers.some((s) => s.state === 'open') ? '.open' : ''}`, { 'data-tip': `${plural(steers.length, 'steer')} waiting` }, icon('flag'), steers.length));
    if (it.verification === 'verified') out.push(h('span.badge.ver-verified', { 'data-tip': 'You verified this' }, icon('check')));
    if (it.verification === 'disputed') out.push(h('span.badge.ver-disputed', { 'data-tip': 'You disputed this' }, icon('x')));
    if (it.priority === 'high' || it.priority === 'urgent') out.push(h(`span.badge.prio-${it.priority}`, { 'data-tip': `${PRIORITY[it.priority].label} priority` }, icon(PRIORITY[it.priority].icon)));
    return out;
  }

  function renderComp(el, c) {
    el.dataset.state = c.reviewState;
    el.dataset.ver = c.verification;
    const focusedBy = list('agent').filter((a) => a.focusItem === c.id);
    el.classList.toggle('focused', focusedBy.length > 0);
    const checks = Object.values(c.checklist || {}).filter((x) => x.state !== 'unchecked').length;
    const owner = c.owner ? byId(c.owner) : null;
    setChildren(el.querySelector('.node-body'),
      h('div.node-top', h('span.state-dot'), h('span.kind', c.type), h('span.badges', ...badges(c))),
      h('div.node-title', c.name),
      h('div.node-detail', c.reasoning || REVIEW[c.reviewState].hint),
      h('div.node-foot',
        owner ? h('span.badge.owner', { 'data-tip': `Owned by ${owner.name}` }, avatar(owner, 'xs')) : null,
        h('span.mini', { 'data-tip': 'Evidence attached' }, icon('code'), (c.evidence || []).length),
        h('span.mini', { 'data-tip': 'Checklist items done' }, icon('list'), checks),
        h('span', { style: { marginLeft: 'auto' } }, REVIEW[c.reviewState].label)));
  }

  function renderHyp(el, y) {
    el.dataset.status = y.status;
    el.dataset.ver = y.verification;
    setChildren(el.querySelector('.node-body'),
      h('div.node-top', h('span.conf', { 'data-c': y.confidence, 'data-tip': `${y.confidence} confidence` }, h('i'), h('i'), h('i')),
        h('span.kind', HYP_STATUS[y.status].label), y.bugClass ? h('span.stage-chip', y.bugClass) : null, h('span.badges', ...badges(y))),
      h('div.node-title', y.text),
      h('div.node-detail', y.reasoning || ''),
      h('div.node-foot', authorAvatar(y.createdBy), authorName(y.createdBy),
        h('span.mini', { style: { marginLeft: 'auto' } }, icon('code'), (y.evidence || []).length)));
  }

  function renderFind(el, f) {
    el.style.setProperty('--c', SEVERITY[f.severity].color);
    el.dataset.ver = f.verification;
    setChildren(el.querySelector('.node-body'),
      h('div.node-top', h('span.sev', SEVERITY[f.severity].label), h('span.stage-chip', STAGES[f.stage].label), h('span.badges', ...badges(f))),
      h('div.node-title', f.title),
      h('div.node-foot', f.bugClass ? h('span', f.bugClass) : null, f.bounty ? h('span', `$${Number(f.bounty).toLocaleString()}`) : null,
        h('span', { style: { marginLeft: 'auto' } }, f.repro ? 'repro ✓' : 'no repro yet')));
  }

  function renderSticky(el, a) {
    el.dataset.state = a.state;
    el.dataset.ver = a.verification;
    setChildren(el.querySelector('.node-body'),
      h('div.node-top', h('span.kind', a.state === 'assumed' ? 'assumption' : a.state === 'verified' ? 'holds' : 'broken'), h('span.badges', ...badges(a))),
      h('div.node-title', a.text),
      h('div.node-foot', authorAvatar(a.createdBy), a.scope ? truncate(a.scope, 30) : ''));
  }

  function renderFrame(el, n) {
    const t = n.item;
    const cov = coverage(t.id);
    setChildren(el.querySelector('.frame-label'),
      h('span.name', `${PROTOCOL_ICON[t.protocolType] || ''} ${t.name}`),
      h('span.meta', h('span.pill', t.protocolType), t.chain ? h('span', t.chain) : null, h('span', `${cov.pct}% covered`), ...badges(t)));
    setChildren(el.querySelector('.frame-bar'), ...['flagged', 'reviewed', 'scanning', 'untouched'].map((s) => h('span', {
      style: { flexGrow: cov.counts[s] || 0, background: REVIEW[s].color, opacity: s === 'untouched' ? 0.35 : 1 },
      'data-tip': `${REVIEW[s].label}: ${cov.counts[s] || 0}`,
    })));
    const untouched = cov.counts.untouched;
    el.querySelector('.frame-tip').textContent = untouched
      ? `${plural(untouched, 'part')} nobody has looked at yet (hatched). ${cov.counts.flagged ? `${cov.counts.flagged} flagged.` : ''}`
      : cov.total ? 'Every part has been looked at.' : 'No components yet. Add the contracts or functions in scope.';
  }

  function renderSummary(el, n) {
    const body = el.querySelector('.sum-body');
    const s = live.state;
    switch (n.block) {
      case 'coverage': {
        const cov = coverage();
        setChildren(body,
          h('div.sum-label', icon('coverage'), h('span.term', { 'data-term': 'coverage' }, 'Coverage')),
          h('div.sum-value', `${cov.pct}%`, h('small', `of ${plural(cov.total, 'part')}`)),
          h('div.sum-foot', ...['untouched', 'scanning', 'reviewed', 'flagged'].map((k) => h('span.kv', { style: { '--c': REVIEW[k].color } }, h('span.sw'), `${cov.counts[k]} ${REVIEW[k].label.toLowerCase()}`))),
          ring(cov));
        break;
      }
      case 'findings': {
        const open = list('finding', (f) => !['fixed', 'disclosed'].includes(f.stage));
        const bySev = Object.keys(SEVERITY).map((k) => [k, open.filter((f) => f.severity === k).length]).filter(([, c]) => c);
        setChildren(body,
          h('div.sum-label', icon('bug'), h('span.term', { 'data-term': 'finding' }, 'Open findings')),
          h('div.sum-value', String(open.length), h('small', `${list('finding').length - open.length} closed`)),
          h('div.sum-foot', ...(bySev.length ? bySev.map(([k, c]) => h('span.kv', { style: { '--c': SEVERITY[k].color } }, h('span.sw'), `${c} ${k}`)) : [h('span', 'none yet')])));
        break;
      }
      case 'hypotheses': {
        const testing = list('hypothesis', (x) => x.status === 'testing');
        const high = testing.filter((x) => x.confidence === 'high').length;
        setChildren(body,
          h('div.sum-label', icon('flask'), h('span.term', { 'data-term': 'hypothesis' }, 'Hypotheses in flight')),
          h('div.sum-value', String(testing.length), h('small', `${list('hypothesis', (x) => x.status === 'confirmed').length} confirmed`)),
          h('div.sum-foot', h('span', `${high} high confidence`), h('span', `${list('hypothesis', (x) => x.status === 'dropped').length} dropped`), h('span', `${list('assumption', (x) => x.state === 'assumed').length} open assumptions`)));
        break;
      }
      case 'agents': {
        const agents = list('agent');
        const active = agents.filter((a) => healthOf(a.id).status === 'active');
        const steers = list('steer', (x) => x.state !== 'addressed');
        const flagged = agents.filter((a) => healthOf(a.id).flags.some((f) => ['stuck', 'looping', 'noisy', 'no-output', 'disputed'].includes(f)));
        setChildren(body,
          h('div.sum-label', icon('agents'), agents.length > 1 ? 'Swarm' : 'Agent'),
          h('div.sum-value', String(active.length), h('small', `active of ${agents.length}`)),
          h('div.sum-foot',
            agents.length ? h('span.sum-avatars', ...agents.slice(0, 6).map((a) => avatar(a))) : h('span', 'no agent connected yet'),
            h('span', `${plural(steers.length, 'open steer')}`),
            flagged.length ? h('span', { style: { color: 'var(--bad)' } }, `${flagged.length} need a look`) : null));
        break;
      }
      case 'next': {
        const sug = s.suggestions.slice(0, 2);
        const pending = list('proposal', (p) => p.state === 'pending');
        setChildren(body,
          h('div.sum-label', icon('compass'), 'Where to look next'),
          pending.length
            ? h('div.sum-text', `${authorName(pending[0].createdBy)} proposes: ${truncate(pending[0].text, 70)}`)
            : sug.length ? h('div.sum-text', truncate(sug[0].title, 70)) : h('div', { style: { font: '400 20px var(--font-hand)', color: 'var(--muted)' } }, 'Nothing obvious. Nice.'),
          h('div.sum-foot', pending.length ? h('span', { style: { color: 'var(--primary)' } }, `${plural(pending.length, 'proposal')} waiting for your yes/no`) : null,
            h('span', `${plural(s.suggestions.length, 'suggestion')} →`)));
        break;
      }
      default:
    }
  }

  function ring(cov) {
    const svg = svgEl('svg', { class: 'cov-ring', viewBox: '0 0 100 100' });
    const r = 38;
    const c = 2 * Math.PI * r;
    svg.append(svgEl('circle', { cx: 50, cy: 50, r, stroke: 'var(--island-3)' }));
    let off = 0;
    for (const k of ['flagged', 'reviewed', 'scanning']) {
      const part = cov.total ? cov.counts[k] / cov.total : 0;
      if (!part) continue;
      svg.append(svgEl('circle', {
        class: 'seg', cx: 50, cy: 50, r, stroke: REVIEW[k].color,
        'stroke-dasharray': `${part * c} ${c}`, 'stroke-dashoffset': -off * c, transform: 'rotate(-90 50 50)', 'stroke-linecap': 'butt',
      }));
      off += part;
    }
    const sk = svgEl('path', { d: ellipse(50, 50, 47, 47, { seed: 7 }), fill: 'none', stroke: 'var(--border-strong)', 'stroke-width': 1.2 });
    svg.append(sk);
    return svg;
  }

  // ---------- edges ----------

  function renderEdges() {
    const paths = [];
    const anchor = (n, side) => {
      if (side === 'right') return [n.x + n.w, n.y + n.h / 2];
      if (side === 'left') return [n.x, n.y + n.h / 2];
      if (side === 'top') return [n.x + n.w / 2, n.y];
      return [n.x + n.w / 2, n.y + n.h];
    };
    for (const n of layout.nodes) {
      const it = n.item;
      if (!it) continue;
      let from = null; let to = null; let cls = '';
      if (n.type === 'hyp' && it.componentId) { const c = layout.byItem.get(it.componentId); if (c) { from = anchor(n, 'left'); to = anchor(c, 'right'); cls = 'hyp'; } }
      if (n.type === 'find') {
        const src = layout.byItem.get(it.hypothesisId) || layout.byItem.get(it.componentId);
        if (src) { from = anchor(n, 'left'); to = anchor(src, 'right'); cls = 'find'; }
      }
      if (n.type === 'sticky' && it.componentId) { const c = layout.byItem.get(it.componentId); if (c) { from = anchor(n, 'top'); to = anchor(c, 'bottom'); cls = 'asm'; } }
      if (!from) continue;
      const a = arrow(from[0] - (cls === 'asm' ? 0 : 4), from[1], to[0] + (cls === 'asm' ? 0 : 6), to[1] + (cls === 'asm' ? 6 : 0), { seed: hash(n.key), curve: 0.12 });
      paths.push(svgEl('path', { class: `edge ${cls}`, d: a.body }));
      if (cls !== 'asm') paths.push(svgEl('path', { class: `edge-head ${cls}`, d: a.head }));
    }
    edges.replaceChildren(...paths);
  }

  // ---------- agent markers ----------

  function renderMarkers() {
    const agents = list('agent').filter((a) => a.focusItem && layout.byItem.get(a.focusItem));
    const perItem = new Map();
    keyed(markers, agents, (a) => a.id, (a) => {
      const el = h('div.marker', { on: { click: () => bus.view('agents') } });
      el.dataset.agent = a.id;
      return el;
    }, (el, a) => {
      const n = layout.byItem.get(a.focusItem);
      const i = perItem.get(a.focusItem) || 0;
      perItem.set(a.focusItem, i + 1);
      el.style.setProperty('--c', a.color);
      el.style.transform = `translate(${n.x + n.w - 18 - i * 26}px, ${n.y - 16}px)`;
      el.classList.toggle('writing', Boolean(agentIsWriting(a.id)));
      const sig = `${a.name}|${a.color}|${healthOf(a.id).status}|${a.focus}`;
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig;
        setChildren(el, avatar(a, 'sm'), h('span.tag', { title: a.focus || '' }, a.name));
      }
    });
  }

  // ---------- expand in place ----------

  function expand(id) {
    const n = layout.byItem.get(id);
    if (!n) return false;
    if (expanded?.id === id) { camera.reveal(rectOf(expanded.el, n)); return true; }
    collapse();
    const item = byId(id);
    const detail = createDetail(item, { onClose: collapse, inMap: true });
    const el = h('div.expanded', detail.el);
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => { if (el.querySelector('.detail-scroll').scrollHeight > el.querySelector('.detail-scroll').clientHeight) e.stopPropagation(); }, { passive: true });
    expandLayer.append(el);
    expanded = { id, el, detail };
    position();
    requestAnimationFrame(() => camera.reveal(rectOf(el, n)));
    return true;
  }

  function rectOf(el, n) {
    return { x: n.x - 8, y: n.y - 8, w: Math.max(el.offsetWidth, n.w) + 16, h: Math.min(el.offsetHeight, 760) + 16 };
  }

  function position() {
    if (!expanded) return;
    const n = layout.byItem.get(expanded.id);
    if (!n) { collapse(); return; }
    expanded.el.style.left = `${n.x - 6}px`;
    expanded.el.style.top = `${n.y - 6}px`;
  }

  function collapse() {
    if (!expanded) return;
    const { el } = expanded;
    el.classList.add('leave');
    setTimeout(() => el.remove(), 180);
    expanded = null;
  }

  // ---------- render ----------

  function render() {
    if (!live.state) return;
    layout = computeLayout();
    const hasTargets = list('target').length > 0;
    keyed(nodes, layout.nodes, (n) => n.key, createNode, updateNode);
    renderEdges();
    renderMarkers();
    if (expanded) {
      const item = byId(expanded.id);
      if (!item) collapse(); else { expanded.detail.update(item); position(); }
    }
    if (!fitted && layout.bounds && Number.isFinite(layout.bounds.w)) {
      fitted = true;
      if (!camera.restore()) camera.fit(layout.bounds, { animate: false });
    }
    showEmpty(!hasTargets);
  }

  function showEmpty(on) {
    if (on && !emptyEl) {
      emptyEl = h('div.map-empty',
        h('div.big', 'What are we hunting?'),
        h('p', 'Name a target, pick what kind of protocol it is, and connect an agent. recon will lay out the attack surface and suggest where to start.'),
        h('button.btn.btn-primary', { on: { click: () => bus.newItem('target') } }, icon('target'), 'Add your first target'));
      document.getElementById('app').append(emptyEl);
    } else if (!on && emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }
  }

  return {
    camera,
    render,
    expand,
    collapse,
    get expandedId() { return expanded?.id || null; },
    has(id) { return layout.byItem.has(id); },
    fit() { if (layout.bounds) camera.fit(layout.bounds); },
    hide(on) { if (emptyEl) emptyEl.hidden = on; },
    focusAgent(agentId) {
      const a = byId(agentId);
      const n = a?.focusItem && layout.byItem.get(a.focusItem);
      if (n) camera.centerOn(n.x + n.w / 2, n.y + n.h / 2, Math.max(camera.cam.z, 0.9));
    },
    titleOf,
  };
}

function laneSort(a, b) {
  const rank = { confirmed: 0, testing: 1, dropped: 2 };
  const conf = { high: 0, med: 1, low: 2 };
  return rank[a.status] - rank[b.status] || conf[a.confidence] - conf[b.confidence] || a.createdAt - b.createdAt;
}

function findSort(a, b) {
  const sev = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return sev[a.severity] - sev[b.severity] || a.createdAt - b.createdAt;
}
