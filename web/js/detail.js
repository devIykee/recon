// The detail view for any item: what it is, who said so, the evidence behind it,
// your verdict, and the steers on it. Used both when a map node expands in place
// and when a board card opens.
//
// Sections update independently so a half-typed note survives a live update
// from an agent writing to the same item.

import { h, icon, setChildren, timeEl, toast, confirmDialog, term, flash, menu } from './ui.js';
import { live, write, list, byId, titleOf, authorName, historyOf, get } from './state.js';
import {
  CARD_FIELDS, EXPLOIT_STAGE, CONFIRM_STEPS, LEAD_STATE, VALUE, GLUE,
  RELATION, PHASES, ORIGIN, CATEGORY, REVIEW, SEVERITY, STAGES, HYP_STATUS, ASM_STATE, CONFIDENCE, VERIFICATION, PRIORITY,
  STEER, STEERS_FOR, STEER_STATE, KIND_ICON, EVIDENCE_ICON, PROTOCOL_ICON,
} from './labels.js';
import { openSteerComposer, authorAvatar } from './steer.js';
import { storyFor } from './story.js';
import { prose } from './prose.js';
import { bus, loadPlaybook } from './bus.js';

const TEXT_FIELD = { component: 'reasoning', assumption: 'rationale', hypothesis: 'reasoning', finding: 'notes', target: 'description' };
const TEXT_LABEL = { reasoning: 'Reasoning', rationale: 'Why it is assumed', notes: 'Notes', description: 'Description' };

