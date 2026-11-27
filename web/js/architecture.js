// The architecture view: how a target fits together, drawn by hand.
// Actors on the left, the code they reach in the middle, external dependencies on
// the right, and every relation as a labeled arrow. Beside it: what the
// developers assume, which is what the hunt will try to break.

import { h, icon, keyed, setChildren, toast, hash, truncate, modal } from './ui.js';
import { live, list, byId, write } from './state.js';
import { RELATION, COMPONENT_TYPE, REVIEW, PHASES, ORIGIN, CATEGORY } from './labels.js';
import { arrow, rect, svgEl } from './sketch.js';
import { createDetail } from './detail.js';
import { openSteerComposer, authorAvatar } from './steer.js';
import { bus, loadPlaybook } from './bus.js';

const NODE = { w: 200, h: 78, gapY: 34, gapX: 350, pad: 40 };
const TIGHT_GAP = 250; // when there are few connections, columns sit closer

export function phaseStepper(target, { compact = false } = {}) {
  const current = PHASES.findIndex((p) => p.id === (target.phase || 'mapping'));
  return h(`div.phases${compact ? '.compact' : ''}`, ...PHASES.map((p, i) => h('button.phase', {
    type: 'button',
    'data-state': i < current ? 'done' : i === current ? 'now' : 'next',
    'data-tip': `${p.label}: ${p.hint}${compact ? '' : '. Click to move the target here.'}`,
    on: compact ? {} : {
      click: async (e) => {
        e.stopPropagation();
        try { await write.update('target', target.id, { phase: p.id }); } catch (err) { toast(err.message, 'error'); }
      },
    },
  }, h('span.num', i < current ? '✓' : String(i + 1)), h('span.lbl', p.label))));
}

