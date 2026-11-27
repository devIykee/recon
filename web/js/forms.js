// Create forms. Sensible defaults everywhere; only the first field is required.

import { h, icon, modal, toast } from './ui.js';
import { list, byId, write } from './state.js';
import { SEVERITY, STAGES, CONFIDENCE, PROTOCOL_ICON } from './labels.js';
import { bus, loadPlaybookList, loadPlaybook } from './bus.js';

function field(label, control, help) {
  return h('div.field', h('label', label), control, help ? h('span.help', help) : null);
}

function input(name, { placeholder = '', value = '', mono = false, autofocus = false, type = 'text' } = {}) {
  return h(`input.input${mono ? '.mono' : ''}`, { name, placeholder, value, autofocus, type });
}

function textarea(name, { placeholder = '', value = '', rows = 3, mono = false } = {}) {
  const t = h(`textarea.textarea${mono ? '.mono' : ''}`, { name, placeholder, rows });
  t.value = value;
  return t;
}

function select(name, options, value) {
  return h('select.select', { name }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function seg(name, options, value) {
  const wrap = h('div.seg', { role: 'radiogroup' });
  wrap.dataset.name = name;
  wrap.dataset.value = value;
  for (const [v, label] of options) {
    wrap.append(h('button', {
      type: 'button', 'aria-pressed': String(v === value),
      on: { click: () => { wrap.dataset.value = v; for (const b of wrap.children) b.setAttribute('aria-pressed', String(b === wrap.querySelector(`[data-v="${v}"]`))); } },
      'data-v': v,
    }, label));
  }
  return wrap;
}

function targetOptions() {
  return [['', 'No target'], ...list('target').map((t) => [t.id, t.name])];
}

function componentOptions(targetId) {
  return [['', 'No specific component'], ...list('component', (c) => !targetId || c.targetId === targetId).map((c) => [c.id, c.name])];
}

function read(form) {
  const out = {};
  for (const el of form.querySelectorAll('[name]')) out[el.name] = el.value;
  for (const s of form.querySelectorAll('.seg[data-name]')) out[s.dataset.name] = s.dataset.value;
  return out;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null));
}

// Keep the component picker in sync with the target picker.
function linkPickers(form) {
  const t = form.querySelector('[name="targetId"]');
  const c = form.querySelector('[name="componentId"]');
  if (!t || !c) return;
  t.addEventListener('change', () => {
    const keep = c.value;
    c.replaceChildren(...componentOptions(t.value).map(([v, l]) => h('option', { value: v, selected: v === keep }, l)));
  });
}

