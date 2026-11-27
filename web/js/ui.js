// Small ui toolkit: element builder, icons, keyed reconciliation with enter/leave
// animations, tooltips with glossary lookups, popovers, modals and toasts.

const P = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  map: P('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>'),
  coverage: P('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h7v7h-7z" stroke-dasharray="2 2.4"/>'),
  sticky: P('<path d="M4 4h16v10l-6 6H4z"/><path d="M14 20v-6h6"/>'),
  flask: P('<path d="M9 3h6M10 3v6L4.5 18.5A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.5-2.5L14 9V3"/><path d="M7.2 15h9.6"/>'),
  bug: P('<path d="M9 7.5a3 3 0 0 1 6 0"/><rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 12v8M3 13h4M17 13h4M4 7.5l3 2M20 7.5l-3 2M4 19.5l3-2M20 19.5l-3-2"/>'),
  agents: P('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .8 3.2 2.6 3.6 5.2"/>'),
  agent: P('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>'),
  activity: P('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  flag: P('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  compass: P('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>'),
  plug: P('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'),
  panel: P('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>'),
  menu: P('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  minus: P('<path d="M5 12h14"/>'),
  x: P('<path d="M6 6l12 12M18 6 6 18"/>'),
  check: P('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  fit: P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: P('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
  help: P('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>'),
  download: P('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: P('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  trash: P('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  refresh: P('<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>'),
  play: P('<path d="M7 4.5v15l12-7.5z"/>'),
  pause: P('<path d="M8 5v14M16 5v14"/>'),
  code: P('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
  link: P('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  hash: P('<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>'),
  test: P('<path d="M4 5h16v14H4z"/><path d="m8 12 3 3 5-6"/>'),
  note: P('<path d="M5 4h14v16H5z"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/>'),
  log: P('<path d="M4 6h16M4 10h10M4 14h16M4 18h8"/>'),
  eye: P('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  shield: P('<path d="M12 3 4.5 6v6c0 4.5 3.2 8 7.5 9 4.3-1 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  alert: P('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),
  clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  chevron: P('<path d="m6 9 6 6 6-6"/>'),
  arrow: P('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  sparkle: P('<path d="M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7z"/>'),
  target: P('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>'),
  send: P('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
  message: P('<path d="M4 5h16v11H9l-5 4z"/>'),
  up: P('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: P('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  recheck: P('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
  challenge: P('<path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/><path d="M4 4h16v16H4z" stroke-dasharray="3 3"/>'),
  cover: P('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>'),
  verify: P('<path d="M12 3 4.5 6v6c0 4.5 3.2 8 7.5 9 4.3-1 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  priority: P('<path d="M7 20V8M3 12l4-4 4 4M17 4v12M13 12l4 4 4-4"/>'),
  edit: P('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  list: P('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>'),
  book: P('<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5zM4 19.5A1.5 1.5 0 0 0 5.5 21H20"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),
  terminal: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
  globe: P('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'),
  file: P('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
  copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  zap: P('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  stop: P('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  graph: P('<rect x="2.5" y="9.5" width="6" height="5" rx="1.2"/><rect x="15.5" y="3.5" width="6" height="5" rx="1.2"/><rect x="15.5" y="15.5" width="6" height="5" rx="1.2"/><path d="M8.5 12h3.5c1 0 1.5-.5 1.5-1.5V7.5c0-1 .5-1.5 1.5-1.5h.5M12 12h1.5V16.5c0 1 .5 1.5 1.5 1.5h.5"/>'),
};

export function icon(name, cls = '') {
  const s = document.createElement('span');
  s.className = `icon ${cls}`.trim();
  s.innerHTML = ICONS[name] || '';
  return s;
}

// h('div.card#id', {attrs, on: {click}}, children...)
export function h(sel, attrs, ...children) {
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  const [tagPart, ...rest] = sel.split('.');
  const [tag, id] = tagPart.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (rest.length) el.className = rest.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') { for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn); }
      else if (k === 'class') el.className = `${el.className} ${v}`.trim();
      else if (k === 'style' && typeof v === 'object') {
        // custom properties (--c) must go through setProperty; plain assignment drops them
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === undefined || sv === null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function setChildren(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// Keyed reconciliation. Keeps dom nodes stable across renders so css transitions,
// focus and scroll survive, new items animate in and removed items animate out.
export function keyed(parent, list, keyOf, create, update) {
  const existing = new Map();
  for (const el of [...parent.children]) {
    if (el.dataset.key && !el.dataset.leaving) existing.set(el.dataset.key, el);
  }
  const seen = new Set();
  let prev = null;
  for (const item of list) {
    const key = String(keyOf(item));
    seen.add(key);
    let el = existing.get(key);
    const fresh = !el;
    if (fresh) {
      el = create(item);
      el.dataset.key = key;
      if (parent.dataset.ready) {
        el.classList.add('enter');
        el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
      }
    }
    update(el, item, fresh);
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el !== want) parent.insertBefore(el, want);
    prev = el;
  }
  for (const [key, el] of existing) {
    if (seen.has(key)) continue;
    el.dataset.leaving = '1';
    el.classList.add('leave');
    setTimeout(() => el.remove(), 280);
  }
  parent.dataset.ready = '1';
}

export function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  clearTimeout(el._flashT);
  el._flashT = setTimeout(() => el.classList.remove('flash'), 1700);
}

// ---------- time ----------

export function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Live-updating relative times.
export function timeEl(ts) {
  const t = h('time', { datetime: new Date(ts).toISOString(), title: new Date(ts).toLocaleString() }, ago(ts));
  t.dataset.ts = ts;
  return t;
}
setInterval(() => {
  const now = Date.now();
  for (const t of document.querySelectorAll('time[data-ts]')) t.textContent = ago(Number(t.dataset.ts), now);
}, 15000);

// ---------- tooltip & glossary ----------

let glossary = {};
export function setGlossary(g) { glossary = g || {}; }
export function define(term) { return glossary[term.toLowerCase()] || null; }

// A word with a hover explanation.
export function term(text, key = text) {
  return h('span.term', { 'data-term': key.toLowerCase() }, text);
}

const tip = () => document.getElementById('tooltip');
let tipTimer = null;
let tipTarget = null;

function showTip(target) {
  const el = tip();
  const key = target.dataset.term;
  const text = target.dataset.tip;
  const def = key ? define(key) : null;
  if (!def && !text) return;
  setChildren(el, def ? [h('span.tt-term', key), def] : text);
  el.hidden = false;
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 8;
  if (y + hgt > innerHeight - 8) y = r.top - hgt - 8;
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-term], [data-tip]');
    if (t === tipTarget) return;
    tipTarget = t;
    clearTimeout(tipTimer);
    tip().hidden = true;
    if (!t) return;
    tipTimer = setTimeout(() => showTip(t), t.dataset.term ? 250 : 450);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); tip().hidden = true; });
}

// ---------- toasts ----------

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  const el = h(`div.toast${kind ? `.${kind}` : ''}`, kind === 'error' ? icon('alert') : kind === 'ok' ? icon('check') : null, message);
  root.append(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 250); }, kind === 'error' ? 5200 : 2800);
}

// ---------- popovers & menus ----------

let openPop = null;

export function closePopover() {
  if (openPop) { openPop.remove(); openPop = null; }
}

export function popover(anchor, content, { align = 'start', onClose } = {}) {
  closePopover();
  const root = document.getElementById('popover-root');
  const el = h('div.popover', { role: 'menu' }, content);
  root.append(el);
  // The text-size setting zooms popovers, and CSS zoom scales left/top too:
  // measure what is really on screen and place it in the popover's own units.
  const z = parseFloat(getComputedStyle(el).zoom) || 1;
  const r = anchor.getBoundingClientRect();
  // offsetWidth ignores the pop-in animation's scale; times the zoom it is the size on screen
  const w = el.offsetWidth * z;
  const hgt = Math.min(el.offsetHeight * z, innerHeight - 16);
  let x = align === 'end' ? r.right - w : r.left;
  let y = r.bottom + 6;
  if (y + hgt > innerHeight - 8) y = Math.max(8, r.top - hgt - 6);
  if (y + hgt > innerHeight - 8) y = Math.max(8, innerHeight - hgt - 8);
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  el.style.maxHeight = `${(innerHeight - 16) / z}px`;
  el.style.overflowY = 'auto';
  el.style.left = `${x / z}px`;
  el.style.top = `${y / z}px`;
  openPop = el;
  const off = (e) => {
    if (el.contains(e.target) || anchor.contains(e.target)) return;
    document.removeEventListener('pointerdown', off, true);
    if (openPop === el) closePopover();
    onClose?.();
  };
  setTimeout(() => document.addEventListener('pointerdown', off, true));
  el.querySelector('button')?.focus({ preventScroll: true });
  return el;
}

export function menu(anchor, items, opts) {
  const content = items.map((it) => {
    if (it === '-') return h('div.menu-sep');
    if (it.label && !it.action) return h('div.menu-label', it.label);
    return h(`button.menu-item${it.danger ? '.danger' : ''}${it.sub ? '.tall' : ''}`, {
      role: 'menuitem',
      on: { click: () => { closePopover(); it.action(); } },
    }, it.icon ? icon(it.icon) : null, it.sub ? h('span', it.text, h('span.sub', it.sub)) : h('span', it.text), it.shortcut ? h('span.sc', it.shortcut) : null);
  });
  return popover(anchor, content, opts);
}

// ---------- modal ----------

let modalStack = [];

export function modal(content, { wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const box = h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true' });
  const close = () => {
    backdrop.remove();
    modalStack = modalStack.filter((m) => m !== api);
    onClose?.();
  };
  const backdrop = h('div.modal-backdrop', { on: { pointerdown: (e) => { if (e.target === backdrop) close(); } } }, box);
  const closeBtn = h('button.tool.sm.close', { 'aria-label': 'Close', on: { click: close } }, icon('x'));
  const api = {
    el: box,
    close,
    set(...children) { setChildren(box, closeBtn, ...children); const f = box.querySelector('[autofocus], input, textarea, select'); f?.focus(); },
  };
  api.set(content);
  root.append(backdrop);
  modalStack.push(api);
  return api;
}

export function topModal() { return modalStack[modalStack.length - 1] || null; }

export function confirmDialog(title, body, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal([
      h('h2', title),
      h('p.lead', body),
      h('div.modal-actions',
        h('button.btn', { on: { click: () => { done = true; m.close(); resolve(false); } } }, 'Cancel'),
        h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { autofocus: true, on: { click: () => { done = true; m.close(); resolve(true); } } }, ok)),
    ], { onClose: () => { if (!done) resolve(false); } });
  });
}

export function copyButton(getText) {
  const b = h('button.tool.sm.copy', { 'aria-label': 'Copy', 'data-tip': 'Copy' }, icon('copy'));
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(typeof getText === 'function' ? getText() : getText);
      setChildren(b, icon('check'));
      setTimeout(() => setChildren(b, icon('copy')), 1400);
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  });
  return b;
}

export function codeBlock(text) {
  const pre = h('div.code', text);
  pre.append(copyButton(() => pre.firstChild.textContent));
  return pre;
}

// Stable small hash for seeding sketches and tilts.
export function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
