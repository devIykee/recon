// The side panel: what just happened (activity), what you asked for (steers),
// and what to do next (agent proposals + recon's suggestions).

import { h, icon, keyed, setChildren, timeEl, toast, plural } from './ui.js';
import { live, list, byId, titleOf, authorName, post, write, get, patch, healthOf, on } from './state.js';
import { STEER, STEER_STATE, ACTION_LABEL, KIND_ICON, LEAD_STATE, VALUE } from './labels.js';
import { authorAvatar, openSteerComposer } from './steer.js';
import { bus } from './bus.js';
import { prose } from './prose.js';

const TABS = [
  { id: 'next', label: 'For you', icon: 'sparkle' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'steers', label: 'Steers', icon: 'flag' },
  { id: 'threads', label: 'Threads', icon: 'compass' },
  { id: 'talk', label: 'Talk', icon: 'message' },
];

export function createSidebar(root) {
  let tab = load() || 'next';
  const tabsEl = h('div.tabs', { role: 'tablist' });
  const panels = Object.fromEntries(TABS.map((t) => [t.id, h('div.tab-panel', { role: 'tabpanel', hidden: t.id !== tab })]));
  panels.talk.classList.add('talk-panel');
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
    const cards = forYouCards();
    const unread = tab === 'talk' ? 0 : list('message', (m) => m.createdAt > talkSeen()).length;
    const counts = { activity: null, steers: list('steer', (s) => s.state !== 'addressed').length, next: cards.length + pending, threads: list('lead', (l) => l.state === 'open' || l.state === 'blocked').length, talk: unread };
    const hot = { steers: openSteers > 0, next: pending > 0 || cards.some((c) => c.hot), talk: unread > 0 };
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
        h('div', h('div.feed-line', h('b', authorName(a.by)), ' ', ...prose(a.summary)),
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
    const order = ['open', 'acknowledged', 'queued', 'waiting-on-human', 'addressed'];
    const by = { open: [], acknowledged: [], queued: [], 'waiting-on-human': [], addressed: [] };
    for (const s of all) (by[s.state] || by.open).push(s);
    by.addressed = by.addressed.slice(0, 15);
    keyed(groups, order, (g) => g, (g) => h('div', h('div.group-label'), h('div.steer-list')), (el, g) => {
      setChildren(el.querySelector('.group-label'), STEER_STATE[g].label, h('span', `· ${by[g].length}`), h('span', { style: { fontWeight: 400, textTransform: 'none', letterSpacing: 0 } }, `— ${STEER_STATE[g].hint.toLowerCase()}`));
      el.hidden = !by[g].length;
      keyed(el.querySelector('.steer-list'), by[g], (s) => s.id, () => h('div.steer'), (card, s) => {
        const prev = steerStates.get(s.id);
        if (prev && prev !== s.state) { card.classList.remove('flip'); void card.offsetWidth; card.classList.add('flip'); }
        steerStates.set(s.id, s.state);
        const dlv = live.state?.steerDeliveries?.[s.id];
        const sig = `${s.updatedAt}|${dlv?.status || ''}|${dlv?.attempt || ''}`;
        if (card._v === sig) return;
        card._v = sig;
        card.dataset.state = s.state;
        renderSteerCard(card, s, dlv);
      });
    });
    if (!all.length && !p.querySelector('.empty')) p.append(h('div.empty', h('span.hand', 'No steers yet'), 'Open any item and use Steer to point an agent at it.'));
    else if (all.length) p.querySelector('.empty')?.remove();
  }

  function renderSteerCard(card, s, dlv) {
    const meta = STEER[s.action] || STEER.note;
    const item = byId(s.itemId);
    const to = (s.to || []).includes('all') ? 'everyone' : (s.to || []).map(authorName).join(', ');
    const stage = { open: 0, queued: 1, acknowledged: 1, 'waiting-on-human': 2, addressed: 2 }[s.state] ?? 0;
    const stInfo = STEER_STATE[s.state] || STEER_STATE.open;
    const dlvTip = dlv ? `Webhook: ${dlv.status}${dlv.httpStatus ? ` (HTTP ${dlv.httpStatus})` : ''}${dlv.error ? ` - ${dlv.error}` : ''}` : '';
    setChildren(card,
      h('div.steer-top', icon(meta.icon), h('b', meta.label), h('span', `→ ${to}`),
        h('span.right', h('span.track', { style: { color: s.state === 'addressed' ? 'var(--ok)' : s.state === 'acknowledged' ? 'var(--warn)' : 'var(--st-flagged)' } },
          ...[0, 1, 2].map((i) => h(`i${i <= stage ? '.on' : ''}`))))),
      s.note ? h('div.steer-note', s.note) : null,
      item ? h('div.steer-item', { on: { click: () => bus.open(item.id) } }, icon(KIND_ICON[item.kind]), titleOf(item)) : null,
      s.waitingReason && s.state === 'waiting-on-human' ? h('div.steer-response', h('b', 'Waiting on you: '), ...prose(s.waitingReason)) : null,
      s.response ? h('div.steer-response', authorAvatar(s.addressedBy || s.lastTouchedBy), ...prose(s.response)) : null,
      h('div.steer-foot',
        h(`span.state-pill.${s.state}`, { 'data-tip': stInfo.hint }, stInfo.label),
        dlv ? h(`span.pill${dlv.status === 'failed' || dlv.status === 'retrying' ? '.pill-warn' : ''}`, { 'data-tip': dlvTip }, `webhook: ${dlv.status}`) : null,
        s.state === 'addressed'
          ? h('button.btn.btn-xs.btn-ghost', { on: { click: () => post(`/api/steers/${s.id}/reopen`).catch((e) => toast(e.message, 'error')) } }, 'Reopen')
          : h('button.btn.btn-xs.btn-ghost', { on: { click: () => write.remove('steer', s.id).catch((e) => toast(e.message, 'error')) } }, 'Withdraw'),
        h('span.t', authorName(s.createdBy), ' · ', timeEl(s.createdAt))));
  }

  // ---------- for you: proactive cards with one-click answers ----------

  let reportInfo = null;
  let reportTimer = null;
  function refreshReport() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(async () => {
      try { reportInfo = await get('/api/report'); render(); } catch { /* not critical */ }
    }, 700);
  }

  function forYouCards() {
    if (!live.state) return [];
    const cards = [];
    const rep = reportInfo;
    const cfg = live.state.project.report || {};
    if (rep && rep.included.length && !cfg.shape) {
      cards.push({
        key: 'report-shape', hot: true, icon: 'file',
        title: `${rep.included.length} finding(s) are ready to report. How should they go out?`,
        why: 'Pick once. The agent writes the report that way instead of drafting it in chat. Programs that want one bug per submission need separate reports.',
        actions: [
          { label: 'One combined document', primary: true, run: () => patch('/api/report', { shape: 'combined' }) },
          { label: 'One report per finding', run: () => patch('/api/report', { shape: 'separate' }) },
          { label: 'Open report', run: () => bus.report?.() },
        ],
      });
    }
    if (cfg.shape && rep?.stale?.length && rep?.included?.length) {
      cards.push({ key: 'report-stale', icon: 'file', title: 'Findings changed since the report was written', why: `The ${cfg.shape} report is out of date.`, actions: [{ label: 'Open report', primary: true, run: () => bus.report?.() }] });
    }
    for (const a of list('agent')) {
      const hl = healthOf(a.id);
      if (!hl.flags.includes('ignoring-steers')) continue;
      const waiting = list('steer', (s) => s.state === 'open' && ((s.to || []).includes(a.id) || (s.to || []).includes('all')));
      cards.push({
        key: `ignoring-${a.id}`, hot: true, icon: 'alert', who: a.id,
        title: `${a.name} has not acknowledged ${waiting.length} steer(s)`,
        why: `It cannot file findings or change coverage until it does. Oldest: "${(waiting[0]?.note || '').slice(0, 80)}"`,
        actions: [{ label: 'See steers', run: () => select('steers') }],
      });
    }
    for (const f of list('finding')) {
      const missing = ['attacker', 'reachability', 'bound', 'liveFunds', 'alreadyReported', 'verificationMethod'].filter((k) => !f[k]);
      if (!missing.length) continue;
      const who = f.createdBy?.startsWith('ag_') ? f.createdBy : null;
      cards.push({
        key: `card-${f.id}`, icon: 'shield', who,
        title: `"${f.title}" has no confirmation card yet`,
        why: `Missing ${missing.join(', ')}. Its ${f.severity} rating is a guess until they are answered.`,
        actions: [
          who ? { label: `Ask ${authorName(who)} to finish it`, primary: true, run: () => write.create('steer', { action: 'verify', itemId: f.id, itemKind: 'finding', to: [who], note: `Finish the confirmation card: ${missing.join(', ')}.` }) } : null,
          { label: 'Look', run: () => bus.open(f.id) },
        ].filter(Boolean),
      });
    }
    for (const hyp of list('hypothesis', (x) => x.exploitStage === 'capability' && x.status !== 'dropped')) {
      if (list('steer', (s) => s.itemId === hyp.id && s.state !== 'addressed').length) continue;
      const who = hyp.createdBy?.startsWith('ag_') ? hyp.createdBy : null;
      cards.push({
        key: `trigger-${hyp.id}`, icon: 'zap', who,
        title: `Capability without a trigger: ${hyp.text.slice(0, 90)}`,
        why: 'Not a bug yet. It becomes one if a public path makes it fire. Worth hunting?',
        actions: [
          { label: 'Yes, hunt the trigger', primary: true, run: () => write.create('steer', { action: 'cover', itemId: hyp.id, itemKind: 'hypothesis', to: who ? [who] : ['all'], note: 'Hunt the trigger: which public function, callback or forwarded calldata makes this fire?' }) },
          { label: 'No, drop it', run: () => write.update('hypothesis', hyp.id, { status: 'dropped', dropReason: 'capability without a reachable trigger' }) },
        ],
      });
    }
    return cards;
  }

  function cardEl(c) {
    return h('div.sug.foryou', { 'data-hot': String(Boolean(c.hot)) },
      h('div.sug-title', c.who ? authorAvatar(c.who) : icon(c.icon), h('span', c.title)),
      c.why ? h('div.sug-why', c.why) : null,
      h('div.sug-actions', ...c.actions.map((a) => h(`button.btn.btn-xs${a.primary ? '.btn-primary' : ''}`, {
        on: { click: async () => { try { await a.run(); } catch (err) { toast(err.message, 'error'); } } },
      }, a.label))));
  }

  function renderNext() {
    const p = panels.next;
    if (!p.firstChild) {
      p.append(h('div.panel-head', h('h3', 'For you')),
        h('div.panel-sub', 'Decisions waiting on you, agents that need a nudge, and where to look next. One click each.'),
        h('div.group-label.prop-label', icon('sparkle'), 'Agents are asking'), h('div.props-list'),
        h('div.group-label.card-label', icon('alert'), 'Needs your call'), h('div.cards-list'),
        h('div.group-label', icon('compass'), 'Suggested by recon'), h('div.sug-list'));
    }
    if (!reportInfo) refreshReport();
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
      const options = (x.options || []).filter(Boolean);
      setChildren(el,
        h('div.sug-title', authorAvatar(x.createdBy), h('span', h('b', authorName(x.createdBy)), options.length ? ' asks: ' : ' proposes: ', ...prose(x.text))),
        x.rationale ? h('div.sug-why', x.rationale) : null,
        item ? h('div.sug-why', h('span.steer-item', { on: { click: () => bus.open(item.id) } }, icon(KIND_ICON[item.kind]), titleOf(item))) : null,
        x.state === 'pending'
          ? h('div.sug-actions.options',
            ...(options.length
              ? options.map((o, i) => h(`button.btn.btn-xs${i === 0 ? '.btn-primary' : ''}`, { on: { click: () => decide(x, 'accept', o) } }, o))
              : [h('button.btn.btn-xs.btn-primary', { on: { click: () => decide(x, 'accept') } }, icon('check'), 'Yes, go')]),
            h('button.btn.btn-xs', { on: { click: () => decide(x, 'decline') } }, icon('x'), options.length ? 'None of these' : 'No'))
          : h('div.sug-actions', h(`span.state-pill.${x.state === 'accepted' ? 'addressed' : 'open'}`, x.state), x.choice ? h('span.verify-note', x.choice) : null));
    });

    const cards = forYouCards();
    p.querySelector('.card-label').hidden = !cards.length;
    keyed(p.querySelector('.cards-list'), cards, (c) => c.key, (c) => cardEl(c), (el, c) => {
      const sig = `${c.title}|${c.why}`;
      if (el._sig === sig) return;
      el._sig = sig;
      el.replaceWith(cardEl(c));
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
    if (!sug.length && !proposals.length && !cards.length && !p.querySelector('.empty')) p.append(h('div.empty', h('span.hand', 'All clear'), 'Nothing needs you right now.'));
    else if (sug.length || proposals.length || cards.length) p.querySelector('.empty')?.remove();
  }

  // ---------- threads: what is left, so nothing is forgotten ----------

  function renderThreads() {
    const p = panels.threads;
    if (!p.firstChild) {
      p.append(h('div.panel-head', h('h3', 'Open threads'),
        h('button.btn.btn-sm', { on: { click: () => bus.newItem('lead') } }, icon('plus'), 'New')),
      h('div.panel-sub', 'Work worth doing that is not done yet: blocked checks, follow-ups, "what is left if we keep hunting". Agents record these before they stop.'),
      h('div.thread-groups'));
    }
    const all = list('lead').sort((a, b) => ({ high: 0, med: 1, low: 2 }[a.value] - { high: 0, med: 1, low: 2 }[b.value]) || b.updatedAt - a.updatedAt);
    const groups = ['open', 'blocked', 'done', 'dropped'];
    keyed(p.querySelector('.thread-groups'), groups, (g) => g, (g) => h('div', h('div.group-label'), h('div.thread-list')), (el, g) => {
      const xs = all.filter((l) => l.state === g).slice(0, g === 'done' || g === 'dropped' ? 10 : 50);
      el.hidden = !xs.length;
      setChildren(el.querySelector('.group-label'), LEAD_STATE[g].label, h('span', `· ${xs.length}`));
      keyed(el.querySelector('.thread-list'), xs, (l) => l.id, () => h('div.thread'), (card, l) => {
        if (card._v === l.updatedAt) return;
        card._v = l.updatedAt;
        card.dataset.value = l.value;
        const rel = byId(l.itemId) || byId(l.componentId);
        setChildren(card,
          h('div.steer-top', h(`span.chip.value-${l.value}`, VALUE[l.value]), h('span.right', authorAvatar(l.createdBy))),
          h('div.steer-note', ...prose(l.text)),
          l.why ? h('div.sug-why', { style: { margin: '4px 0 0' } }, l.why) : null,
          l.blockedBy ? h('div.steer-response', icon('alert'), `Blocked: ${l.blockedBy}`) : null,
          l.nextStep ? h('div.steer-response', icon('arrow'), `Next: ${l.nextStep}`) : null,
          l.outcome ? h('div.steer-response', icon('check'), l.outcome) : null,
          rel ? h('div.steer-item', { on: { click: () => bus.open(rel.id) } }, icon(KIND_ICON[rel.kind]), titleOf(rel)) : null,
          h('div.steer-foot',
            l.state === 'open' || l.state === 'blocked'
              ? [h('button.btn.btn-xs', { on: { click: (e) => openSteerComposer(e.currentTarget, { item: l, action: 'cover', to: ['all'] }) } }, icon('send'), 'Steer at it'),
                h('button.btn.btn-xs.btn-ghost', { on: { click: () => write.update('lead', l.id, { state: 'done' }).catch((er) => toast(er.message, 'error')) } }, 'Done'),
                h('button.btn.btn-xs.btn-ghost', { on: { click: () => write.update('lead', l.id, { state: 'dropped' }).catch((er) => toast(er.message, 'error')) } }, 'Drop')]
              : h('button.btn.btn-xs.btn-ghost', { on: { click: () => write.update('lead', l.id, { state: 'open' }).catch((er) => toast(er.message, 'error')) } }, 'Reopen'),
            h('span.t', timeEl(l.updatedAt))));
      });
    });
    if (!all.length && !p.querySelector('.empty')) p.append(h('div.empty', h('span.hand', 'No open threads'), 'When an agent stops, it leaves what is left here.'));
    else if (all.length) p.querySelector('.empty')?.remove();
  }

  // ---------- talk: write to an agent without touching its terminal ----------

  // Where each agent was last seen working when that is not the hunt on screen.
  const away = new Map();
  on((e) => { if (e.type === 'hunt-activity' && e.activity?.by) away.set(e.activity.by, { hunt: e.hunt?.name, at: Date.now() }); });

  let talkTo = (() => { try { return localStorage.getItem('recon.talkTo') || 'all'; } catch { return 'all'; } })();

  function renderTalk() {
    const p = panels.talk;
    if (!p.firstChild) {
      const box = h('textarea.textarea.talk-input', { rows: 2, placeholder: 'Write to the agent. It answers here.' });
      const send = async () => {
        const note = box.value.trim();
        if (!note) return;
        box.disabled = true;
        try {
          await write.create('steer', { action: 'note', to: [talkTo], note });
          box.value = '';
        } catch (err) { toast(err.message, 'error'); }
        box.disabled = false;
        box.focus();
      };
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
      p.append(
        h('div.panel-head', h('h3', 'Talk')),
        h('div.talk-who'),
        h('div.talk-status'),
        h('div.talk-log'),
        h('div.talk-compose', box, h('button.btn.btn-primary.btn-sm', { on: { click: send } }, icon('send'), 'Send')),
      );
    }
    const agents = list('agent').sort((a, b) => (b.lastSeen || b.updatedAt) - (a.lastSeen || a.updatedAt));
    if (talkTo !== 'all' && !byId(talkTo)) talkTo = 'all';
    const listening = (a) => Boolean(a.waitingSince) && healthOf(a.id).status !== 'offline';
    setChildren(p.querySelector('.talk-who'),
      h(`button.filter${talkTo === 'all' ? '.on' : ''}`, { 'aria-pressed': String(talkTo === 'all'), on: { click: () => pickTalk('all') } }, 'Everyone'),
      ...agents.map((a) => h('button.filter', { 'aria-pressed': String(talkTo === a.id), on: { click: () => pickTalk(a.id) } },
        h(`span.talk-dot.${listening(a) ? 'listening' : healthOf(a.id).status}`), a.name)));

    const who = talkTo === 'all' ? null : byId(talkTo);
    const st = who ? healthOf(who.id).status : null;
    const anyListening = agents.filter(listening);
    const elsewhere = who && away.get(who.id) && Date.now() - away.get(who.id).at < 15 * 60_000 && st !== 'active' && !listening(who) ? away.get(who.id).hunt : null;
    const line = who
      ? elsewhere ? ['warn', `${who.name} is working in the hunt "${elsewhere}", not this one. It is told you wrote here on its next step and has to switch hunts to answer. To talk in its own hunt, open "${elsewhere}" (E).`]
      : listening(who) ? ['ok', `${who.name} is listening. It reads this the moment you send it.`]
        : st === 'active' ? ['info', `${who.name} is working. It sees this with its next step and answers here.`]
          : ['warn', `${who.name} is not connected right now. It sees this when it comes back. To keep an agent listening, tell it once: "when you are done, call recon_wait".`]
      : anyListening.length ? ['ok', `${anyListening.map((a) => a.name).join(', ')} ${anyListening.length === 1 ? 'is' : 'are'} listening. Everyone else sees this with their next step.`]
        : agents.length ? ['info', 'Goes to every agent. Each sees it with its next step and answers here.'] : ['warn', 'No agent has connected yet. Connect one (C) and it reads this when it starts.'];
    setChildren(p.querySelector('.talk-status'), h(`div.talk-line.${line[0]}`, line[1]));

    const mine = (by) => !who || by === who.id;
    const toMe = (s) => !who || (s.to || []).includes(who.id) || (s.to || []).includes('all');
    const entries = [
      ...list('steer', (s) => s.createdBy === 'human' && toMe(s)).flatMap((s) => [
        { at: s.createdAt, el: bubble('you', 'You', s.note, s.createdAt, h(`span.state-pill.${s.state}`, STEER_STATE[s.state]?.label || s.state), s) },
        ...(s.response ? [{ at: s.updatedAt, el: bubble('agent', authorName(s._f?.response?.by || s.lastTouchedBy), s.response, s.updatedAt, null, null, s._f?.response?.by || s.lastTouchedBy) }] : []),
      ]),
      ...list('message', (m) => mine(m.createdBy)).map((m) => ({ at: m.createdAt, el: bubble('agent', authorName(m.createdBy), m.text, m.createdAt, null, byId(m.itemId), m.createdBy) })),
      ...list('proposal', (x) => mine(x.createdBy)).map((x) => ({ at: x.createdAt, el: proposalBubble(x) })),
    ].sort((a, b) => a.at - b.at).slice(-80);
    const log = p.querySelector('.talk-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (entries.length) setChildren(log, ...entries.map((e) => e.el));
    else setChildren(log, h('div.empty', h('span.hand', 'Nothing said yet'), 'Ask a question, point an agent somewhere, or tell it what you think. You do not need its terminal.'));
    if (atBottom || !log._init) { log.scrollTop = log.scrollHeight; log._init = true; }
    try { localStorage.setItem('recon.talkSeen', String(Date.now())); } catch { /* ignore */ }
  }

  function pickTalk(id) {
    talkTo = id;
    try { localStorage.setItem('recon.talkTo', id); } catch { /* ignore */ }
    panels.talk.querySelector('.talk-log')._init = false;
    render();
    panels.talk.querySelector('.talk-input')?.focus();
  }

  function bubble(side, name, text, at, extra, item, author) {
    return h(`div.bubble.${side}`,
      h('div.bubble-head', side === 'agent' ? authorAvatar(author) : null, h('b', name), h('span.t', timeEl(at)), extra ? h('span.right', extra) : null),
      h('div.bubble-text', ...prose(text)),
      item && item.kind !== 'steer' ? h('div.steer-item', { on: { click: () => bus.open(item.id) } }, icon(KIND_ICON[item.kind]), titleOf(item)) : null);
  }

  function proposalBubble(x) {
    const options = (x.options || []).filter(Boolean);
    return h('div.bubble.agent.ask',
      h('div.bubble-head', authorAvatar(x.createdBy), h('b', authorName(x.createdBy)), h('span.t', timeEl(x.createdAt))),
      h('div.bubble-text', ...prose(x.text)),
      x.rationale ? h('div.sug-why', ...prose(x.rationale)) : null,
      x.state === 'pending'
        ? h('div.sug-actions.options', ...(options.length
          ? options.map((o, i) => h(`button.btn.btn-xs${i === 0 ? '.btn-primary' : ''}`, { on: { click: () => decide(x, 'accept', o) } }, o))
          : [h('button.btn.btn-xs.btn-primary', { on: { click: () => decide(x, 'accept') } }, icon('check'), 'Yes, go')]),
        h('button.btn.btn-xs', { on: { click: () => decide(x, 'decline') } }, icon('x'), options.length ? 'None of these' : 'No'))
        : h('div.sug-actions', h(`span.state-pill.${x.state === 'accepted' ? 'addressed' : 'open'}`, x.state), x.choice ? h('span.verify-note', x.choice) : null));
  }

  async function decide(x, verb, choice) {
    try {
      await post(`/api/proposals/${x.id}/${verb}`, choice ? { choice } : {});
      toast(verb === 'accept' ? `${authorName(x.createdBy)}: ${choice || 'go ahead'}` : 'Declined.', 'ok');
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
    if (tab === 'threads') renderThreads();
    if (tab === 'talk') renderTalk();
  }

  return { render, select, refreshReport, get tab() { return tab; }, plural };
}

function talkSeen() {
  try { return Number(localStorage.getItem('recon.talkSeen')) || 0; } catch { return 0; }
}

function load() {
  try { return localStorage.getItem('recon.tab'); } catch { return null; }
}