// Layered layout: actors first, then by longest path from them, externals last.
function layout(comps, rels) {
  const ids = new Set(comps.map((c) => c.id));
  const edges = rels.filter((r) => ids.has(r.from) && ids.has(r.to) && r.from !== r.to);
  const out = new Map(comps.map((c) => [c.id, []]));
  const indeg = new Map(comps.map((c) => [c.id, 0]));
  for (const e of edges) { out.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  const layer = new Map();
  const isActor = (c) => c.type === 'actor';
  const isExt = (c) => c.type === 'external';
  for (const c of comps) if (isActor(c) || (!isExt(c) && indeg.get(c.id) === 0)) layer.set(c.id, isActor(c) ? 0 : 1);
  // relax longest path (bounded, so cycles cannot loop forever)
  for (let pass = 0; pass < comps.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const from = layer.get(e.from);
      if (from === undefined) continue;
      const toC = comps.find((c) => c.id === e.to);
      if (isActor(toC) || isExt(toC)) continue;
      const want = Math.min(from + 1, 12);
      if ((layer.get(e.to) ?? -1) < want) { layer.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  const actorsOnly = comps.every((c) => isActor(c) || isExt(c));
  let maxL = 0;
  for (const c of comps) {
    if (!layer.has(c.id) && !isExt(c)) layer.set(c.id, 1);
    if (!isExt(c)) maxL = Math.max(maxL, layer.get(c.id));
  }
  for (const c of comps) if (isExt(c)) layer.set(c.id, actorsOnly ? 1 : maxL + 1);
  // order within a layer by the average row of its parents
  const cols = new Map();
  for (const c of comps) { const l = layer.get(c.id); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(c); }
  const row = new Map();
  const layers = [...cols.keys()].sort((a, b) => a - b);
  for (const l of layers) {
    const nodes = cols.get(l);
    const score = (c) => {
      const parents = edges.filter((e) => e.to === c.id && row.has(e.from)).map((e) => row.get(e.from));
      return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : Infinity;
    };
    nodes.sort((a, b) => score(a) - score(b) || a.createdAt - b.createdAt);
    nodes.forEach((c, i) => row.set(c.id, i));
  }
  // A layer with many parts becomes several side-by-side columns instead of one very tall one.
  const MAX_PER_COL = 6;
  const gapX = edges.length > comps.length / 3 ? NODE.gapX : TIGHT_GAP;
  const physical = [];
  for (const l of layers) {
    const nodes = cols.get(l);
    for (let i = 0; i < nodes.length; i += MAX_PER_COL) physical.push(nodes.slice(i, i + MAX_PER_COL));
  }
  const tallest = Math.max(1, ...physical.map((c) => c.length));
  const H = NODE.pad * 2 + tallest * NODE.h + (tallest - 1) * NODE.gapY;
  const pos = new Map();
  physical.forEach((nodes, ci) => {
    const colH = nodes.length * NODE.h + (nodes.length - 1) * NODE.gapY;
    const top = (H - colH) / 2;
    nodes.forEach((c, i) => pos.set(c.id, { x: NODE.pad + ci * gapX, y: top + i * (NODE.h + NODE.gapY), w: NODE.w, h: NODE.h }));
  });
  const W = NODE.pad * 2 + Math.max(1, physical.length) * gapX - (gapX - NODE.w);
  return { pos, edges, W, H };
}

function diagram(target, onPick, picked) {
  const comps = list('component', (c) => c.targetId === target.id);
  const rels = list('relation', (r) => r.targetId === target.id);
  const wrap = h('div.arch-scroll');
  if (!comps.length) {
    wrap.append(h('div.empty', h('span.hand', 'Nothing mapped yet'),
      'In the mapping phase, agents add every contract, actor and external dependency here, and draw how they connect.'));
    return wrap;
  }
  const { pos, edges, W, H } = layout(comps, rels);
  const canvas = h('div.arch-canvas', { style: { width: `${W}px`, height: `${H}px` } });
  const svg = svgEl('svg', { class: 'arch-edges', width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  const labels = h('div.arch-labels');
  const edgeEls = [];
  // fan out multiple edges between the same pair of columns
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    const meta = RELATION[e.type] || RELATION.other;
    const forward = b.x > a.x;
    const x1 = forward ? a.x + a.w : a.x + a.w / 2;
    const y1 = forward ? a.y + a.h / 2 : a.y + (b.y > a.y ? a.h : 0);
    const x2 = forward ? b.x - 4 : b.x + b.w / 2;
    const y2 = forward ? b.y + b.h / 2 : b.y + (b.y > a.y ? -4 : b.h + 4);
    const ar = arrow(x1, y1, x2, y2, { seed: hash(e.id), curve: forward ? 0.08 : 0.35 });
    const g = svgEl('g', { class: 'arch-edge', 'data-from': e.from, 'data-to': e.to, style: `--c:${meta.color}` });
    g.append(svgEl('path', { d: ar.body }), svgEl('path', { d: ar.head }));
    svg.append(g);
    edgeEls.push(g);
    const text = e.label ? `${meta.label} · ${truncate(e.label, 18)}` : meta.label;
    // in the gap just before the target, where it cannot sit on another node
    const t = forward ? Math.max(0.5, 1 - 85 / Math.max(1, x2 - x1)) : 0.5;
    const lab = h('button.arch-label', {
      style: { left: `${x1 + (x2 - x1) * t}px`, top: `${y1 + (y2 - y1) * t}px`, '--c': meta.color },
      'data-from': e.from, 'data-to': e.to, title: text,
      on: { click: () => onPick(e.id) },
    }, text);
    labels.append(lab);
  }
  // Labels that land on top of each other (edges converging on one part) are nudged apart.
  const placed = [...labels.children].map((el) => ({ el, x: parseFloat(el.style.left), y: parseFloat(el.style.top) })).sort((a, b) => a.y - b.y);
  for (let i = 0; i < placed.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = placed[j];
      const b = placed[i];
      if (Math.abs(a.x - b.x) < 150 && Math.abs(a.y - b.y) < 20) b.y = a.y + 20;
    }
    placed[i].el.style.top = `${placed[i].y}px`;
  }
  canvas.append(svg, labels);
  for (const c of comps) {
    const p = pos.get(c.id);
    const t = COMPONENT_TYPE[c.type] || COMPONENT_TYPE.other;
    const node = h('button.arch-node', {
      style: { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px`, '--c': c.type === 'actor' || c.type === 'external' ? 'var(--muted)' : REVIEW[c.reviewState].color },
      'data-type': c.type, 'data-id': c.id, 'data-picked': String(picked === c.id), 'data-ver': c.verification,
      on: { click: () => onPick(c.id) },
    });
    const sk = svgEl('svg', { class: 'sketch', viewBox: `0 0 ${p.w} ${p.h}`, width: p.w, height: p.h });
    sk.append(svgEl('path', { d: rect(p.w, p.h, { seed: hash(c.id), rough: 1 }) }));
    node.append(sk,
      h('span.arch-top', icon(t.icon), h('span', t.label), c.type !== 'actor' && c.type !== 'external' ? h('span.state-dot', { title: REVIEW[c.reviewState].label }) : null),
      h('span.arch-name', c.name),
      h('span.arch-sum', c.summary || (c.type === 'actor' || c.type === 'external' ? '' : 'no summary yet')));
    node.addEventListener('pointerenter', () => highlight(canvas, c.id, true));
    node.addEventListener('pointerleave', () => highlight(canvas, c.id, false));
    canvas.append(node);
  }
  wrap.append(canvas);
  void edgeEls;
  return wrap;
}

function highlight(canvas, id, on) {
  canvas.classList.toggle('focusing', on);
  for (const el of canvas.querySelectorAll('[data-from], [data-to]')) {
    const hit = el.dataset.from === id || el.dataset.to === id;
    el.classList.toggle('hot', on && hit);
  }
  for (const n of canvas.querySelectorAll('.arch-node')) {
    const linked = [...canvas.querySelectorAll('.arch-edge')].some((g) => (g.dataset.from === id && g.dataset.to === n.dataset.id) || (g.dataset.to === id && g.dataset.from === n.dataset.id));
    n.classList.toggle('hot', on && (n.dataset.id === id || linked));
  }
}

function assumptionCard(a) {
  return h('div.asm-card', { 'data-ver': a.verification, 'data-state': a.state, on: { click: (e) => { if (!e.target.closest('button')) bus.open(a.id); } } },
    h('div.asm-top', h('span.chip', CATEGORY[a.category] || 'other'),
      a.state !== 'assumed' ? h('span.chip', { style: { color: a.state === 'verified' ? 'var(--ok)' : 'var(--bad)' } }, a.state === 'verified' ? 'holds' : 'broken') : null,
      a.verification === 'disputed' ? h('span.chip', { style: { color: 'var(--bad)' } }, 'disputed') : null,
      h('span.right', authorAvatar(a.createdBy))),
    h('div.asm-text', a.text),
    a.rationale ? h('div.asm-why', a.rationale) : null,
    h('div.asm-actions',
      h('button.btn.btn-xs', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: a, action: 'challenge' }) } }, icon('challenge'), 'Challenge')));
}

async function sidePanel(target, el) {
  const asms = list('assumption', (a) => a.targetId === target.id);
  const dev = asms.filter((a) => a.origin === 'developer');
  const agent = asms.filter((a) => a.origin !== 'developer');
  const pb = await loadPlaybook(target.protocolType);
  const recorded = new Set(dev.map((a) => a.text.toLowerCase()));
  const prompts = (pb?.commonAssumptions || []).filter((p) => !recorded.has(p.text.toLowerCase()));
  setChildren(el,
    h('div.side-head', h('h3', 'What the developers assume'),
      h('button.btn.btn-xs', { on: { click: () => bus.newItem('assumption', { targetId: target.id, origin: 'developer' }) } }, icon('plus'), 'Add')),
    h('p.side-sub', 'Trust model, invariants, expected inputs and dependencies. Bugs live where these turn out to be false, so this comes before the hunt.'),
    dev.length ? h('div.asm-list', ...dev.map(assumptionCard)) : h('div.prose.muted', { style: { fontSize: '12.5px', margin: '0 0 8px' } }, (target.phase || 'mapping') === 'mapping' ? 'Recorded in phase 2, once the map is done.' : 'None recorded yet.'),
    prompts.length ? h('div',
      h('div.group-label', icon('book'), `Common for ${pb.name.toLowerCase()}`),
      ...prompts.map((p) => h('div.asm-prompt', h('span.chip', p.category), h('span', p.text),
        h('button.tool.sm', {
          'aria-label': 'Record', 'data-tip': 'This code makes this assumption: record it',
          on: {
            click: async () => {
              try { await write.create('assumption', { text: p.text, targetId: target.id, origin: 'developer', category: p.category }); } catch (err) { toast(err.message, 'error'); }
            },
          },
        }, icon('plus'))))) : null,
    agent.length ? h('div', h('div.group-label', icon('agent'), 'What agents are taking for granted'), h('div.asm-list', ...agent.map(assumptionCard))) : null);
}

export function createArchitecture() {
  const picked = new Map(); // targetId -> item id shown in the side panel
  const detailFor = new Map();

  function render(inner) {
    const targets = list('target');
    let head = inner.querySelector(':scope > [data-sec="head"]');
    if (!head) { head = h('div', { dataset: { sec: 'head' } }); inner.append(head); }
    setChildren(head, h('div.board-head',
      h('div', h('h1', icon('graph'), 'Architecture'),
        h('p', 'How the system fits together: who the actors are, what the code calls, what it depends on, and what its developers assume. Agents map this first, before hunting.')),
      h('div.board-actions',
        h('button.btn', { on: { click: () => addRelation(targets[0]) } }, icon('link'), 'Add connection'),
        h('button.btn.btn-primary', { on: { click: () => bus.newItem('component', { targetId: targets[0]?.id }) } }, icon('plus'), 'Add part'))));
    let body = inner.querySelector(':scope > [data-sec="arch"]');
    if (!body) { body = h('div', { dataset: { sec: 'arch' } }); inner.append(body); }
    if (!targets.length) { setChildren(body, h('div.empty', h('span.hand', 'No targets yet'), 'Add a target and its architecture appears here.')); return; }
    if (body.querySelector(':scope > .empty')) body.replaceChildren();
    keyed(body, targets, (t) => t.id, (t) => {
      const el = h('div.arch-block', h('div.arch-head'), h('div.arch-gaps'), h('div.arch-grid', h('div.arch-main'), h('div.arch-side')));
      el.dataset.target = t.id;
      return el;
    }, (el, t) => {
      const comps = list('component', (c) => c.targetId === t.id);
      const rels = list('relation', (r) => r.targetId === t.id);
      const asms = list('assumption', (a) => a.targetId === t.id);
      setChildren(el.querySelector('.arch-head'),
        h('h2', t.name), h('span.pill', t.protocolType),
        h('span.meta', `${comps.filter((c) => c.type !== 'actor' && c.type !== 'external').length} parts · ${comps.filter((c) => c.type === 'actor').length} actors · ${comps.filter((c) => c.type === 'external').length} external · ${rels.length} connections`),
        phaseStepper(t));
      // parts with no connection: the diagram cannot say what they talk to
      const linked = new Set(rels.flatMap((r) => [r.from, r.to]));
      const loose = comps.filter((c) => !linked.has(c.id));
      const gaps = el.querySelector('.arch-gaps');
      if (!loose.length) gaps.replaceChildren();
      else {
        setChildren(gaps, h('div.gap-banner',
          h('div', h('b', `${loose.length} of ${comps.length} parts are not connected to anything yet`), h('div.gap-names', loose.slice(0, 12).map((c) => c.name).join(', '), loose.length > 12 ? ', ...' : ''),
            h('div.gap-why', rels.length ? 'Until they are, the map cannot show what they call or what can reach them.' : 'No connections at all: an agent can draw most of them straight from the source with recon scan.')),
          h('div.gap-acts',
            h('button.btn.btn-sm.btn-primary', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: t, action: 'cover', to: ['all'], text: `Map how these connect to the rest of ${t.name} (run recon scan on the source first, then recon map for what it cannot see): ${loose.map((c) => c.name).join(', ')}` }) } }, icon('send'), 'Ask an agent to map these'),
            h('button.btn.btn-sm', { on: { click: () => addRelation(t) } }, icon('link'), 'Add connection'))));
      }
      const pick = picked.get(t.id);
      const mapSig = `${comps.map((c) => `${c.id}:${c.updatedAt}`).join()}|${rels.map((r) => `${r.id}:${r.updatedAt}`).join()}|${pick}|${document.documentElement.dataset.theme}`;
      const main = el.querySelector('.arch-main');
      if (main.dataset.sig !== mapSig) {
        main.dataset.sig = mapSig;
        const keepScroll = main.querySelector('.arch-scroll')?.scrollLeft || 0;
        setChildren(main, diagram(t, (id) => { picked.set(t.id, picked.get(t.id) === id ? null : id); render(inner); }, pick), legend());
        const sc = main.querySelector('.arch-scroll');
        if (sc) {
          sc.scrollLeft = keepScroll;
          const canvas = sc.querySelector('.arch-canvas');
          requestAnimationFrame(() => {
            const fit = Math.min(1, Math.max(0.45, (sc.clientWidth - 8) / canvas.offsetWidth));
            canvas.style.zoom = fit < 1 ? String(fit) : '';
          });
        }
      }
      const side = el.querySelector('.arch-side');
      const item = pick ? byId(pick) : null;
      if (item) {
        let d = detailFor.get(t.id);
        if (!d || d.item.id !== item.id) {
          d = createDetail(item, { onClose: () => { picked.set(t.id, null); detailFor.delete(t.id); render(inner); } });
          detailFor.set(t.id, d);
          setChildren(side, d.el);
        } else d.update(item);
      } else {
        detailFor.delete(t.id);
        const sig = `${asms.map((a) => `${a.id}:${a.updatedAt}`).join()}|${t.protocolType}|${t.phase}`;
        if (side.dataset.sig !== sig || side.querySelector('.detail')) { side.dataset.sig = sig; sidePanel(t, side); }
      }
    });
  }

  return { render, pick(targetId, id) { picked.set(targetId, id); } };
}

function legend() {
  const used = new Set(list('relation').map((r) => r.type));
  return h('div.arch-legend',
    ...Object.entries(RELATION).filter(([k]) => used.has(k)).map(([k, m]) => h('span', { style: { '--c': m.color } }, h('i'), m.label)),
    h('span.sep'),
    h('span', icon('user'), 'actor'), h('span', icon('globe'), 'external'),
    h('span', h('b.dot', { style: { background: 'var(--st-untouched)' } }), 'review state'));
}

export function addRelation(target) {
  if (!target) { toast('Add a target first.', 'error'); return; }
  const comps = list('component', (c) => c.targetId === target.id);
  if (comps.length < 2) { toast('Add at least two parts first.', 'error'); return; }
  const opts = () => comps.map((c) => h('option', { value: c.id }, c.name));
  const from = h('select.select', ...opts());
  const to = h('select.select', ...opts());
  if (comps[1]) to.value = comps[1].id;
  const type = h('select.select', ...Object.entries(RELATION).map(([k, m]) => h('option', { value: k }, m.label)));
  const label = h('input.input', { placeholder: 'e.g. transferFrom user, onlyOwner (optional)' });
  const m = modal([
    h('h2', 'Add a connection'),
    h('p.lead', 'How one part of the system reaches another.'),
    h('div.row-fields', h('div.field', h('label', 'From'), from), h('div.field', h('label', 'To'), to)),
    h('div.row-fields', h('div.field', h('label', 'How'), type), h('div.field', h('label', 'Detail'), label)),
    h('div.modal-actions', h('button.btn', { on: { click: () => m.close() } }, 'Cancel'),
      h('button.btn.btn-primary', {
        on: {
          click: async () => {
            try {
              await write.create('relation', { targetId: target.id, from: from.value, to: to.value, type: type.value, label: label.value.trim() });
              m.close();
            } catch (err) { toast(err.message, 'error'); }
          },
        },
      }, icon('link'), 'Add')),
  ]);
}