export function createDetail(item, { onClose, inMap = false } = {}) {
  const el = h('div.detail');
  const head = h('div.detail-head');
  const storyEl = h('div.story');
  const moreKey = `recon.more.${item.kind}`;
  const moreOpen = (() => { try { return localStorage.getItem(moreKey) === '1'; } catch { return false; } })();
  const moreBtn = h('button.more-toggle', { type: 'button', 'aria-expanded': String(moreOpen) });
  const scroll = h('div.detail-scroll');
  const moreBody = h('div.more-body', { hidden: !moreOpen });
  moreBtn.addEventListener('click', () => {
    const open = moreBody.hidden;
    moreBody.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(moreKey, open ? '1' : '0'); } catch { /* ignore */ }
    paintMore();
  });
  const paintMore = () => setChildren(moreBtn, icon('chevron'), moreBody.hidden ? 'More details: fields, evidence, checklist, history' : 'Fewer details');
  paintMore();
  scroll.append(storyEl, moreBtn, moreBody);
  el.append(head, scroll);

  const secs = {
    verify: h('div.detail-sec'),
    steer: h('div.detail-sec'),
    props: h('div.detail-sec'),
    card: h('div.detail-sec'),
    scope: h('div.detail-sec'),
    text: h('div.detail-sec'),
    evidence: h('div.detail-sec'),
    checklist: h('div.detail-sec'),
    links: h('div.detail-sec'),
    history: h('div.detail-sec'),
    danger: h('div.detail-sec'),
  };
  moreBody.append(...Object.values(secs));

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
    renderStory();
    renderVerify();
    renderSteer();
    renderProps();
    renderCard();
    renderScope();
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
    if (it.kind === 'assumption') chips.push(h('span.pill', ORIGIN[it.origin || 'agent'].label));
    if (it.kind === 'relation') chips.push(h('span.pill', { style: { color: (RELATION[it.type] || RELATION.other).color } }, (RELATION[it.type] || RELATION.other).label));
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

  // What it is, what is known, what is still open, and the two or three obvious next steps.
  function renderStory() {
    const it = current;
    const st = storyFor(it);
    const verdict = it.verification === 'verified' ? 'You agreed with this.' : it.verification === 'disputed' ? 'You doubted this; whoever made the claim was asked to revisit it.' : null;
    const acts = actionsFor(it).map((a) => h(`button.btn.btn-sm${a.primary ? '.btn-primary' : ''}`, {
      'data-tip': a.tip || null,
      on: { click: async (e) => { try { await a.run(e.currentTarget); } catch (err) { toast(err.message, 'error'); } } },
    }, a.icon ? icon(a.icon) : null, a.label));
    setChildren(storyEl,
      h('div.story-text', ...st.lines.filter(Boolean)),
      st.status ? h(`div.story-status.${st.tone || 'muted'}`, st.status) : null,
      verdict ? h(`div.story-status.${it.verification === 'verified' ? 'ok' : 'bad'}`, verdict) : null,
      acts.length ? h('div.story-actions', ...acts) : null);
  }

  function actionsFor(it) {
    const agree = (label = 'Looks right') => ({ label, icon: 'check', run: () => save({ verification: 'verified' }), tip: 'You checked it and agree' });
    const doubt = (label = 'I doubt it') => ({ label, icon: 'x', run: () => save({ verification: 'disputed' }), tip: 'Whoever made this claim is asked to revisit it' });
    const ask = (label, action) => ({ label, icon: 'send', primary: true, run: (anchor) => openSteerComposer(anchor, { item: it, action }) });
    switch (it.kind) {
      case 'assumption': return [ask('Ask an agent to test it', 'challenge'), { ...agree(), run: () => save({ verification: 'verified', state: 'verified' }) }, doubt()];
      case 'hypothesis':
        if (it.status === 'dropped') return [{ label: 'Reopen', icon: 'refresh', run: () => save({ status: 'testing' }) }];
        return [
          it.status === 'confirmed' && !it.findingId ? { label: 'Make it a finding', icon: 'bug', primary: true, run: () => promote(it) } : ask('Ask for proof', 'verify'),
          it.status !== 'confirmed' ? { label: 'It is real', icon: 'check', run: () => save({ status: 'confirmed', verification: 'verified' }) } : agree('I agree'),
          { label: 'Not a bug', icon: 'x', run: () => { const why = prompt('Why is it not a bug? (one line)'); if (why !== null) return save({ status: 'dropped', dropReason: why }); return null; } },
        ];
      case 'finding': return [ask('Ask for a stronger proof', 'verify'), agree('I agree'), doubt(), { label: 'Report', icon: 'file', run: () => bus.report?.() }];
      case 'component':
        if (it.type === 'actor' || it.type === 'external') return [];
        return [ask('Point an agent here', 'cover'), agree('Looks fine to me'), doubt('Something is off')];
      case 'relation': return [agree('Correct'), doubt('Wrong')];
      case 'lead':
        if (it.state === 'done' || it.state === 'dropped') return [{ label: 'Reopen', icon: 'refresh', run: () => save({ state: 'open' }) }];
        return [{ label: 'Point an agent at it', icon: 'send', primary: true, run: (anchor) => openSteerComposer(anchor, { item: it, action: 'cover', to: ['all'] }) },
          { label: 'Done', icon: 'check', run: () => save({ state: 'done' }) }, { label: 'Drop', icon: 'x', run: () => save({ state: 'dropped' }) }];
      case 'chain': return [agree('I agree'), doubt()];
      case 'target': return [ask('Point agents at it', 'cover'), { label: 'Edit scope', icon: 'edit', run: () => { if (moreBody.hidden) moreBtn.click(); secs.scope.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }];
      default: return [];
    }
  }

  // The confirmation card for findings, and the confirmation loop for hypotheses.
  async function renderCard() {
    const it = current;
    if (it.kind === 'hypothesis') {
      secs.card.hidden = false;
      const done = it.confirm || {};
      setChildren(secs.card,
        h('div.sec-label', icon('list'), 'Confirmation loop', h('span.right', it.exploitStage ? h(`span.stage-pill.${it.exploitStage}`, EXPLOIT_STAGE[it.exploitStage].label) : 'stage not set')),
        ...CONFIRM_STEPS.map((st) => {
          const state = done[st.id]?.state || 'unchecked';
          return h('div.check', {
            'data-state': state, role: 'checkbox', tabindex: 0,
            on: { click: () => save({ confirm: { [st.id]: state === 'checked' ? 'unchecked' : 'checked' } }) },
          }, h('span.box', state === 'checked' ? icon('check') : null), h('span', st.text), done[st.id]?.by ? h('span.who', authorName(done[st.id].by)) : null);
        }));
      return;
    }
    if (it.kind !== 'finding') { secs.card.hidden = true; return; }
    secs.card.hidden = false;
    const rows = CARD_FIELDS.map((f) => row(f.label, f.options
      ? select(it[f.id] || '', ['', ...f.options], (v) => save({ [f.id]: v }), { labels: { '': '—' } })
      : input(it[f.id], (v) => save({ [f.id]: v }), { placeholder: f.hint }), it, f.id));
    const gates = h('div.gate-list', h('div.gate', h('span.spinner')));
    setChildren(secs.card,
      h('div.sec-label', icon('shield'), 'Confirmation card', h('span.right', h('span.ready-pill.no', '…'))),
      h('div.props', ...rows.flat()),
      gates);
    try {
      const r = await get(`/api/findings/${it.id}/check`);
      if (current.id !== it.id) return;
      const pill = secs.card.querySelector('.ready-pill');
      pill.className = `ready-pill ${r.ready ? 'yes' : 'no'}`;
      pill.textContent = r.ready ? 'ready to report' : 'not ready';
      const bad = [
        ...r.card.map((g) => `${g.field}: ${g.why}`),
        ...r.evidence.map((g) => `evidence: ${g}`),
        ...(r.severity ? [r.severity] : []),
        ...(r.testPassing ? [] : ['the test has not passed on its last run']),
        ...(r.duplicateOf ? [`duplicate of "${r.duplicateOf.title}"`] : []),
        ...(r.matchesAlreadyReported ? [`matches already reported: ${r.matchesAlreadyReported.title}`] : []),
      ];
      setChildren(gates, ...(bad.length ? bad.map((b) => h('div.gate.bad', icon('x'), b)) : [h('div.gate.ok', icon('check'), 'Card complete, evidence attached, severity earned, test passing.')]));
    } catch { gates.replaceChildren(); }
  }

  // Program scope on targets: what is in, what is out, what was already reported.
  async function renderScope() {
    const it = current;
    if (it.kind !== 'target') { secs.scope.hidden = true; return; }
    secs.scope.hidden = false;
    const types = ['lending', 'amm', 'perps', 'bridge', 'staking', 'nft-market', 'governance', 'oracle', 'token', 'vault', 'factory', 'dao-module', 'nft-custody', 'naming', 'other'];
    const extra = new Set(it.playbooks || []);
    const reported = (it.alreadyReported || []).map((r) => (typeof r === 'string' ? { title: r } : r));
    const addInput = h('input.inline', { placeholder: 'Title of an already-reported issue (date, contract)' });
    const addReported = () => {
      const v = addInput.value.trim();
      if (!v) return;
      const [title, date, contract] = v.split(',').map((x) => x.trim());
      save({ alreadyReported: [...reported, { title, ...(date ? { date } : {}), ...(contract ? { contract } : {}) }] });
    };
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addReported(); });
    const rows = [
      row('In scope', input(it.inScope, (v) => save({ inScope: v }), { placeholder: 'Contracts, repos, chains in scope' }), it, 'inScope'),
      row('Out of scope', input(it.outOfScope, (v) => save({ outOfScope: v }), { placeholder: 'Third-party, frontend, known issues' }), it, 'outOfScope'),
      row('Disclosure', input(it.disclosureChannel, (v) => save({ disclosureChannel: v }), { placeholder: 'security@… or a platform link' }), it, 'disclosureChannel'),
      row('Severity scale', input(it.severityScale, (v) => save({ severityScale: v }), { placeholder: 'The program\'s scale and rewards' }), it, 'severityScale'),
      row('Rules', input(it.bountyRules, (v) => save({ bountyRules: v }), { placeholder: 'e.g. one vulnerability per submission' }), it, 'bountyRules'),
      row('Already reported', h('div.list-editor',
        ...reported.map((r, i) => h('div.li', h('span', `${r.title}${r.date ? ` · ${r.date}` : ''}${r.contract ? ` · ${r.contract}` : ''}`),
          h('button.tool.sm', { 'aria-label': 'Remove', style: { width: '22px', height: '22px' }, on: { click: () => save({ alreadyReported: reported.filter((_, j) => j !== i) }) } }, icon('x')))),
        h('div.add', addInput, h('button.btn.btn-xs', { on: { click: addReported } }, icon('plus')))), it, 'alreadyReported'),
      row('Also use', h('div.steer-actions', ...types.filter((t) => t !== it.protocolType).map((t) => h(`button.filter`, {
        'aria-pressed': String(extra.has(t)), style: { height: '24px', fontSize: '11px' },
        on: { click: () => { const n = new Set(extra); if (n.has(t)) n.delete(t); else n.add(t); save({ playbooks: [...n] }); } },
      }, t))), it, 'playbooks'),
    ];
    setChildren(secs.scope, h('div.sec-label', icon('target'), 'Program scope and playbooks'), h('div.props', ...rows.flat()), h('div.ignored-classes'));
    const ignored = new Set(it.ignoredClasses || []);
    const allClasses = new Map();
    for (const t of [it.protocolType || 'other', ...extra]) {
      const pb = await loadPlaybook(t);
      for (const c of pb?.classes || []) allClasses.set(c.id, c.name);
    }
    if (current.id !== it.id) return;
    setChildren(secs.scope.querySelector('.ignored-classes'),
      h('div.field-label', { style: { margin: '10px 0 6px' } }, 'Exploit classes (click to ignore the ones that do not apply)'),
      h('div.steer-actions', ...[...allClasses].map(([id, nm]) => h('button.filter', {
        'aria-pressed': String(!ignored.has(id)), style: { height: '24px', fontSize: '11px', textDecoration: ignored.has(id) ? 'line-through' : 'none' },
        on: { click: () => { const n = new Set(ignored); if (n.has(id)) n.delete(id); else n.add(id); save({ ignoredClasses: [...n] }); } },
      }, nm))));
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
      ...(extra ? [h('div', { style: { height: '12px' } }), ...block('repro', 'Reproduction', 'No reproduction yet. A finding without a repro is easy to dismiss.'),
        h('div', { style: { height: '12px' } }), ...block('fix', 'Suggested fix', 'No fix yet. The report needs one an engineer could implement from the description.')] : []));
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
        h('div', h('div.ref', e.ref || '(no reference)'), e.note ? h('div.note', e.note) : null,
          e.block || e.rpc || e.result ? h('div.note', [e.result ? `result ${e.result}` : '', e.block ? `block ${e.block}` : '', e.rpc || ''].filter(Boolean).join(' · ')) : null),
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
    let pb = null;
    try { pb = target ? await get(`/api/targets/${target.id}/playbook`) : await loadPlaybook('other'); } catch { pb = await loadPlaybook(target?.protocolType || 'other'); }
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
  return { finding: 'title', hypothesis: 'text', assumption: 'text', proposal: 'text', steer: 'note', relation: 'label', chain: 'title', lead: 'text' }[kind] || 'name';
}

