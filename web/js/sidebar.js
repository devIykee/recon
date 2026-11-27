// The side panel: what just happened (activity), what you asked for (steers),
// and what to do next (agent proposals + recon's suggestions).

import { h, icon, keyed, setChildren, timeEl, toast, plural } from './ui.js';
import { live, list, byId, titleOf, authorName, post, write } from './state.js';
import { STEER, STEER_STATE, ACTION_LABEL, KIND_ICON } from './labels.js';
import { authorAvatar, openSteerComposer } from './steer.js';
import { bus } from './bus.js';

const TABS = [
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'steers', label: 'Steers', icon: 'flag' },
  { id: 'next', label: 'Next', icon: 'compass' },
];

export function createSidebar(root) {
  let tab = load() || 'activity';
  const tabsEl = h('div.tabs', { role: 'tablist' });
  const panels = Object.fromEntries(TABS.map((t) => [t.id, h('div.tab-panel', { role: 'tabpanel', hidden: t.id !== tab })]));
  root.append(tabsEl, ...Object.values(panels));
  const steerStates = new Map();
  let feedFilter = 'all';

  function select(id) {
    tab = id;
    try { localStorage.setItem('recon.tab', id); } catch { /* ignore */ }
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== id;
    render();
  }

  function renderTabs() {
    const openSteers = list('steer', (s) => s.state === 'open').length;
    const pending = list('proposal', (p) => p.state === 'pending').length;
    const counts = { activity: null, steers: list('steer', (s) => s.state !== 'addressed').length, next: pending + (live.state?.suggestions.length || 0) };
    const hot = { steers: openSteers > 0, next: pending > 0 };
    setChildren(tabsEl, ...TABS.map((t) => h('button.tab', {
      role: 'tab', 'aria-selected': String(tab === t.id), on: { click: () => select(t.id) },
    }, icon(t.icon), t.label, counts[t.id] ? h(`span.n${hot[t.id] ? '.hot' : ''}`, counts[t.id]) : null)));
  }

  // ---------- activity ----------

  function renderActivity() {
    const p = panels.activity;
    if (!p.firstChild) {
      p.append(h('div.panel-head', h('h3', 'What just happened'), h('div.filters', { style: { margin: 0 } })),
        h('div.panel-sub', 'Every change, by anyone, as it happens.'), h('div.feed'));
    }
    const authors = ['all', 'human', ...list('agent').map((a) => a.id)];
    setChildren(p.querySelector('.filters'), ...authors.slice(0, 5).map((a) => h('button.filter', {
      'aria-pressed': String(feedFilter === a), style: { height: '24px', fontSize: '11px' },
      on: { click: () => { feedFilter = a; render(); } },
    }, a === 'all' ? 'All' : a === 'human' ? 'You' : authorName(a))));
    const items = live.state.activity
      .filter((a) => feedFilter === 'all' || (feedFilter === 'human' ? a.by?.startsWith('human') : a.by === feedFilter))
      .slice(-120).reverse();
    keyed(p.querySelector('.feed'), items, (a) => a.id, (a) => {
      const el = h('div.feed-item', authorAvatar(a.by),
        h('div', h('div.feed-line', h('b', authorName(a.by)), ' ', a.summary),
          h('div.feed-meta', h(`span.verb.${a.action}`, ACTION_LABEL[a.action] || a.action), a.kind && a.kind !== 'project' ? h('span', a.kind) : null, timeEl(a.at))));
      if (a.itemId) el.addEventListener('click', () => bus.open(a.itemId));
      return el;
    }, () => {});
    if (!items.length && !p.querySelector('.empty')) p.append(h('div.empty', h('span.hand', 'Quiet so far'), 'Changes from you and your agents appear here live.'));
    else if (items.length) p.querySelector('.empty')?.remove();
  }

  // ---------- steers ----------

  function renderSteers() {
    const p = panels.steers;
    if (!p.firstChild) {
      p.append(h('div.panel-head', h('h3', 'Your steers'),
        h('button.btn.btn-sm', { on: { click: (e) => openSteerComposer(e.currentTarget, { action: 'note' }) } }, icon('plus'), 'New')),
      h('div.panel-sub', 'Signals you left for agents. They never block work: agents acknowledge fast, then report back here.'),
      h('div.steer-groups'));
    }
    const groups = p.querySelector('.steer-groups');
    const all = list('steer').sort((a, b) => b.updatedAt - a.updatedAt);
    const by = { open: [], acknowledged: [], addressed: [] };
    for (const s of all) by[s.state].push(s);
    by.addressed = by.addressed.slice(0, 15);
    keyed(groups, ['open', 'acknowledged', 'addressed'], (g) => g, (g) => h('div', h('div.group-label'), h('div.steer-list')), (el, g) => {
      setChildren(el.querySelector('.group-label'), STEER_STATE[g].label, h('span', `· ${by[g].length}`), h('span', { style: { fontWeight: 400, textTransform: 'none', letterSpacing: 0 } }, `— ${STEER_STATE[g].hint.toLowerCase()}`));
      el.hidden = !by[g].length;
      keyed(el.querySelector('.steer-list'), by[g], (s) => s.id, () => h('div.steer'), (card, s) => {
        const prev = steerStates.get(s.id);
        if (prev && prev !== s.state) { card.classList.remove('flip'); void card.offsetWidth; card.classList.add('flip'); }
        steerStates.set(s.id, s.state);
        if (card._v === s.updatedAt) return;
        card._v = s.updatedAt;
        card.dataset.state = s.state;
        renderSteerCard(card, s);
      });
    });
    if (!all.length && !p.querySelector('.empty')) p.append(h('div.empty', h('span.hand', 'No steers yet'), 'Open any item and use Steer to point an agent at it.'));
    else if (all.length) p.querySelector('.empty')?.remove();
  }

  function renderSteerCard(card, s) {
    const meta = STEER[s.action] || STEER.note;
    const item = byId(s.itemId);
    const to = (s.to || []).includes('all') ? 'everyone' : (s.to || []).map(authorName).join(', ');
    const stage = ['open', 'acknowledged', 'addressed'].indexOf(s.state);
    setChildren(card,
      h('div.steer-top', icon(meta.icon), h('b', meta.label), h('span', `→ ${to}`),
        h('span.right', h('span.track', { style: { color: s.state === 'addressed' ? 'var(--ok)' : s.state === 'acknowledged' ? 'var(--warn)' : 'var(--st-flagged)' } },
          ...[0, 1, 2].map((i) => h(`i${i <= stage ? '.on' : ''}`))))),
      s.note ? h('div.steer-note', s.note) : null,
      item ? h('div.steer-item', { on: { click: () => bus.open(item.id) } }, icon(KIND_ICON[item.kind]), titleOf(item)) : null,
      s.response ? h('div.steer-response', authorAvatar(s.addressedBy || s.lastTouchedBy), s.response) : null,
      h('div.steer-foot',
        h(`span.state-pill.${s.state}`, { 'data-tip': STEER_STATE[s.state].hint }, STEER_STATE[s.state].label),
        s.state === 'addressed'
          ? h('button.btn.btn-xs.btn-ghost', { on: { click: () => post(`/api/steers/${s.id}/reopen`).catch((e) => toast(e.message, 'error')) } }, 'Reopen')
          : h('button.btn.btn-xs.btn-ghost', { on: { click: () => write.remove('steer', s.id).catch((e) => toast(e.message, 'error')) } }, 'Withdraw'),
        h('span.t', authorName(s.createdBy), ' · ', timeEl(s.createdAt))));
  }

  // ---------- next ----------

  function renderNext() {
    const p = panels.next;
    if (!p.firstChild) {
      p.append(h('div.panel-head', h('h3', 'Where to look next')),
        h('div.panel-sub', 'Proposals from your agents wait for a quick yes or no. Suggestions come from what is still untouched, unverified, or a usual suspect for this kind of protocol.'),
        h('div.group-label.prop-label', icon('sparkle'), 'Agent proposals'), h('div.props-list'),
        h('div.group-label', icon('compass'), 'Suggested by recon'), h('div.sug-list'));
    }
    const proposals = list('proposal').sort((a, b) => (a.state === 'pending' ? -1 : 1) - (b.state === 'pending' ? -1 : 1) || b.createdAt - a.createdAt).slice(0, 10);
    p.querySelector('.prop-label').hidden = !proposals.length;
    keyed(p.querySelector('.props-list'), proposals, (x) => x.id, () => {
      const el = h('div.sug.proposal', { title: 'Click to read in full' });
      el.addEventListener('click', (e) => { if (!e.target.closest('button, .steer-item')) el.classList.toggle('expanded'); });
      return el;
    }, (el, x) => {
      if (el._v === x.updatedAt) return;
      el._v = x.updatedAt;
      el.classList.toggle('decided', x.state !== 'pending');
      const item = byId(x.itemId);
      setChildren(el,
        h('div.sug-title', authorAvatar(x.createdBy), h('span', h('b', authorName(x.createdBy)), ' proposes: ', x.text)),
        x.rationale ? h('div.sug-why', x.rationale) : null,
        item ? h('div.sug-why', h('span.steer-item', { on: { click: () => bus.open(item.id) } }, icon(KIND_ICON[item.kind]), titleOf(item))) : null,
        x.state === 'pending'
          ? h('div.sug-actions',
            h('button.btn.btn-xs.btn-primary', { on: { click: () => decide(x, 'accept') } }, icon('check'), 'Yes, go'),
            h('button.btn.btn-xs', { on: { click: () => decide(x, 'decline') } }, icon('x'), 'No'))
          : h('div.sug-actions', h(`span.state-pill.${x.state === 'accepted' ? 'addressed' : 'open'}`, x.state)));
    });

    const sug = live.state.suggestions || [];
    keyed(p.querySelector('.sug-list'), sug, (s) => s.id, () => h('div.sug'), (el, s) => {
      if (el._v === s.id) return;
      el._v = s.id;
      const meta = STEER[s.action] || STEER.note;
      setChildren(el,
        h('div.sug-title', icon(meta.icon), h('span', s.title)),
        h('div.sug-why', s.why),
        h('div.sug-actions',
          h('button.btn.btn-xs.btn-primary', { 'data-tip': 'Turns this into a steer for the right agent', on: { click: () => accept(s) } }, icon('send'), `${meta.label}: send as steer`),
          s.itemId ? h('button.btn.btn-xs', { on: { click: () => bus.open(s.itemId) } }, icon('eye'), 'Look') : null,
          h('button.btn.btn-xs.btn-ghost', { on: { click: () => post(`/api/suggestions/${s.id}/dismiss`).catch((e) => toast(e.message, 'error')) } }, 'Dismiss')));
    });
    if (!sug.length && !proposals.length && !p.querySelector('.empty')) p.append(h('div.empty', h('span.hand', 'All clear'), 'Nothing obviously left. Add components or hypotheses to get new suggestions.'));
    else if (sug.length || proposals.length) p.querySelector('.empty')?.remove();
  }

  async function decide(x, verb) {
    try {
      await post(`/api/proposals/${x.id}/${verb}`);
      toast(verb === 'accept' ? `${authorName(x.createdBy)} gets the go-ahead.` : 'Declined.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function accept(s) {
    try {
      await post(`/api/suggestions/${s.id}/accept`);
      toast(`Steer sent: ${s.title}`, 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }

  function render() {
    if (!live.state) return;
    renderTabs();
    if (tab === 'activity') renderActivity();
    if (tab === 'steers') renderSteers();
    if (tab === 'next') renderNext();
  }

  return { render, select, get tab() { return tab; }, plural };
}

function load() {
  try { return localStorage.getItem('recon.tab'); } catch { return null; }
}
