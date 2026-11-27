// The detail view for any item: what it is, who said so, the evidence behind it,
// your verdict, and the steers on it. Used both when a map node expands in place
// and when a board card opens.
//
// Sections update independently so a half-typed note survives a live update
// from an agent writing to the same item.

import { h, icon, setChildren, timeEl, toast, confirmDialog, term, flash, menu } from './ui.js';
import { live, write, list, byId, titleOf, authorName, historyOf } from './state.js';
import {
  REVIEW, SEVERITY, STAGES, HYP_STATUS, ASM_STATE, CONFIDENCE, VERIFICATION, PRIORITY,
  STEER, STEERS_FOR, STEER_STATE, KIND_ICON, EVIDENCE_ICON, PROTOCOL_ICON,
} from './labels.js';
import { openSteerComposer, authorAvatar } from './steer.js';
import { bus, loadPlaybook } from './bus.js';

const TEXT_FIELD = { component: 'reasoning', assumption: 'rationale', hypothesis: 'reasoning', finding: 'notes', target: 'description' };
const TEXT_LABEL = { reasoning: 'Reasoning', rationale: 'Why it is assumed', notes: 'Notes', description: 'Description' };

export function createDetail(item, { onClose, inMap = false } = {}) {
  const el = h('div.detail');
  const head = h('div.detail-head');
  const scroll = h('div.detail-scroll');
  el.append(head, scroll);

  const secs = {
    verify: h('div.detail-sec'),
    steer: h('div.detail-sec'),
    props: h('div.detail-sec'),
    text: h('div.detail-sec'),
    evidence: h('div.detail-sec'),
    checklist: h('div.detail-sec'),
    links: h('div.detail-sec'),
    history: h('div.detail-sec'),
    danger: h('div.detail-sec'),
  };
  scroll.append(...Object.values(secs));

  // stable sub-forms that must survive re-renders
  const evForm = evidenceForm(() => current);
  let current = item;
  let lastVersion = '';
  let textEditing = false;

  function update(next) {
    if (!next) return;
    const prev = current;
    current = next;
    const v = `${next.updatedAt}|${live.state.activity.length}|${Object.keys(live.state.items.steer).length}`;
    if (v === lastVersion) return;
    lastVersion = v;
    renderHead();
    renderVerify();
    renderSteer();
    renderProps();
    if (!textEditing) renderText();
    renderEvidence(prev);
    renderChecklist();
    renderLinks();
    renderHistory();
    renderDanger();
  }

  function renderHead() {
    const it = current;
    const chips = [];
    if (it.kind === 'component') chips.push(stateLabel(REVIEW[it.reviewState]));
    if (it.kind === 'hypothesis') chips.push(stateLabel(HYP_STATUS[it.status]));
    if (it.kind === 'assumption') chips.push(stateLabel(ASM_STATE[it.state]));
    if (it.kind === 'finding') chips.push(stateLabel(SEVERITY[it.severity]), h('span.stage-chip', STAGES[it.stage]?.label));
    if (it.kind === 'target') chips.push(h('span.pill', PROTOCOL_ICON[it.protocolType] || '', ' ', it.protocolType));
    if (it.priority && it.priority !== 'normal') chips.push(h(`span.badge.prio-${it.priority}`, icon(PRIORITY[it.priority].icon), PRIORITY[it.priority].label));
    const title = h('h3.detail-title', {
      contenteditable: 'true', spellcheck: 'false',
      on: {
        keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } if (e.key === 'Escape') { e.target.textContent = titleOf(current); e.target.blur(); } },
        blur: (e) => {
          const text = e.target.textContent.trim();
          const field = titleField(current.kind);
          if (text && text !== current[field]) save({ [field]: text });
          else e.target.textContent = titleOf(current);
        },
      },
    }, titleOf(it));
    setChildren(head,
      h('div.detail-kind', icon(KIND_ICON[it.kind]), h('span.kind-name', it.kind), ...chips,
        h('span.touched', { style: { marginLeft: 'auto' } }, authorAvatar(it.lastTouchedBy), authorName(it.lastTouchedBy), ' · ', timeEl(it.updatedAt))),
      title,
      onClose ? h('button.tool.sm.detail-close', { 'aria-label': 'Close', 'data-tip': 'Close (Esc)', on: { click: onClose } }, icon('x')) : null,
    );
  }

  function renderVerify() {
    const it = current;
    if (it.kind === 'agent') { secs.verify.hidden = true; return; }
    const seg = h('div.seg', { role: 'group', 'aria-label': 'Verification' },
      ...Object.entries(VERIFICATION).map(([v, meta]) => h('button', {
        'data-v': v, 'aria-pressed': String(it.verification === v), 'data-tip': meta.hint,
        on: { click: () => save({ verification: v }) },
      }, icon(meta.icon), meta.label)));
    const who = it.createdBy && !it.createdBy.startsWith('human') ? authorName(it.createdBy) : null;
    const note = it.verification === 'disputed'
      ? `Disputed. ${who ? `${who} has been asked to revisit it.` : 'Flagged for a second look.'}`
      : it.verification === 'verified' ? 'You checked this and agree.'
        : who ? `${who} asserted this. Check the evidence below, then decide.` : 'Not checked yet.';
    setChildren(secs.verify,
      h('div.sec-label', icon('shield'), term('Your verdict', 'verification')),
      h('div.verify-row', seg, h('span.verify-note', note)));
  }

  function renderSteer() {
    const it = current;
    const actions = STEERS_FOR[it.kind] || ['note'];
    const steers = list('steer', (s) => s.itemId === it.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
    const prio = h('button.btn.btn-xs', {
      'data-tip': 'Raise or drop priority. Agents re-sort their work.',
      on: {
        click: (e) => menu(e.currentTarget, Object.entries(PRIORITY).map(([p, meta]) => ({
          text: meta.label + (it.priority === p ? '  ✓' : ''), icon: meta.icon, action: () => save({ priority: p }),
        }))),
      },
    }, icon('priority'), `Priority: ${PRIORITY[it.priority || 'normal'].label}`);
    setChildren(secs.steer,
      h('div.sec-label', icon('flag'), term('Steer', 'steer'), h('span.right', 'never interrupts the agent')),
      h('div.steer-actions',
        ...actions.map((a) => h('button.btn.btn-xs', {
          'data-tip': STEER[a].hint,
          on: { click: (e) => openSteerComposer(e.currentTarget, { item: it, action: a }) },
        }, icon(STEER[a].icon), STEER[a].label)),
        it.kind !== 'agent' ? prio : null),
      steers.length ? h('div', { style: { marginTop: '10px' } }, ...steers.map((s) => steerMini(s))) : null);
  }

  function renderProps() {
    const it = current;
    const rows = propsFor(it, save);
    secs.props.hidden = !rows.length;
    setChildren(secs.props, h('div.sec-label', icon('list'), 'Details'), h('div.props', ...rows.flat()));
  }

  function renderText() {
    const it = current;
    const field = TEXT_FIELD[it.kind];
    if (!field) { secs.text.hidden = true; return; }
    secs.text.hidden = false;
    const value = it[field] || '';
    const extra = it.kind === 'finding' ? 'repro' : null;
    const block = (f, label, placeholder) => {
      const val = it[f] || '';
      const view = h(`div.prose${val ? '' : '.muted'}`, val || placeholder);
      const edit = h('button.btn.btn-xs.btn-ghost', { on: { click: () => startEdit(f, label, view) } }, icon('edit'), val ? 'Edit' : 'Add');
      return [h('div.sec-label', icon('note'), label, h('span.right', edit)), view];
    };
    setChildren(secs.text,
      ...block(field, TEXT_LABEL[field], field === 'reasoning' ? 'No reasoning attached yet. Unbacked claims are hard to trust.' : 'Nothing written yet.'),
      ...(extra ? [h('div', { style: { height: '12px' } }), ...block('repro', 'Reproduction', 'No reproduction yet. A finding without a repro is easy to dismiss.')] : []));
    void value;
  }

  function startEdit(field, label, view) {
    textEditing = true;
    const ta = h('textarea.textarea', { rows: 5 }, current[field] || '');
    ta.value = current[field] || '';
    const done = (saveIt) => {
      textEditing = false;
      if (saveIt && ta.value !== (current[field] || '')) save({ [field]: ta.value });
      lastVersion = '';
      update(current);
    };
    const box = h('div', ta, h('div.modal-actions', { style: { marginTop: '8px' } },
      h('button.btn.btn-sm.btn-ghost', { on: { click: () => done(false) } }, 'Cancel'),
      h('button.btn.btn-sm.btn-primary', { on: { click: () => done(true) } }, 'Save')));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    view.replaceWith(box);
    ta.focus();
    void label;
  }

  function renderEvidence(prev) {
    const it = current;
    if (it.kind === 'agent') { secs.evidence.hidden = true; return; }
    const prevIds = new Set((prev?.evidence || []).map((e) => e.id));
    const items = (it.evidence || []).slice().reverse().map((e) => {
      const row = h('div.ev', icon(EVIDENCE_ICON[e.kind] || 'note'),
        h('div', h('div.ref', e.ref || '(no reference)'), e.note ? h('div.note', e.note) : null),
        h('div.by', authorAvatar(e.by), timeEl(e.at),
          h('button.tool.sm', {
            'aria-label': 'Remove evidence', 'data-tip': 'Remove',
            style: { width: '22px', height: '22px' },
            on: { click: async () => { try { await write.removeEvidence(it.kind, it.id, e.id); } catch (err) { toast(err.message, 'error'); } } },
          }, icon('x'))));
      if (prev && prev.id === it.id && !prevIds.has(e.id)) row.classList.add('enter');
      return row;
    });
    setChildren(secs.evidence,
      h('div.sec-label', icon('code'), term('Evidence', 'evidence'), h('span.right', `${(it.evidence || []).length}`)),
      items.length ? h('div.evidence', ...items) : h('div.prose.muted', 'No evidence attached. Ask the agent for it, or add your own.'),
      evForm);
  }

  async function renderChecklist() {
    const it = current;
    if (it.kind !== 'component') { secs.checklist.hidden = true; return; }
    secs.checklist.hidden = false;
    const target = byId(it.targetId);
    const pb = await loadPlaybook(target?.protocolType || 'other');
    if (!pb || current !== it) return;
    const done = it.checklist || {};
    let checked = 0;
    let total = 0;
    const groups = pb.classes.map((cls) => {
      const rows = cls.checks.map((c) => {
        total++;
        const st = done[c.id]?.state || 'unchecked';
        if (st !== 'unchecked') checked++;
        return h('div.check', {
          'data-state': st, role: 'checkbox', 'aria-checked': String(st === 'checked'), tabindex: 0,
          title: 'Click: checked → not applicable → unchecked',
          on: { click: () => save({ checklist: { [c.id]: st === 'unchecked' ? 'checked' : st === 'checked' ? 'na' : 'unchecked' } }) },
        }, h('span.box', st === 'checked' ? icon('check') : null), h('span', c.text),
        done[c.id]?.by ? h('span.who', authorName(done[c.id].by)) : null);
      });
      const n = cls.checks.filter((c) => (done[c.id]?.state || 'unchecked') !== 'unchecked').length;
      return h('div.checklist-group', h('h6', h('span', { 'data-term': cls.name.toLowerCase(), class: 'term' }, cls.name), h('span.n', `${n}/${cls.checks.length}`)), ...rows);
    });
    setChildren(secs.checklist,
      h('div.sec-label', icon('list'), 'Checklist', h('span.right', `${checked}/${total} from the ${pb.name.toLowerCase()} playbook`)),
      ...groups);
  }

  function renderLinks() {
    const it = current;
    const rows = [];
    const link = (x, label) => x && rows.push(h('button.link-row', { on: { click: () => bus.open(x.id) } },
      icon(KIND_ICON[x.kind]), h('span.k', label || x.kind), h('span', titleOf(x))));
    if (it.targetId) link(byId(it.targetId), 'target');
    if (it.componentId) link(byId(it.componentId), 'component');
    if (it.hypothesisId) link(byId(it.hypothesisId), 'from hypothesis');
    if (it.findingId) link(byId(it.findingId), 'finding');
    if (it.kind === 'component' || it.kind === 'target') {
      const key = it.kind === 'component' ? 'componentId' : 'targetId';
      for (const k of ['hypothesis', 'finding', 'assumption']) for (const x of list(k, (y) => y[key] === it.id)) link(x);
    }
    const actions = [];
    if (it.kind === 'hypothesis' && !it.findingId && it.status !== 'dropped') {
      actions.push(h('button.btn.btn-sm', { on: { click: () => promote(it) } }, icon('bug'), 'Promote to finding'));
    }
    if (it.kind === 'component') {
      actions.push(h('button.btn.btn-sm', { on: { click: () => bus.newItem('hypothesis', { targetId: it.targetId, componentId: it.id }) } }, icon('flask'), 'Add hypothesis'));
      actions.push(h('button.btn.btn-sm', { on: { click: () => bus.newItem('assumption', { targetId: it.targetId, componentId: it.id }) } }, icon('sticky'), 'Add assumption'));
    }
    if (it.kind === 'target') {
      actions.push(h('button.btn.btn-sm', { on: { click: () => bus.newItem('component', { targetId: it.id }) } }, icon('plus'), 'Add component'));
    }
    secs.links.hidden = !rows.length && !actions.length;
    setChildren(secs.links,
      rows.length ? [h('div.sec-label', icon('link'), 'Linked'), h('div.links', ...rows)] : null,
      actions.length ? h('div.steer-actions', { style: { marginTop: rows.length ? '10px' : 0 } }, ...actions) : null);
  }

  function renderHistory() {
    const it = current;
    const items = historyOf(it.id).slice(-12).reverse();
    secs.history.hidden = !items.length;
    setChildren(secs.history,
      h('div.sec-label', icon('clock'), 'History'),
      h('div.history', ...items.map((a) => h('div.hist', authorAvatar(a.by),
        h('div', h('b', authorName(a.by)), ' ', a.summary, h('div.t', timeEl(a.at)))))));
  }

  function renderDanger() {
    const it = current;
    setChildren(secs.danger, h('div.steer-actions',
      h('button.btn.btn-xs.btn-ghost.btn-danger', {
        on: {
          click: async () => {
            const ok = await confirmDialog(`Remove this ${it.kind}?`, it.kind === 'target' ? 'Its components go with it. This cannot be undone, but an export keeps a copy.' : 'This cannot be undone.', { ok: 'Remove', danger: true });
            if (!ok) return;
            try { await write.remove(it.kind, it.id); onClose?.(); } catch (err) { toast(err.message, 'error'); }
          },
        },
      }, icon('trash'), `Remove ${it.kind}`),
      h('span.verify-note', { style: { marginLeft: 'auto' } }, `id ${it.id}`)));
  }

  async function save(fields) {
    try {
      const out = await write.update(current.kind, current.id, fields);
      if (fields.verification === 'disputed') toast('Disputed. The agent that made this claim gets a steer to revisit it.');
      return out;
    } catch (err) {
      toast(err.message, 'error');
      lastVersion = '';
      update(current);
      return null;
    }
  }

  update(item);
  void inMap;
  return {
    el,
    update(next) { update(next); },
    get item() { return current; },
    flash() { flash(el); },
  };
}