export async function newItem(kind, defaults = {}) {
  const firstTarget = defaults.targetId || list('target')[0]?.id || '';
  const comp = defaults.componentId ? byId(defaults.componentId) : null;
  let title; let lead; let body; let submit;

  switch (kind) {
    case 'target': return newTarget(defaults);
    case 'component':
      title = 'Add a component';
      lead = 'A piece of the attack surface: a contract, a function, an endpoint. Agents mark it as they review it.';
      body = [
        field('Name', input('name', { placeholder: 'Vault.withdraw()', autofocus: true, mono: true })),
        h('div.row-fields',
          field('Target', select('targetId', list('target').map((t) => [t.id, t.name]), firstTarget)),
          field('Type', select('type', ['function', 'contract', 'module', 'endpoint', 'storage', 'config', 'other'].map((x) => [x, x]), 'function'))),
        field('Location', input('location', { placeholder: 'contracts/Vault.sol:120', mono: true }), 'Optional. Where to find it.'),
      ];
      submit = (v) => {
        if (!v.targetId) throw new Error('Add a target first.');
        return write.create('component', clean(v));
      };
      break;
    case 'assumption':
      title = 'Add an assumption';
      lead = 'Something being taken for granted. Writing it down makes it challengeable.';
      body = [
        field('The assumption', textarea('text', { placeholder: 'Only the owner can call setFee()', rows: 2 })),
        h('div.row-fields',
          field('Target', select('targetId', targetOptions(), firstTarget)),
          field('Component', select('componentId', componentOptions(firstTarget), defaults.componentId || ''))),
        field('Why it seems true', textarea('rationale', { placeholder: 'onlyOwner modifier on line 42', rows: 2 }), 'Optional, but makes it checkable.'),
      ];
      submit = (v) => write.create('assumption', clean(v));
      break;
    case 'hypothesis': {
      title = 'Add a hypothesis';
      lead = 'A suspected bug. It gets tested until it is confirmed or dropped.';
      const t = byId(firstTarget);
      const pb = t ? await loadPlaybook(t.protocolType) : null;
      const dl = h('datalist#bugclasses', ...(pb?.classes || []).map((c) => h('option', { value: c.id }, c.name)));
      body = [
        field('What might be wrong', textarea('text', { placeholder: 'First depositor can inflate the share price', rows: 2 })),
        h('div.row-fields',
          field('Target', select('targetId', targetOptions(), firstTarget)),
          field('Component', select('componentId', componentOptions(firstTarget), defaults.componentId || ''))),
        h('div.row-fields',
          field('Bug class', h('div', h('input.input', { name: 'bugClass', list: 'bugclasses', placeholder: 'e.g. share-inflation' }), dl)),
          field('Confidence', seg('confidence', Object.entries(CONFIDENCE), 'low'))),
        field('Reasoning', textarea('reasoning', { placeholder: 'Why you suspect it', rows: 2 }), 'Optional.'),
      ];
      submit = (v) => write.create('hypothesis', clean(v));
      break;
    }
    case 'finding':
      title = 'Add a finding';
      lead = 'A bug you can back with evidence. Findings move through the pipeline to responsible disclosure.';
      body = [
        field('Title', input('title', { placeholder: 'withdraw() rounds in the user\'s favor', autofocus: true })),
        h('div.row-fields',
          field('Target', select('targetId', targetOptions(), firstTarget)),
          field('Component', select('componentId', componentOptions(firstTarget), defaults.componentId || ''))),
        field('Severity', seg('severity', Object.entries(SEVERITY).map(([k, m]) => [k, m.label]), 'medium')),
        h('div.row-fields',
          field('Stage', select('stage', Object.entries(STAGES).map(([k, m]) => [k, m.label]), 'recon')),
          field('Bug class', input('bugClass', { placeholder: 'rounding' }))),
        field('Notes', textarea('notes', { placeholder: 'Impact, root cause, anything worth keeping', rows: 3 }), 'Optional.'),
      ];
      submit = (v) => {
        const target = byId(v.targetId);
        return write.create('finding', clean({ ...v, chain: target?.chain }));
      };
      break;
    default:
      return null;
  }
  void comp;

  const form = h('form', ...body,
    h('div.modal-actions', h('button.btn', { type: 'button', on: { click: () => m.close() } }, 'Cancel'),
      h('button.btn.btn-primary', { type: 'submit' }, icon('plus'), 'Add')));
  linkPickers(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const item = await submit(read(form));
      m.close();
      toast(`Added ${kind}.`, 'ok');
      bus.open(item.id);
    } catch (err) { toast(err.message, 'error'); }
  });
  const m = modal([h('h2', title), h('p.lead', lead), form]);
  return m;
}

// Adding a target is also the first-run flow: name, type, surface.
export async function newTarget(defaults = {}) {
  const types = await loadPlaybookList();
  let type = defaults.protocolType || 'other';
  const name = input('name', { placeholder: 'Acme Lending', autofocus: true, value: defaults.name || '' });
  const chain = input('chain', { placeholder: 'mainnet, arbitrum, base…' });
  const comps = textarea('components', { placeholder: 'Pool.deposit()\nPool.withdraw()\nOracle.getPrice()', rows: 4, mono: true });
  const grid = h('div.choice-grid');
  const renderTypes = () => grid.replaceChildren(...types.map((t) => h('button.choice', {
    type: 'button', 'aria-pressed': String(type === t.type),
    on: { click: () => { type = t.type; renderTypes(); } },
  }, h('b', `${PROTOCOL_ICON[t.type] || ''} ${t.name}`), h('small', t.summary.split('. ')[0] + '.'))));
  renderTypes();

  const form = h('form',
    field('What are you looking at?', name),
    h('div.field', h('label', 'What kind of protocol is it?'), h('span.help', { style: { marginTop: '-2px' } }, 'This picks the playbook: the bug classes that usually bite this kind of protocol, and a checklist for each part.'), grid),
    h('div.row-fields', field('Chain', chain, 'Optional.'), h('div')),
    field('Parts in scope', comps, 'Optional. One contract or function per line. You or your agent can add more later.'),
    h('div.modal-actions', h('button.btn', { type: 'button', on: { click: () => m.close() } }, 'Cancel'),
      h('button.btn.btn-primary', { type: 'submit' }, icon('target'), 'Add target')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) { name.focus(); toast('Give the target a name.', 'error'); return; }
    try {
      const t = await write.create('target', clean({ name: name.value.trim(), protocolType: type, chain: chain.value.trim() }));
      for (const line of comps.value.split('\n').map((s) => s.trim()).filter(Boolean)) {
        await write.create('component', { targetId: t.id, name: line, type: /\(.*\)/.test(line) ? 'function' : 'contract' });
      }
      m.close();
      toast(`Added ${t.name}. The playbook for it is on the Coverage board.`, 'ok');
      defaults.onDone?.(t);
    } catch (err) { toast(err.message, 'error'); }
  });
  const m = modal([h('h2', 'Add a target'), h('p.lead', 'A protocol, contract set, or system you are researching.'), form], { wide: true });
  return m;
}
