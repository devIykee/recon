// The boards: each a live view of one part of the engagement.
// Cards expand in place to the shared detail view.

import { h, icon, keyed, flash, setChildren, timeEl, toast, plural, truncate, menu } from './ui.js';
import { live, list, byId, coverage, healthOf, authorName, steersFor, write, titleOf, agentIsWriting, patch } from './state.js';
import {
  REVIEW, SEVERITY, STAGES, HYP_STATUS, ASM_STATE, CONFIDENCE, PROTOCOL_ICON, TRANSPORT, STEER, PRIORITY,
} from './labels.js';
import { createDetail } from './detail.js';
import { avatar, authorAvatar, openSteerComposer, recipientPicker } from './steer.js';
import { bus, loadPlaybook } from './bus.js';
import { createArchitecture } from './architecture.js';

export function createBoards(root) {
  let current = null;
  let openId = null;
  const details = new Map(); // id -> detail api
  const filters = { coverage: 'all', findings: 'all' };
  const openPlaybooks = new Set();
  let inner = null;
  let lastView = null;
  const arch = createArchitecture();

  function mount(view) {
    if (lastView !== view) {
      root.replaceChildren();
      inner = h('div.board-inner');
      root.append(inner);
      lastView = view;
      details.clear();
      root.scrollTop = 0;
    }
    current = view;
    render();
  }

  function render() {
    if (!current || !live.state) return;
    switch (current) {
      case 'architecture': arch.render(inner); break;
      case 'coverage': renderCoverage(); break;
      case 'assumptions': renderColumns('assumption', 'state', ASM_STATE, assumptionsHead()); break;
      case 'hypotheses': renderColumns('hypothesis', 'status', HYP_STATUS, hypothesesHead()); break;
      case 'findings': renderFindings(); break;
      case 'agents': renderAgents(); break;
      default:
    }
  }

  // ---------- shared ----------

  function section(key, build) {
    let el = inner.querySelector(`:scope > [data-sec="${key}"]`);
    if (!el) { el = h('div', { dataset: { sec: key } }); inner.append(el); }
    build(el);
    return el;
  }

  function head(title, iconName, desc, actions = []) {
    return (el) => setChildren(el, h('div.board-head',
      h('div', h('h1', icon(iconName), title), h('p', desc)),
      h('div.board-actions', ...actions)));
  }

  function toggleOpen(id) {
    openId = openId === id ? null : id;
    render();
    if (openId) requestAnimationFrame(() => root.querySelector(`[data-key="${openId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  // A card that expands in place. `main(item)` returns the collapsed content.
  function cardKeyed(container, items, main, { cls = 'card', draggable = false } = {}) {
    keyed(container, items, (it) => it.id, (it) => {
      const el = h(`div.${cls}`, { tabindex: 0 });
      el.addEventListener('click', (e) => {
        if (e.target.closest('.detail, button, a, select, input, textarea')) return;
        toggleOpen(it.id);
      });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === el) toggleOpen(it.id); });
      if (draggable) {
        el.draggable = true;
        el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/recon-id', it.id); el.classList.add('dragging'); });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
      }
      return el;
    }, (el, it, fresh) => {
      const isOpen = openId === it.id;
      const sig = `${it.updatedAt}|${steersFor(it.id).map((s) => s.state).join()}|${isOpen}`;
      if (!fresh && el._sig === sig) return;
      const changed = !fresh && el._v && el._v !== it.updatedAt;
      el._sig = sig;
      el._v = it.updatedAt;
      el.dataset.ver = it.verification;
      el.classList.toggle('open', isOpen);
      if (draggable) el.draggable = !isOpen;
      if (isOpen) {
        let d = details.get(it.id);
        if (!d) {
          d = createDetail(it, { onClose: () => toggleOpen(it.id) });
          details.set(it.id, d);
          setChildren(el, d.el);
        } else {
          if (!el.contains(d.el)) setChildren(el, d.el);
          d.update(it);
        }
      } else {
        details.delete(it.id);
        setChildren(el, ...[main(it, el)].flat());
      }
      if (changed) flash(el);
    });
  }

  function steerBadge(it) {
    const s = steersFor(it.id);
    if (!s.length) return null;
    return h(`span.badge.steer${s.some((x) => x.state === 'open') ? '.open' : ''}`, { 'data-tip': `${plural(s.length, 'steer')} on this` }, icon('flag'), s.length);
  }

  function verBadge(it) {
    if (it.verification === 'verified') return h('span.badge.ver-verified', { 'data-tip': 'You verified this' }, icon('check'));
    if (it.verification === 'disputed') return h('span.badge.ver-disputed', { 'data-tip': 'You disputed this' }, icon('x'));
    return null;
  }

  function prioBadge(it) {
    if (it.priority !== 'high' && it.priority !== 'urgent') return null;
    return h(`span.badge.prio-${it.priority}`, icon(PRIORITY[it.priority].icon), PRIORITY[it.priority].label);
  }

  function foot(it, extra = []) {
    return h('div.card-foot', authorAvatar(it.lastTouchedBy), h('span', authorName(it.lastTouchedBy)), timeEl(it.updatedAt),
      h('span.right', ...extra, (it.evidence || []).length ? h('span.mini', { 'data-tip': 'Evidence attached' }, icon('code'), it.evidence.length) : h('span', { style: { color: 'var(--faint)' } }, 'no evidence')));
  }

  // ---------- coverage ----------

  function renderCoverage() {
    const targets = list('target');
    const cov = coverage();
    section('head', head('Coverage', 'coverage',
      'The attack surface, piece by piece. Hatched tiles are parts nobody has looked at yet. That is where to point an agent.',
      [h('button.btn', { on: { click: () => bus.newItem('target') } }, icon('target'), 'Add target'),
        h('button.btn.btn-primary', { on: { click: () => bus.newItem('component', { targetId: targets[0]?.id }) } }, icon('plus'), 'Add component')]));
    section('filters', (el) => setChildren(el, h('div.filters',
      h('button.filter', { 'aria-pressed': String(filters.coverage === 'all'), on: { click: () => { filters.coverage = 'all'; render(); } } }, `All · ${cov.total}`),
      ...Object.entries(REVIEW).map(([k, m]) => h('button.filter', {
        'aria-pressed': String(filters.coverage === k), style: { '--c': m.color }, 'data-tip': m.hint,
        on: { click: () => { filters.coverage = filters.coverage === k ? 'all' : k; render(); } },
      }, h('span.sw'), `${m.label} · ${cov.counts[k]}`)))));

    const wrap = section('targets', (el) => {
      if (!targets.length) setChildren(el, h('div.empty', h('span.hand', 'No targets yet'), 'Add a target to map its attack surface.'));
    });
    if (!targets.length) return;
    if (wrap.querySelector('.empty')) wrap.replaceChildren();
    keyed(wrap, targets, (t) => t.id, (t) => {
      const el = h('div.target-block');
      el.append(h('div.target-head'), h('div.cov-bar'), h('div.playbook'), h('div.tiles'));
      el.querySelector('.playbook').addEventListener('click', (e) => {
        if (!e.target.closest('.playbook-head')) return;
        if (openPlaybooks.has(t.id)) openPlaybooks.delete(t.id); else openPlaybooks.add(t.id);
        el.querySelector('.playbook').classList.toggle('open', openPlaybooks.has(t.id));
      });
      return el;
    }, (el, t) => {
      const c = coverage(t.id);
      setChildren(el.querySelector('.target-head'),
        h('h2', `${PROTOCOL_ICON[t.protocolType] || ''} ${t.name}`),
        h('div.meta', h('span.pill', t.protocolType), t.chain ? h('span', t.chain) : null, h('span', `${c.pct}% covered · ${plural(c.total, 'part')}`), steerBadge(t), verBadge(t), prioBadge(t)),
        h('div.right',
          h('button.btn.btn-sm', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: t, action: 'cover' }) } }, icon('cover'), 'Steer'),
          h('button.btn.btn-sm', { on: { click: () => bus.open(t.id) } }, icon('eye'), 'Details')));
      setChildren(el.querySelector('.cov-bar'), ...['flagged', 'reviewed', 'scanning', 'untouched'].map((s) => h('span', {
        style: { flexGrow: c.counts[s], background: REVIEW[s].color, opacity: s === 'untouched' ? 0.35 : 1 }, 'data-tip': `${REVIEW[s].label}: ${c.counts[s]}`,
      })));
      renderPlaybook(el.querySelector('.playbook'), t);
      const comps = list('component', (x) => x.targetId === t.id && x.type !== 'actor' && x.type !== 'external' && (filters.coverage === 'all' || x.reviewState === filters.coverage));
      const tiles = el.querySelector('.tiles');
      cardKeyed(tiles, comps, (x, tile) => {
        tile.dataset.state = x.reviewState;
        tile.style.removeProperty('--c');
        const checks = Object.values(x.checklist || {}).filter((y) => y.state !== 'unchecked').length;
        const focused = list('agent').filter((a) => a.focusItem === x.id);
        return [
          h('div.tile-top', h('span.kind', x.type), h('span.right', ...focused.map((a) => avatar(a, 'xs')), steerBadge(x), verBadge(x), prioBadge(x))),
          h('div.tile-name', x.name),
          h('div.tile-foot', h('span.state-label', h('span.state-dot'), REVIEW[x.reviewState].label),
            h('span', `${(x.evidence || []).length} evidence`), h('span', `${checks} checks`),
            x.owner ? h('span', { style: { marginLeft: 'auto' } }, authorAvatar(x.owner)) : null),
        ];
      }, { cls: 'tile' });
      for (const tile of tiles.children) {
        const it = byId(tile.dataset.key);
        if (it) tile.dataset.state = it.reviewState;
      }
      if (!comps.length && !tiles.querySelector('.empty')) tiles.append(h('div.empty', filters.coverage === 'all' ? 'No components yet.' : `Nothing ${filters.coverage}.`));
      else if (comps.length) tiles.querySelector('.empty')?.remove();
    });
  }

  async function renderPlaybook(el, t) {
    const pb = await loadPlaybook(t.protocolType);
    if (!pb) return;
    const comps = list('component', (x) => x.targetId === t.id);
    const sig = `${pb.type}|${comps.map((c) => Object.keys(c.checklist || {}).length).join()}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.classList.toggle('open', openPlaybooks.has(t.id));
    const doneFor = (cls) => comps.reduce((n, c) => n + cls.checks.filter((k) => (c.checklist?.[k.id]?.state || 'unchecked') !== 'unchecked').length, 0);
    setChildren(el,
      h('div.playbook-head', icon('book'), h('h4', `${pb.name} playbook`), h('span.sub', `${pb.classes.length} usual suspects`), h('span.chev', icon('chevron'))),
      h('div.playbook-body',
        h('p.prose.muted', { style: { margin: '0 0 10px' } }, pb.summary),
        h('div.start', h('b', 'Start here: '), pb.startHere),
        h('div.classes', ...pb.classes.map((cls) => h('div.cls',
          h('h5', cls.name, h('span.n', { 'data-tip': 'Checklist items done across this target' }, `${doneFor(cls)} checks`)),
          h('p', cls.plain),
          h('details', h('summary', 'Go deeper'), h('p', cls.deeper), h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, ...cls.checks.map((c) => h('li', c.text)))))))));
  }

  // ---------- columns (assumptions, hypotheses) ----------

  function assumptionsHead() {
    return head('Assumptions', 'sticky',
      'What is being taken for granted. Every bug hides behind an assumption that turned out wrong, so challenge the ones that matter.',
      [h('button.btn.btn-primary', { on: { click: () => bus.newItem('assumption') } }, icon('plus'), 'Add assumption')]);
  }

  function hypothesesHead() {
    return head('Hypotheses', 'flask',
      'Suspected bugs in flight. Each one gets tested until it is confirmed (then promoted to a finding) or dropped with a reason.',
      [h('button.btn.btn-primary', { on: { click: () => bus.newItem('hypothesis') } }, icon('plus'), 'Add hypothesis')]);
  }

  function renderColumns(kind, field, states, headFn) {
    section('head', headFn);
    const cols = section('columns', (el) => { if (!el.firstChild) el.append(h('div.columns')); });
    const columns = cols.firstChild;
    keyed(columns, Object.keys(states), (s) => s, (s) => {
      const col = h('div.column', h('div.column-head'), h('div.column-hint'), h('div.column-list'));
      col.dataset.state = s;
      return col;
    }, (col, s) => {
      const items = list(kind, (x) => x[field] === s).sort((a, b) => rankPrio(b) - rankPrio(a) || b.updatedAt - a.updatedAt);
      setChildren(col.querySelector('.column-head'), h('span.sw', { style: { '--c': states[s].color } }), h('h3', states[s].label), h('span.n', items.length));
      col.querySelector('.column-hint').textContent = states[s].hint;
      cardKeyed(col.querySelector('.column-list'), items, (it, el) => {
        if (kind === 'assumption') {
          el.classList.add('sticky-card');
          return h('div.card-main',
            h('div.card-top', h(`span.chip.origin-${it.origin || 'agent'}`, it.origin === 'developer' ? 'developers assume' : 'agent assumes'),
              it.category && it.category !== 'other' ? h('span.chip', it.category) : null, h('span.right', steerBadge(it), verBadge(it), prioBadge(it))),
            h('div.card-title.hand', it.text),
            it.rationale ? h('div.card-sub', it.rationale) : null,
            foot(it, [h('button.btn.btn-xs', { 'data-tip': STEER.challenge.hint, on: { click: (e) => openSteerComposer(e.currentTarget, { item: it, action: 'challenge' }) } }, icon('challenge'), 'Challenge')]));
        }
        const comp = byId(it.componentId);
        return [h('div.card-stripe', { style: { background: states[s].color } }), h('div.card-main',
          h('div.card-top', h('span.conf', { 'data-c': it.confidence, style: { '--c': states[s].color } }, h('i'), h('i'), h('i')),
            h('span', `${CONFIDENCE[it.confidence]} confidence`), it.bugClass ? h('span.chip', it.bugClass) : null,
            h('span.right', steerBadge(it), verBadge(it), prioBadge(it))),
          h('div.card-title', it.text),
          comp ? h('div.card-sub', `in ${comp.name}`) : null,
          it.status === 'dropped' && it.dropReason ? h('div.card-sub', `Dropped: ${it.dropReason}`) : null,
          foot(it, it.findingId ? [h('span.chip', { style: { color: 'var(--sev-high)' } }, 'finding')] : []))];
      });
      if (!items.length && !col.querySelector('.empty')) col.querySelector('.column-list').append(h('div.empty', 'Nothing here.'));
      else if (items.length) col.querySelector('.column-list .empty')?.remove();
    });
  }

  // ---------- findings pipeline ----------

  function renderFindings() {
    const all = list('finding');
    const bounty = all.reduce((n, f) => n + (Number(f.bounty) || 0), 0);
    section('head', head('Findings', 'bug',
      'Confirmed bugs on their way from recon to responsible disclosure. Drag a card to move it along.',
      [bounty ? h('span.pill', `$${bounty.toLocaleString()} in bounties`) : null,
        h('button.btn.btn-primary', { on: { click: () => bus.newItem('finding') } }, icon('plus'), 'Add finding')]));
    section('filters', (el) => setChildren(el, h('div.filters',
      h('button.filter', { 'aria-pressed': String(filters.findings === 'all'), on: { click: () => { filters.findings = 'all'; render(); } } }, `All · ${all.length}`),
      ...Object.entries(SEVERITY).map(([k, m]) => h('button.filter', {
        'aria-pressed': String(filters.findings === k), style: { '--c': m.color },
        on: { click: () => { filters.findings = filters.findings === k ? 'all' : k; render(); } },
      }, h('span.sw'), `${m.label} · ${all.filter((f) => f.severity === k).length}`)))));
    const cols = section('columns', (el) => { if (!el.firstChild) el.append(h('div.columns.pipeline')); });
    const columns = cols.firstChild;
    keyed(columns, Object.keys(STAGES), (s) => s, (s) => {
      const col = h('div.column', h('div.column-head'), h('div.column-hint'), h('div.column-list'));
      col.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/recon-id')) { e.preventDefault(); col.classList.add('drop'); } });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const id = e.dataTransfer.getData('text/recon-id');
        const f = byId(id);
        if (!f || f.stage === s) return;
        try { await write.update('finding', id, { stage: s }); } catch (err) { toast(err.message, 'error'); }
      });
      return col;
    }, (col, s) => {
      const items = list('finding', (f) => f.stage === s && (filters.findings === 'all' || f.severity === filters.findings))
        .sort((a, b) => sevRank(a) - sevRank(b) || b.updatedAt - a.updatedAt);
      const sum = items.reduce((n, f) => n + (Number(f.bounty) || 0), 0);
      setChildren(col.querySelector('.column-head'), h('h3', STAGES[s].label), h('span.n', items.length), sum ? h('span.sum', `$${sum.toLocaleString()}`) : null);
      col.querySelector('.column-hint').textContent = STAGES[s].hint;
      cardKeyed(col.querySelector('.column-list'), items, (f) => [
        h('div.card-stripe', { style: { background: SEVERITY[f.severity].color } }),
        h('div.card-main',
          h('div.card-top', h('span.sev', { style: { '--c': SEVERITY[f.severity].color } }, SEVERITY[f.severity].label), f.bugClass ? h('span.chip', f.bugClass) : null,
            h('span.right', steerBadge(f), verBadge(f))),
          h('div.card-title', f.title),
          h('div.card-sub', f.repro ? 'Reproduction attached' : 'No reproduction yet'),
          foot(f, f.bounty ? [h('span', `$${Number(f.bounty).toLocaleString()}`)] : [])),
      ], { draggable: true });
      if (!items.length && !col.querySelector('.empty')) col.querySelector('.column-list').append(h('div.empty', 'Drop a finding here'));
      else if (items.length) col.querySelector('.column-list .empty')?.remove();
    });
  }

  // ---------- agents / swarm ----------

  function renderAgents() {
    const agents = list('agent');
    const swarm = agents.length > 1;
    section('head', head(swarm ? 'Swarm' : 'Agent', 'agents',
      swarm
        ? 'Everyone working this engagement, what each is doing right now, and who owns which part of the surface. Steer one, a few, or all.'
        : 'Your agent, what it is doing right now, and how it is doing. Connect a second agent and this becomes a swarm view.',
      [h('button.btn.btn-primary', { on: { click: () => bus.connect() } }, icon('plug'), swarm ? 'Add an agent' : agents.length ? 'Connect another' : 'Connect an agent')]));

    section('swarmbar', (el) => {
      if (!swarm) { el.replaceChildren(); return; }
      if (el.firstChild) return; // keep the half-typed group steer
      const note = h('input.input', { placeholder: 'Direction for the swarm, e.g. "everyone: focus on the oracle path"' });
      const action = h('select.select', ...['note', 'cover', 'recheck', 'verify', 'challenge'].map((a) => h('option', { value: a }, STEER[a].label)));
      const rec = recipientPicker(['all']);
      const send = async () => {
        if (!note.value.trim()) { note.focus(); return; }
        try {
          await write.create('steer', { action: action.value, to: rec.value(), note: note.value.trim() });
          note.value = '';
          toast('Steer sent to the swarm.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      };
      note.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      el.append(h('div.swarm-bar', h('span.lbl', 'Steer'), rec, action, note, h('button.btn.btn-primary.btn-sm', { on: { click: send } }, icon('send'), 'Send')));
    });

    const grid = section('grid', (el) => {
      if (!el.firstChild) el.append(h('div.agents-grid'));
      if (!agents.length) setChildren(el, h('div.empty', h('span.hand', 'No agent connected yet'), 'Connect one over MCP, the CLI, HTTP, or a JSON file. It takes a minute.'));
      else if (!el.querySelector('.agents-grid')) setChildren(el, h('div.agents-grid'));
    }).querySelector('.agents-grid');
    if (grid) {
      keyed(grid, agents.sort((a, b) => statusRank(a) - statusRank(b)), (a) => a.id, () => h('div.agent-card'), (el, a) => {
        const hl = healthOf(a.id);
        const sig = `${a.updatedAt}|${hl.status}|${hl.flags}|${live.state.activity.length}`;
        if (el._sig === sig) return;
        el._sig = sig;
        el.classList.toggle('solo', !swarm);
        el.style.setProperty('--c', a.color);
        el.dataset.status = hl.status;
        renderAgentCard(el, a, hl, swarm);
      });
    }

    section('ownership', (el) => {
      if (!swarm) { el.replaceChildren(); return; }
      const comps = list('component');
      const sig = comps.map((c) => `${c.id}:${c.owner}`).join() + agents.map((a) => a.id).join();
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      setChildren(el, h('div.ownership',
        h('h3', 'Who owns what'),
        h('p.prose.muted', { style: { margin: '-4px 0 10px', fontSize: '12.5px' } }, 'An agent that owns a component is the only agent that can change its review state. Others can still attach evidence. Assign to keep agents from trampling each other.'),
        ...comps.map((c) => h('div.own-row',
          h('span', h('span.state-label', { style: { '--c': REVIEW[c.reviewState].color } }, h('span.state-dot')), ' ', c.name),
          h('span', { style: { color: 'var(--faint)' } }, byId(c.targetId)?.name || ''),
          h('select.select', {
            on: { change: async (e) => { try { await write.update('component', c.id, { owner: e.target.value }); } catch (err) { toast(err.message, 'error'); } } },
          }, h('option', { value: '', selected: !c.owner }, 'Nobody'), ...agents.map((a) => h('option', { value: a.id, selected: c.owner === a.id }, a.name)))))));
    });
  }

  function renderAgentCard(el, a, hl, swarm) {
    const focusItem = byId(a.focusItem);
    const recent = live.state.activity.filter((x) => x.by === a.id).slice(-5).reverse();
    const owned = list('component', (c) => c.owner === a.id);
    const hyps = list('hypothesis', (x) => x.createdBy === a.id);
    const finds = list('finding', (x) => x.createdBy === a.id);
    const steers = list('steer', (s) => s.state !== 'addressed' && ((s.to || []).includes(a.id) || (s.to || []).includes('all')));
    const flagInfo = {
      idle: ['soft', 'Idle', 'No activity for a bit. It may be thinking, or it may need a nudge.'],
      offline: ['soft', 'Offline', 'Has not checked in for 10+ minutes.'],
      'no-output': ['', 'Stuck?', 'Connected, but no writes for several minutes.'],
      looping: ['', 'Looping', 'Its last writes look the same. It may be stuck in a loop.'],
      noisy: ['', 'Noisy', 'Most of its hypotheses are low confidence, dropped, or disputed.'],
      disputed: ['', 'Disputed often', 'You disputed several of its claims. Worth a closer look.'],
    };
    const flags = hl.flags.map((f) => flagInfo[f]).filter(Boolean);
    setChildren(el,
      h('div.agent-head', avatar(a, 'lg'),
        h('div', h('div.agent-name', a.name),
          h('div.agent-meta', h('span.pill', { 'data-tip': 'How this agent is connected' }, TRANSPORT[a.transport] || a.transport),
            h('span', hl.status), a.model ? h('span', a.model) : null, h('span', 'seen ', timeEl(hl.lastSeen || a.updatedAt)))),
        h('div.right',
          h('button.btn.btn-sm', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: a, action: 'note' }) } }, icon('flag'), 'Steer'),
          h('button.tool.sm', {
            'aria-label': 'More', on: {
              click: (e) => menu(e.currentTarget, [
                { text: 'Show on map', icon: 'map', action: () => { bus.view('map'); setTimeout(() => bus.focusAgent?.(a.id), 50); } },
                { text: 'Assign targets…', icon: 'target', action: () => assignDialog(a) },
                '-',
                { text: 'Remove agent', icon: 'trash', danger: true, action: async () => { try { await write.remove('agent', a.id); } catch (err) { toast(err.message, 'error'); } } },
              ], { align: 'end' }),
            },
          }, icon('menu')))),
      h('div.agent-focus', icon(agentIsWriting(a.id) ? 'zap' : 'eye'),
        h('div', h('b', 'Now: '), a.focus || (hl.status === 'active' ? 'Working' : 'Nothing reported'),
          focusItem ? h('div', h('button.steer-item', { style: { border: 0, background: 'none', padding: 0 }, on: { click: () => bus.open(focusItem.id) } }, icon('arrow'), titleOf(focusItem))) : null)),
      flags.length ? h('div.flags', { style: { marginBottom: '10px' } }, ...flags.map(([cls, label, tip]) => h(`span.flag${cls ? `.${cls}` : ''}`, { 'data-tip': tip }, icon('alert'), label)))
        : h('div.flags', { style: { marginBottom: '10px' } }, h('span.flag.good', icon('check'), 'Healthy')),
      h('div.agent-stats',
        stat(hl.writes10m, 'writes, 10 min'),
        stat(owned.length, 'components owned'),
        stat(hyps.length, 'hypotheses'),
        stat(steers.length, 'steers waiting')),
      h('div.sec-label', 'Recent output'),
      recent.length ? h('div.recent', ...recent.map((r) => h('div.r', h('span.t', timeEl(r.at)), h('span', r.summary)))) : h('div.prose.muted', 'Nothing yet.'),
      swarm && (owned.length || (a.assignment || []).length) ? h('div.owns', ...owned.map((c) => h('span.chip', c.name)), ...(a.assignment || []).map((id) => byId(id)).filter(Boolean).map((x) => h('span.chip', { style: { border: '1px dashed var(--c)' } }, `assigned: ${titleOf(x)}`))) : null,
      finds.length ? h('div.prose.muted', { style: { marginTop: '8px', fontSize: '12px' } }, `${plural(finds.length, 'finding')} so far.`) : null);
  }

  async function assignDialog(a) {
    const { modal } = await import('./ui.js');
    const sel = new Set(a.assignment || []);
    const targets = list('target');
    const m = modal([
      h('h2', `Assign ${a.name}`),
      h('p.lead', 'Point this agent at targets or components. It sees them first in its briefing, and other agents see they are taken.'),
      ...targets.map((t) => h('div', { style: { marginBottom: '10px' } },
        h('label.check', { style: { fontWeight: 600 } }, h('input', { type: 'checkbox', checked: sel.has(t.id), on: { change: (e) => { if (e.target.checked) sel.add(t.id); else sel.delete(t.id); } } }), ` ${t.name}`),
        ...list('component', (c) => c.targetId === t.id).map((c) => h('label.check', { style: { paddingLeft: '24px' } },
          h('input', { type: 'checkbox', checked: sel.has(c.id), on: { change: (e) => { if (e.target.checked) sel.add(c.id); else sel.delete(c.id); } } }), ` ${c.name}`)))),
      h('div.modal-actions', h('button.btn', { on: { click: () => m.close() } }, 'Cancel'),
        h('button.btn.btn-primary', { on: { click: async () => { try { await patch(`/api/items/agent/${a.id}`, { assignment: [...sel] }); m.close(); toast('Assignment saved.', 'ok'); } catch (err) { toast(err.message, 'error'); } } } }, 'Save')),
    ]);
  }

  return {
    mount,
    render,
    open(id) {
      const it = byId(id);
      if (current === 'architecture' && it && (it.kind === 'component' || it.kind === 'relation' || it.kind === 'assumption')) {
        arch.pick(it.targetId, id);
        render();
        requestAnimationFrame(() => root.querySelector(`[data-target="${it.targetId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        return;
      }
      openId = id;
      render();
      requestAnimationFrame(() => root.querySelector(`[data-key="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    },
    get view() { return current; },
    unmount() { current = null; lastView = null; openId = null; root.replaceChildren(); details.clear(); },
  };
}

function stat(v, k) {
  return h('div.stat', h('div.v', String(v)), h('div.k', k));
}

function rankPrio(it) {
  return { low: 0, normal: 1, high: 2, urgent: 3 }[it.priority || 'normal'];
}

function sevRank(f) {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[f.severity];
}

function statusRank(a) {
  return { stuck: 0, active: 1, idle: 2, offline: 3 }[a.status] ?? 4;
}