// ---------- pieces ----------

function stateLabel(meta) {
  if (!meta) return null;
  return h('span.state-label', { style: { '--c': meta.color } }, h('span.state-dot'), meta.label);
}

function titleField(kind) {
  return { finding: 'title', hypothesis: 'text', assumption: 'text', proposal: 'text', steer: 'note' }[kind] || 'name';
}

export function steerMini(s) {
  const meta = STEER[s.action] || STEER.note;
  const to = (s.to || []).includes('all') ? 'everyone' : (s.to || []).map((t) => authorName(t)).join(', ');
  return h('div.steer', { 'data-state': s.state },
    h('div.steer-top', icon(meta.icon), h('b', meta.label), '→', to,
      h('span.right', h(`span.state-pill.${s.state}`, { 'data-tip': STEER_STATE[s.state].hint }, STEER_STATE[s.state].label))),
    s.note ? h('div.steer-note', s.note) : null,
    s.response ? h('div.steer-response', icon('message'), s.response) : null);
}

function evidenceForm(getItem) {
  const ref = h('input.input.mono', { placeholder: 'file.sol:120, function, tx hash or link' });
  const note = h('input.input', { placeholder: 'What it shows (optional)' });
  const add = async () => {
    const it = getItem();
    if (!ref.value.trim() && !note.value.trim()) { ref.focus(); return; }
    try {
      await write.evidence(it.kind, it.id, { ref: ref.value.trim(), note: note.value.trim() });
      ref.value = ''; note.value = '';
    } catch (err) { toast(err.message, 'error'); }
  };
  for (const i of [ref, note]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  return h('div.ev-form', ref, h('div.row', note, h('button.btn.btn-sm', { on: { click: add } }, icon('plus'), 'Attach')));
}

function select(value, options, onChange, { labels = {} } = {}) {
  return h('select.inline', { on: { change: (e) => onChange(e.target.value) } },
    ...options.map((o) => h('option', { value: o, selected: o === value }, labels[o] || o)));
}

function input(value, onChange, { placeholder = '', type = 'text' } = {}) {
  const i = h('input.inline', { value: value ?? '', placeholder, type });
  i.addEventListener('change', () => onChange(type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value));
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
  return i;
}

function touched(it, field) {
  const f = it._f?.[field];
  if (!f) return null;
  return h('span.touched', { title: `${authorName(f.by)} · ${new Date(f.at).toLocaleString()}` }, authorAvatar(f.by));
}

function row(label, control, it, field) {
  return [h('span.k', label), h('span.v', control, field ? touched(it, field) : null)];
}

function componentOptions(targetId) {
  const comps = list('component', (c) => !targetId || c.targetId === targetId);
  return ['', ...comps.map((c) => c.id)];
}

function componentLabels() {
  const out = { '': '—' };
  for (const c of list('component')) out[c.id] = c.name;
  return out;
}

function propsFor(it, save) {
  const s = (field) => (v) => save({ [field]: v });
  const labelsOf = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : v.label]));
  switch (it.kind) {
    case 'component': {
      const agents = list('agent');
      return [
        row(h('span', { 'data-term': 'review state', class: 'term' }, 'Review state'), select(it.reviewState, Object.keys(REVIEW), s('reviewState'), { labels: labelsOf(REVIEW) }), it, 'reviewState'),
        row('Type', select(it.type, ['contract', 'function', 'module', 'endpoint', 'storage', 'config', 'other'], s('type')), it, 'type'),
        row('Location', input(it.location, s('location'), { placeholder: 'path/to/File.sol:120' }), it, 'location'),
        row('Owner', select(it.owner || '', ['', ...agents.map((a) => a.id)], s('owner'), { labels: { '': 'Nobody', ...Object.fromEntries(agents.map((a) => [a.id, a.name])) } }), it, 'owner'),
      ];
    }
    case 'assumption':
      return [
        row('State', select(it.state, Object.keys(ASM_STATE), s('state'), { labels: labelsOf(ASM_STATE) }), it, 'state'),
        row('Scope', input(it.scope, s('scope'), { placeholder: 'Where this applies' }), it, 'scope'),
        row('Component', select(it.componentId || '', componentOptions(it.targetId), s('componentId'), { labels: componentLabels() }), it, 'componentId'),
      ];
    case 'hypothesis':
      return [
        row('Status', select(it.status, Object.keys(HYP_STATUS), s('status'), { labels: labelsOf(HYP_STATUS) }), it, 'status'),
        row(h('span', { 'data-term': 'confidence', class: 'term' }, 'Confidence'), select(it.confidence, Object.keys(CONFIDENCE), s('confidence'), { labels: CONFIDENCE }), it, 'confidence'),
        row(h('span', { 'data-term': 'bug class', class: 'term' }, 'Bug class'), input(it.bugClass, s('bugClass'), { placeholder: 'e.g. reentrancy' }), it, 'bugClass'),
        row('Component', select(it.componentId || '', componentOptions(it.targetId), s('componentId'), { labels: componentLabels() }), it, 'componentId'),
        ...(it.status === 'dropped' ? [row('Why dropped', input(it.dropReason, s('dropReason'), { placeholder: 'What ruled it out' }), it, 'dropReason')] : []),
      ];
    case 'finding':
      return [
        row('Stage', select(it.stage, Object.keys(STAGES), s('stage'), { labels: labelsOf(STAGES) }), it, 'stage'),
        row(h('span', { 'data-term': 'severity', class: 'term' }, 'Severity'), select(it.severity, Object.keys(SEVERITY), s('severity'), { labels: labelsOf(SEVERITY) }), it, 'severity'),
        row('Bug class', input(it.bugClass, s('bugClass'), { placeholder: 'e.g. rounding' }), it, 'bugClass'),
        row('Bounty', input(it.bounty, s('bounty'), { type: 'number', placeholder: '0' }), it, 'bounty'),
        row('Chain', input(it.chain, s('chain'), { placeholder: 'e.g. mainnet' }), it, 'chain'),
        row('Component', select(it.componentId || '', componentOptions(it.targetId), s('componentId'), { labels: componentLabels() }), it, 'componentId'),
      ];
    case 'target':
      return [
        row('Protocol type', select(it.protocolType, ['lending', 'amm', 'perps', 'bridge', 'staking', 'nft-market', 'governance', 'oracle', 'token', 'vault', 'other'], s('protocolType')), it, 'protocolType'),
        row('Chain', input(it.chain, s('chain'), { placeholder: 'e.g. mainnet' }), it, 'chain'),
        row('Scope', input(it.scope, s('scope'), { placeholder: 'In-scope paths or contracts' }), it, 'scope'),
      ];
    case 'agent':
      return [
        row('Status', h('span', it.status), null, null),
        row('Transport', h('span', it.transport), null, null),
        row('Focus', h('span', it.focus || '—'), it, 'focus'),
      ];
    default:
      return [];
  }
}

async function promote(hyp) {
  try {
    const f = await write.create('finding', {
      title: hyp.text, targetId: hyp.targetId || undefined, componentId: hyp.componentId || undefined,
      bugClass: hyp.bugClass, severity: hyp.confidence === 'high' ? 'high' : 'medium', stage: 'testing',
      hypothesisId: hyp.id, evidence: hyp.evidence,
    });
    if (hyp.status !== 'confirmed') await write.update('hypothesis', hyp.id, { status: 'confirmed' });
    toast('Promoted to a finding.', 'ok');
    bus.open(f.id);
  } catch (err) { toast(err.message, 'error'); }
}

