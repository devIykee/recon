// Steering: leave a signal on any item or agent. Never blocks the agent.

import { h, icon, popover, closePopover, toast } from './ui.js';
import { list, write, titleOf, healthOf } from './state.js';
import { STEER } from './labels.js';

// Who a steer on this item should go to by default: the owner, else the agent that made it.
export function defaultRecipients(item) {
  if (!item) return ['all'];
  if (item.kind === 'agent') return [item.id];
  if (item.owner) return [item.owner];
  if (item.createdBy && !item.createdBy.startsWith('human')) return [item.createdBy];
  return ['all'];
}

export function recipientPicker(selected, { onChange } = {}) {
  const agents = list('agent');
  const wrap = h('div.recipients');
  const sel = new Set(selected);
  const render = () => {
    wrap.replaceChildren(
      h('button.recipient', {
        type: 'button', 'aria-pressed': String(sel.has('all')),
        on: { click: () => { sel.clear(); sel.add('all'); render(); onChange?.([...sel]); } },
      }, icon('agents'), 'Everyone'),
      ...agents.map((a) => h('button.recipient', {
        type: 'button', 'aria-pressed': String(sel.has(a.id)),
        on: {
          click: () => {
            sel.delete('all');
            if (sel.has(a.id)) sel.delete(a.id); else sel.add(a.id);
            if (!sel.size) sel.add('all');
            render();
            onChange?.([...sel]);
          },
        },
      }, avatar(a, 'xs'), a.name)),
    );
  };
  render();
  wrap.value = () => [...sel];
  return wrap;
}

export function avatar(agentOrAuthor, size = '') {
  const a = typeof agentOrAuthor === 'string' ? null : agentOrAuthor;
  if (!a) {
    const human = typeof agentOrAuthor === 'string' && agentOrAuthor.startsWith('human');
    return h(`span.avatar${size ? `.${size}` : ''}${human ? '.human' : ''}`, { title: human ? 'You' : String(agentOrAuthor || '') }, human ? 'Y' : '?');
  }
  const st = healthOf(a.id).status;
  return h(`span.avatar${size ? `.${size}` : ''}`, {
    style: { '--c': a.color }, 'data-status': st, title: `${a.name} · ${st}`,
  }, a.avatar || a.name.slice(0, 2).toUpperCase());
}

export function authorAvatar(author, size = 'xs') {
  if (!author || author.startsWith('human')) return h(`span.avatar.human${size ? `.${size}` : ''}`, { title: 'You' }, 'Y');
  const a = list('agent').find((x) => x.id === author);
  return a ? avatar(a, size) : h(`span.avatar${size ? `.${size}` : ''}`, '?');
}

// A small composer anchored to a button.
export function openSteerComposer(anchor, { item, action = 'note', to, text = '' } = {}) {
  const meta = STEER[action] || STEER.note;
  const recipients = recipientPicker(to || defaultRecipients(item));
  const note = h('textarea.textarea', {
    rows: 3, placeholder: placeholder(action, item), style: { minHeight: '70px' },
  });
  note.value = text;
  const send = async () => {
    try {
      await write.create('steer', {
        action,
        itemId: item && item.kind !== 'agent' ? item.id : '',
        itemKind: item && item.kind !== 'agent' ? item.kind : '',
        to: recipients.value(),
        note: note.value.trim() || `${meta.verb}${item ? `: ${titleOf(item)}` : ''}`,
      });
      closePopover();
      toast('Steer sent. The agent picks it up without stopping what it is doing.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  };
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  const el = popover(anchor, [
    h('div', { style: { padding: '6px 6px 2px', width: '300px' } },
      h('div.sec-label', icon(meta.icon), meta.verb),
      note,
      h('div.field-label', { style: { margin: '10px 0 6px' } }, 'Send to'),
      recipients,
      h('div.modal-actions', { style: { marginTop: '12px' } },
        h('span.verify-note', 'Ctrl+Enter to send'), h('span.spacer'),
        h('button.btn.btn-sm.btn-primary', { on: { click: send } }, icon('send'), 'Send steer'))),
  ]);
  setTimeout(() => note.focus(), 30);
  return el;
}

function placeholder(action, item) {
  const name = item ? titleOf(item) : 'this';
  switch (action) {
    case 'recheck': return `What should be re-checked about ${name}? (optional)`;
    case 'challenge': return 'Why might this not hold? (optional)';
    case 'cover': return `Anything to look out for in ${name}? (optional)`;
    case 'verify': return 'What would convince you? A PoC, a trace, a test? (optional)';
    default: return 'Your note or question for the agent';
  }
}