export function steerMini(s) {
  const meta = STEER[s.action] || STEER.note;
  const to = (s.to || []).includes('all') ? 'everyone' : (s.to || []).map((t) => authorName(t)).join(', ');
  return h('div.steer', { 'data-state': s.state },
    h('div.steer-top', icon(meta.icon), h('b', meta.label), '→', to,
      h('span.right', h(`span.state-pill.${s.state}`, { 'data-tip': STEER_STATE[s.state].hint }, STEER_STATE[s.state].label))),
    s.note ? h('div.steer-note', s.note) : null,
    s.response ? h('div.steer-response', icon('message'), ...prose(s.response)) : null);
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
        row('Type', select(it.type, ['contract', 'function', 'module', 'endpoint', 'storage', 'config', 'actor', 'external', 'other'], s('type')), it, 'type'),
        row('Summary', input(it.summary, s('summary'), { placeholder: 'What it does, one line' }), it, 'summary'),
        row('Location', input(it.location, s('location'), { placeholder: 'path/to/File.sol:120' }), it, 'location'),
        row('Owner', select(it.owner || '', ['', ...agents.map((a) => a.id)], s('owner'), { labels: { '': 'Nobody', ...Object.fromEntries(agents.map((a) => [a.id, a.name])) } }), it, 'owner'),
      ];
    }
    case 'assumption':
      return [
        row('Whose', select(it.origin || 'agent', Object.keys(ORIGIN), s('origin'), { labels: labelsOf(ORIGIN) }), it, 'origin'),
        row('Category', select(it.category || 'other', Object.keys(CATEGORY), s('category')), it, 'category'),
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
        row(h('span', { 'data-tip': 'capability: the power exists, no public path fires it yet. trigger: a path fires it, impact unproven. full: trigger + impact.', class: 'term' }, 'Exploit stage'),
          select(it.exploitStage || '', ['', ...Object.keys(EXPLOIT_STAGE)], s('exploitStage'), { labels: { '': 'not set', ...Object.fromEntries(Object.entries(EXPLOIT_STAGE).map(([k, m]) => [k, m.label])) } }), it, 'exploitStage'),
        row('Trigger', input(it.trigger, s('trigger'), { placeholder: 'The public path that makes it fire' }), it, 'trigger'),
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
    case 'relation': {
      const comps = list('component', (c) => c.targetId === it.targetId);
      const names = Object.fromEntries(comps.map((c) => [c.id, c.name]));
      return [
        row('From', select(it.from, comps.map((c) => c.id), s('from'), { labels: names }), it, 'from'),
        row('How', select(it.type, Object.keys(RELATION), s('type'), { labels: Object.fromEntries(Object.entries(RELATION).map(([k, m]) => [k, m.label])) }), it, 'type'),
        row('To', select(it.to, comps.map((c) => c.id), s('to'), { labels: names }), it, 'to'),
        row('Detail', input(it.label, s('label'), { placeholder: 'e.g. transferFrom user' }), it, 'label'),
      ];
    }
    case 'target':
      return [
        row('Phase', select(it.phase || 'mapping', PHASES.map((p) => p.id), s('phase'), { labels: Object.fromEntries(PHASES.map((p) => [p.id, p.label])) }), it, 'phase'),
        row('Protocol type', select(it.protocolType, ['lending', 'amm', 'perps', 'bridge', 'staking', 'nft-market', 'governance', 'oracle', 'token', 'vault', 'other'], s('protocolType')), it, 'protocolType'),
        row('Chain', input(it.chain, s('chain'), { placeholder: 'e.g. mainnet' }), it, 'chain'),
        row('Scope', input(it.scope, s('scope'), { placeholder: 'In-scope paths or contracts' }), it, 'scope'),
      ];
    case 'lead':
      return [
        row('State', select(it.state, Object.keys(LEAD_STATE), s('state'), { labels: Object.fromEntries(Object.entries(LEAD_STATE).map(([k, m]) => [k, m.label])) }), it, 'state'),
        row('Value', select(it.value, Object.keys(VALUE), s('value'), { labels: VALUE }), it, 'value'),
        row('Why it matters', input(it.why, s('why'), { placeholder: 'What it would prove or change' }), it, 'why'),
        row('Blocked by', input(it.blockedBy, s('blockedBy'), { placeholder: 'What is in the way' }), it, 'blockedBy'),
        row('Next step', input(it.nextStep, s('nextStep'), { placeholder: 'The concrete next action' }), it, 'nextStep'),
        row('Outcome', input(it.outcome, s('outcome'), { placeholder: 'What came of it' }), it, 'outcome'),
      ];
    case 'chain':
      return [
        row('Parts', h('div.chain-parts', ...(it.parts || []).map((id, i) => [i ? h('span.plus', '+') : null, h('button.part', { style: { border: 0, cursor: 'pointer' }, on: { click: () => bus.open(id) } }, titleOf(byId(id)) || id)])), null, null),
        row('Glue', select(it.glue, Object.keys(GLUE), s('glue'), { labels: GLUE }), it, 'glue'),
        row('Attacker controls the glue', select(String(Boolean(it.gluePermissionless)), ['false', 'true'], (v) => save({ gluePermissionless: v === 'true' }), { labels: { false: 'no', true: 'yes' } }), it, 'gluePermissionless'),
        row('Result', input(it.result, s('result'), { placeholder: 'The extra impact no single part has' }), it, 'result'),
        row('Severity', select(it.severity, Object.keys(SEVERITY), s('severity'), { labels: labelsOf(SEVERITY) }), it, 'severity'),
      ];
    case 'agent':
      return [
        row('Status', h('span', it.status), null, null),
        row('Transport', h('span', (it.transports || [it.transport]).join(' + ')), null, null),
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

