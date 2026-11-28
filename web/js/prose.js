// Agents write ids into what they say ("re st_mx08…", "filed as hy_…"). People should
// never have to read those: show the item's own words instead, as a chip that opens it.

import { h } from './ui.js';
import { byId, titleOf } from './state.js';
import { bus } from './bus.js';

const ID = /\b(?:ag|tg|cp|rl|as|hy|fd|ch|st|pr|ld|ms|ru|sg|it)_[a-z0-9]{6,}\b/g;
const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function nameFor(id) {
  if (id.startsWith('sg_')) return 'a suggestion';
  const item = byId(id);
  return item ? short(String(titleOf(item))) : null;
}

// Text with every id replaced by the item's name, for places that only take a string.
export function plainProse(text) {
  return String(text ?? '').replace(ID, (id) => { const n = nameFor(id); return n ? `"${n}"` : 'an earlier item'; });
}

// Text as nodes: ids become chips with the item's name.
export function prose(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(ID)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const id = m[0];
    const item = id.startsWith('sg_') ? null : byId(id);
    out.push(item
      ? h('span.ref', { role: 'button', tabindex: 0, title: 'Open it', on: {
        click: (e) => { e.stopPropagation(); bus.open(id); },
        keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); bus.open(id); } },
      } }, short(String(titleOf(item)), 48))
      : h('span.ref.gone', nameFor(id) || 'an earlier item'));
    last = m.index + id.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
