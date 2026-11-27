// recon web ui: wires the live state to the map, the boards and the side panel.

import { applyTheme, currentThemeId, allThemes, addTheme, removeTheme, parseTheme, exportTheme, TOKENS } from './themes.js';
import { h, icon, ICONS, setChildren, initTooltips, setGlossary, toast, menu, modal, confirmDialog, closePopover, topModal } from './ui.js';
import { live, on, connect, list, byId, healthOf, agentIsWriting, authorName, post, patch, get, setKey } from './state.js';
import { VIEWS } from './labels.js';
import { createMap } from './map.js';
import { createBoards } from './boards.js';
import { createSidebar } from './sidebar.js';
import { newItem, newTarget } from './forms.js';
import { openConnect } from './connect.js';
import { bus, loadGlossary } from './bus.js';
import { isTyping } from './canvas.js';
import { avatar } from './steer.js';
import { openReport, openEngagements, openSkills } from './panels.js';

const app = document.getElementById('app');
const $ = (id) => document.getElementById(id);

// ---------- static chrome ----------

function paintIcons() {
  $('menu-btn').innerHTML = ICONS.menu;
  $('sidebar-btn').innerHTML = ICONS.panel;
  $('help-btn').innerHTML = ICONS.help;
  for (const b of document.querySelectorAll('[data-zoom]')) {
    const z = b.dataset.zoom;
    if (z === 'in') b.innerHTML = ICONS.plus;
    if (z === 'out') b.innerHTML = ICONS.minus;
    if (z === 'fit') b.innerHTML = ICONS.fit;
  }
  for (const s of document.querySelectorAll('[data-icon]')) s.innerHTML = ICONS[s.dataset.icon] || '';
  paintTheme();
}

function theme() {
  return document.documentElement.dataset.theme;
}

function setTheme(t) {
  applyTheme(t === 'light' ? 'light' : 'dark');
  paintTheme();
}

function paintTheme() {
  $('theme-btn').innerHTML = theme() === 'dark' ? ICONS.sun : ICONS.moon;
}

try {
  const t = localStorage.getItem('recon.theme');
  if (t) document.documentElement.dataset.theme = t;
  applyTheme(currentThemeId(), { save: false });
  for (const k of ['headFont', 'bodyFont', 'textSize', 'density']) {
    const v = localStorage.getItem(`recon.${k}`);
    if (v) document.documentElement.dataset[k] = v;
  }
} catch { /* ignore */ }

// ---------- appearance: fonts and text size ----------

const APPEARANCE = [
  { key: 'headFont', label: 'Headings and names', help: 'Titles, card names and the map', options: [['', 'Hand-drawn', 'Excalifont'], ['clean', 'Clean', 'Inter'], ['serif', 'Serif', 'Georgia'], ['mono', 'Mono', 'JetBrains Mono']] },
  { key: 'bodyFont', label: 'Body text', help: 'Everything you read', options: [['', 'Inter', 'Inter'], ['system', 'Your system font', 'system-ui'], ['serif', 'Serif', 'Georgia'], ['mono', 'Mono', 'JetBrains Mono']] },
  { key: 'density', label: 'Spacing', help: 'How tightly things sit together', options: [['', 'Compact', ''], ['comfortable', 'Comfortable', '']] },
  { key: 'textSize', label: 'Text size', help: 'Boards, side panel and windows', options: [['small', 'Small', ''], ['', 'Normal', ''], ['large', 'Large', ''], ['xl', 'Extra large', '']] },
];

const DARK_PREVIEW = { bg: '#121212', island: '#232329', border: '#393844', text: '#ececf1', muted: '#a3a3ae', primary: '#a8a5ff', 'st-reviewed': '#51cf66', 'st-flagged': '#ff922b', 'sev-critical': '#ff6b6b' };
const LIGHT_PREVIEW = { bg: '#ffffff', island: '#f4f4f8', border: '#e3e3ea', text: '#1b1b1f', muted: '#5d5d68', primary: '#6965db', 'st-reviewed': '#2f9e44', 'st-flagged': '#e8590c', 'sev-critical': '#e03131' };

function openAppearance() {
  const root = document.documentElement;
  const m = modal([], { wide: true });
  let adding = false;
  const themeCard = (t) => {
    const c = { ...(t.base === 'light' ? LIGHT_PREVIEW : DARK_PREVIEW), ...t.colors };
    return h('div.theme-card', { 'aria-pressed': String(currentThemeId() === t.id) },
      h('button.theme-pick', { type: 'button', on: { click: () => { applyTheme(t.id); paintTheme(); render(); } } },
        h('span.theme-preview', { style: { background: c.bg } },
          h('span.tp-island', { style: { background: c.island, borderColor: c.border } },
            h('span.tp-line', { style: { background: c.text } }), h('span.tp-line.short', { style: { background: c.muted } }),
            h('span.tp-dots', ...[c.primary, c['st-reviewed'], c['st-flagged'], c['sev-critical']].map((x) => h('i', { style: { background: x } }))))),
        h('b', t.name), h('small', t.note || (t.base === 'light' ? 'Light' : 'Dark'))),
      t.custom ? h('button.tool.sm.theme-x', { 'aria-label': `Remove ${t.name}`, 'data-tip': 'Remove', on: { click: () => { removeTheme(t.id); paintTheme(); render(); } } }, icon('x')) : null);
  };
  const addBox = () => {
    const ta = h('textarea.textarea.mono', { rows: 9, placeholder: '{ "name": "My theme", "base": "dark", "colors": { "bg": "#101418", "island": "#1a2027", "primary": "#7aa2f7" } }' });
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', async () => { if (file.files[0]) ta.value = await file.files[0].text(); });
    return h('div.theme-add',
      h('p.help', 'Paste a theme as JSON, or import a .json file. "base" is dark or light; "colors" can set any of: ', h('span.mono', TOKENS.join(', ')), '. Colors you leave out come from the base.'),
      ta, file,
      h('div.modal-actions',
        h('button.btn.btn-sm', { on: { click: () => file.click() } }, icon('upload'), 'Import file'),
        h('button.btn.btn-sm', { on: { click: () => { ta.value = exportTheme(); } } }, icon('copy'), 'Start from the current theme'),
        h('span.spacer'),
        h('button.btn.btn-sm', { on: { click: () => { adding = false; render(); } } }, 'Cancel'),
        h('button.btn.btn-sm.btn-primary', {
          on: {
            click: () => {
              try { const t = addTheme(parseTheme(ta.value)); applyTheme(t.id); paintTheme(); adding = false; render(); toast(`Added the theme "${t.name}".`, 'ok'); } catch (err) { toast(err.message, 'error'); }
            },
          },
        }, icon('check'), 'Add theme')));
  };
  const render = () => m.set(
    h('h2', 'Appearance'),
    h('p.lead', 'Pick what is easiest on your eyes. It is saved in this browser.'),
    h('div.field', h('label', 'Theme', h('span.help', ' · colors for everything'), h('span.spacer'),
      adding ? null : h('button.btn.btn-xs', { on: { click: () => { adding = true; render(); } } }, icon('plus'), 'Add your own')),
    h('div.theme-grid', ...allThemes().map(themeCard)),
    adding ? addBox() : null),
    ...APPEARANCE.map((g) => h('div.field', h('label', g.label, h('span.help', ` · ${g.help}`)),
      h('div.font-choices', ...g.options.map(([v, name, family]) => h('button.font-choice', {
        type: 'button', 'aria-pressed': String((root.dataset[g.key] || '') === v),
        on: { click: () => { if (v) root.dataset[g.key] = v; else delete root.dataset[g.key]; try { if (v) localStorage.setItem(`recon.${g.key}`, v); else localStorage.removeItem(`recon.${g.key}`); } catch { /* ignore */ } render(); } },
      }, h('b', { style: g.key === 'textSize' ? { fontSize: { small: '14px', '': '17px', large: '20px', xl: '23px' }[v] } : { fontFamily: family ? `'${family}', ${family === 'Georgia' ? 'serif' : family === 'system-ui' ? 'sans-serif' : 'inherit'}` : 'inherit' } }, g.key === 'textSize' ? 'Aa' : 'Recon 0x5f'), h('small', name)))))),
    h('div.modal-actions',
      h('button.btn', { on: { click: () => { applyTheme('dark'); paintTheme(); for (const g of APPEARANCE) { delete root.dataset[g.key]; try { localStorage.removeItem(`recon.${g.key}`); } catch { /* ignore */ } } render(); } } }, 'Reset'),
      h('span.spacer'),
      h('button.btn.btn-primary', { on: { click: () => m.close() } }, 'Done')),
  );
  render();
}

// ---------- modules ----------

const map = createMap({
  stage: $('stage'), world: $('world'), edges: $('edges'), nodes: $('nodes'), markers: $('markers'), expandLayer: $('expand-layer'),
});
const boards = createBoards($('board'));
const sidebar = createSidebar($('sidebar'));

let view = 'map';
let sidebarOpen = (() => { try { const v = localStorage.getItem('recon.sidebar'); return v === null ? innerWidth > 1100 : v === '1'; } catch { return true; } })();

function setSidebar(open) {
  sidebarOpen = open;
  app.classList.toggle('sidebar-open', open);
  $('sidebar-btn').setAttribute('aria-pressed', String(open));
  try { localStorage.setItem('recon.sidebar', open ? '1' : '0'); } catch { /* ignore */ }
  if (open) sidebar.render();
}

function setView(v) {
  if (!VIEWS.some((x) => x.id === v)) return;
  view = v;
  const isBoard = v !== 'map';
  app.classList.toggle('view-board', isBoard);
  $('board').hidden = !isBoard;
  map.hide(isBoard);
  if (isBoard) { map.collapse(); boards.mount(v); } else { boards.unmount(); map.render(); }
  renderToolbar();
  renderHint();
  try { history.replaceState(null, '', v === 'map' ? location.pathname : `#${v}`); } catch { /* ignore */ }
}

function renderToolbar() {
  const nav = $('views');
  const agents = list('agent').length;
  const counts = {
    findings: list('finding', (f) => !['fixed', 'disclosed'].includes(f.stage) && f.severity === 'critical').length,
    agents: list('agent').filter((a) => healthOf(a.id).flags.some((f) => ['looping', 'noisy', 'no-output', 'disputed'].includes(f))).length,
  };
  setChildren(nav, ...VIEWS.map((v, i) => [
    i === 1 ? h('span.sep') : null,
    h('button.tool', {
      'aria-pressed': String(view === v.id), 'aria-label': v.label,
      'data-tip': `${v.id === 'agents' && agents > 1 ? 'Swarm' : v.label} — ${v.tip} ( ${v.key} )`,
      on: { click: () => setView(v.id) },
    }, icon(v.icon), h('span.key', v.key), counts[v.id] ? h('span.count', counts[v.id]) : null),
  ]));
}

function renderHint() {
  const hint = $('hint');
  if (view !== 'map') { hint.replaceChildren(); return; }
  setChildren(hint, 'Scroll or pinch to zoom · drag to pan · click anything to open it · ', h('kbd', '?'), ' for help');
}

// ---------- header ----------

function renderHeader() {
  const s = live.state;
  if (!s) return;
  const name = $('project-name');
  if (document.activeElement !== name) name.value = s.project.name;
  $('example-pill').hidden = !s.project.example;
  document.title = `${s.project.name} · recon`;

  const agents = list('agent');
  const p = $('presence');
  setChildren(p, ...agents.slice(0, 6).map((a) => {
    const el = avatar(a);
    if (agentIsWriting(a.id, 1500)) el.classList.add('pulse');
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { setView('map'); setTimeout(() => map.focusAgent(a.id), 30); });
    el.dataset.tip = `${a.name} · ${healthOf(a.id).status}${a.focus ? ` · ${a.focus}` : ''}`;
    return el;
  }), agents.length > 6 ? h('span.avatar', { style: { '--c': 'var(--island-3)', color: 'var(--text)' } }, `+${agents.length - 6}`) : null);
  renderLive();
}

function renderLive() {
  const el = $('live');
  const text = el.querySelector('.live-text');
  el.classList.toggle('on', live.connected);
  el.classList.toggle('off', !live.connected);
  if (!live.connected) { setChildren(text, 'reconnecting…'); return; }
  const listening = list('agent').filter((a) => a.waitingSince);
  const writing = list('agent').filter((a) => !a.waitingSince && agentIsWriting(a.id, 5000));
  if (writing.length) setChildren(text, h('b', writing.map((a) => a.name).join(', ')), writing.length > 1 ? ' are working' : ' is working');
  else if (listening.length) setChildren(text, h('b', listening.map((a) => a.name).join(', ')), listening.length > 1 ? ' are listening' : ' is listening', ' · write in Talk');
  else {
    const last = live.state.activity[live.state.activity.length - 1];
    setChildren(text, 'live', last ? ` · last change ${short(last.at)}` : '');
  }
}

function short(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function beat() {
  const el = $('live');
  el.classList.remove('beat');
  void el.offsetWidth;
  el.classList.add('beat');
}

// ---------- banner & welcome ----------

function renderBanner() {
  const b = $('banner');
  const s = live.state;
  app.classList.toggle('has-banner', Boolean(s?.project.example));
  if (!s?.project.example) { b.hidden = true; return; }
  const paused = s.project.demoPaused;
  b.hidden = false;
  setChildren(b,
    h('span.hand', 'example'),
    h('span', h('b', 'Scout'), paused ? ' (a simulated agent) is paused.' : ' is a simulated agent working this example live.'),
    h('button.btn.btn-sm', { on: { click: async () => { try { await patch('/api/project', { demoPaused: !paused }); } catch (e) { toast(e.message, 'error'); } } } }, icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause'),
    h('button.btn.btn-sm.btn-primary', { on: { click: startOwn } }, icon('target'), 'Start my own'));
}

function welcome() {
  try { if (localStorage.getItem('recon.welcomed')) return; } catch { /* ignore */ }
  if (!live.state?.project.example) return;
  const close = () => { el.remove(); try { localStorage.setItem('recon.welcomed', '1'); } catch { /* ignore */ } };
  const el = h('div.welcome',
    h('button.tool.sm.close', { 'aria-label': 'Close', on: { click: close } }, icon('x')),
    h('h3', 'Welcome to recon'),
    h('p', 'This is where you and your agents hunt bugs together. This example engagement is being worked live by Scout, a simulated agent.'),
    h('ol',
      h('li', h('b', 'Zoom out'), ' to see the whole hunt. Hatched tiles are parts nobody has looked at.'),
      h('li', h('b', 'Click a tile'), ' to see the agent\'s evidence, then verify or dispute it.'),
      h('li', h('b', 'Leave a steer'), ' and watch Scout acknowledge it, then report back.')),
    h('div.actions',
      h('button.btn.btn-primary', { on: { click: () => { close(); startOwn(); } } }, icon('target'), 'Start my own hunt'),
      h('button.btn', { on: { click: close } }, 'Keep exploring')));
  app.append(el);
}

async function startOwn() {
  const name = h('input.input', { placeholder: 'e.g. Acme audit, May bounty run', value: '' });
  const m = modal([
    h('div.steps', h('span.on'), h('span'), h('span')),
    h('h2', 'Start a new hunt'),
    h('p.lead', 'Three quick steps: name a target, pick what kind of protocol it is, connect your agent. The example stays in your engagements list; nothing is deleted.'),
    h('div.field', h('label', 'Hunt name (usually the project)'), name),
    h('div.modal-actions', h('button.btn', { on: { click: () => m.close() } }, 'Cancel'),
      h('button.btn.btn-primary', {
        on: {
          click: async () => {
            try {
              await post('/api/reset', { mode: 'empty', name: name.value.trim() || 'New engagement' });
              m.close();
              setView('map');
              newTarget({ onDone: () => setTimeout(() => openConnect(), 300) });
            } catch (e) { toast(e.message, 'error'); }
          },
        },
      }, 'Next', icon('arrow'))),
  ]);
  name.focus();
}

// ---------- menu ----------

function openMenu(anchor) {
  menu(anchor, [
    { label: 'Add' },
    { text: 'Target', icon: 'target', action: () => newItem('target') },
    { text: 'Component', icon: 'coverage', action: () => newItem('component') },
    { text: 'Assumption', icon: 'sticky', action: () => newItem('assumption') },
    { text: 'Hypothesis', icon: 'flask', action: () => newItem('hypothesis') },
    { text: 'Finding', icon: 'bug', action: () => newItem('finding') },
    { text: 'Open thread', icon: 'compass', action: () => newItem('lead') },
    '-',
    { text: 'Hunts…', icon: 'clock', shortcut: 'E', action: openEngagements },
    { text: 'Report…', icon: 'file', shortcut: 'R', action: openReport },
    { text: 'Skills…', icon: 'book', shortcut: 'K', action: () => openSkills() },
    { text: 'Appearance: theme, fonts, size…', icon: 'sun', action: openAppearance },
    { text: 'Connect an agent', icon: 'plug', shortcut: 'C', action: () => openConnect() },
    { text: 'Export project (JSON)', icon: 'download', action: exportProject },
    { text: 'Import project…', icon: 'upload', action: importProject },
    '-',
    { text: 'Start a new engagement', icon: 'target', action: startOwn },
    { text: 'Load the example', icon: 'refresh', action: loadExample },
    { text: theme() === 'dark' ? 'Light theme' : 'Dark theme', icon: theme() === 'dark' ? 'sun' : 'moon', action: () => setTheme(theme() === 'dark' ? 'light' : 'dark') },
    { text: 'Help & glossary', icon: 'help', shortcut: '?', action: openHelp },
  ]);
}

async function exportProject() {
  try {
    const data = await get('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(live.state.project.name)}-${new Date().toISOString().slice(0, 10)}.recon.json` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Exported. Keep it somewhere safe: it may contain undisclosed findings.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

function importProject() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const doc = JSON.parse(await file.text());
      const ok = await confirmDialog('Replace this project?', `"${doc.project?.name || file.name}" replaces everything currently on the board.`, { ok: 'Replace', danger: true });
      if (!ok) return;
      await post('/api/import', doc);
      toast('Imported.', 'ok');
    } catch (e) { toast(`Could not import: ${e.message}`, 'error'); }
  });
  input.click();
}

async function loadExample() {
  const ok = await confirmDialog('Load the example?', 'This replaces the current project with the example engagement. Export first if you want to keep it.', { ok: 'Load example', danger: true });
  if (!ok) return;
  try { await post('/api/reset', { mode: 'example' }); } catch (e) { toast(e.message, 'error'); }
}

async function openHelp() {
  const { glossary } = await loadGlossary();
  const terms = Object.entries(glossary).sort(([a], [b]) => a.localeCompare(b));
  modal([
    h('h2', 'How recon works'),
    h('p.lead', 'You and your agents share one board. Agents do the tireless scanning and record what they find with evidence. You verify or dispute their claims and steer them with signals they pick up without stopping. Every change shows up live, attributed to whoever made it.'),
    h('div.row-fields', { style: { alignItems: 'start' } },
      h('div', h('div.sec-label', 'Keys'), h('div.kbd-grid',
        h('kbd', '1–7'), h('span', 'Map, Architecture, Coverage, Assumptions, Hypotheses, Findings, Agents'),
        h('kbd', 'F'), h('span', 'Fit the whole map'),
        h('kbd', '+ / −'), h('span', 'Zoom'),
        h('kbd', 'Space'), h('span', 'Hold and drag to pan'),
        h('kbd', '['), h('span', 'Toggle the side panel'),
        h('kbd', 'C'), h('span', 'Connect an agent'),
        h('kbd', 'E'), h('span', 'Hunts: one per project, saved, with snapshots'),
        h('kbd', 'R'), h('span', 'The report'),
        h('kbd', 'K'), h('span', 'Skills: your instructions for agents'),
        h('kbd', 'N'), h('span', 'Add something'),
        h('kbd', 'Esc'), h('span', 'Close'))),
      h('div', h('div.sec-label', 'Colors'), h('div.kbd-grid',
        h('span.sw', { style: { width: '14px', height: '14px', borderRadius: '4px', background: 'repeating-linear-gradient(-45deg, var(--st-untouched) 0 1.5px, transparent 1.5px 5px)' } }), h('span', 'Untouched: nobody looked'),
        h('span.sw', { style: { width: '14px', height: '14px', borderRadius: '4px', background: 'var(--st-scanning)' } }), h('span', 'Scanning: being looked at'),
        h('span.sw', { style: { width: '14px', height: '14px', borderRadius: '4px', background: 'var(--st-reviewed)' } }), h('span', 'Reviewed: nothing found'),
        h('span.sw', { style: { width: '14px', height: '14px', borderRadius: '4px', background: 'var(--st-flagged)' } }), h('span', 'Flagged: something smells')))),
    h('div.sec-label', { style: { marginTop: '18px' } }, 'Glossary'),
    h('dl.glossary', ...terms.flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
  ], { wide: true });
}

function newMenu(anchor) {
  menu(anchor || $('menu-btn'), [
    { label: 'Add' },
    { text: 'Target', icon: 'target', action: () => newItem('target') },
    { text: 'Component', icon: 'coverage', action: () => newItem('component') },
    { text: 'Assumption', icon: 'sticky', action: () => newItem('assumption') },
    { text: 'Hypothesis', icon: 'flask', action: () => newItem('hypothesis') },
    { text: 'Finding', icon: 'bug', action: () => newItem('finding') },
  ]);
}

function askKey() {
  if (topModal()?.el.dataset.auth) return;
  const input = h('input.input.mono', { type: 'password', placeholder: 'your recon key', autofocus: true });
  const m = modal([
    h('h2', 'This hub needs a key'),
    h('p.lead', 'It is running in server mode. Paste the key you set with RECON_KEY. It is stored in this browser only.'),
    h('form', {
      on: { submit: (e) => { e.preventDefault(); setKey(input.value.trim()); m.close(); location.reload(); } },
    }, input, h('div.modal-actions', h('button.btn.btn-primary', { type: 'submit' }, 'Unlock'))),
  ]);
  m.el.dataset.auth = '1';
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recon';
}

// ---------- navigation ----------

const BOARD_FOR = { chain: 'findings', relation: 'architecture', component: 'coverage', assumption: 'assumptions', hypothesis: 'hypotheses', finding: 'findings', agent: 'agents', target: 'coverage' };

function open(id) {
  const item = byId(id);
  if (!item) { toast('That item no longer exists.'); return; }
  if (item.kind === 'steer') { setSidebar(true); sidebar.select('steers'); return; }
  if (item.kind === 'proposal') { setSidebar(true); sidebar.select('next'); return; }
  if (item.kind === 'lead') { setSidebar(true); sidebar.select('threads'); return; }
  if (item.kind === 'message') { setSidebar(true); sidebar.select('talk'); return; }
  if (view === 'map' && map.has(id)) { map.expand(id); return; }
  if (view === 'architecture' && ['component', 'relation', 'assumption'].includes(item.kind)) { boards.open(id); return; }
  const board = BOARD_FOR[item.kind];
  if (item.kind === 'target' && view === 'map') { map.expand(id); return; }
  if (view !== board) setView(board);
  boards.open(id);
}

Object.assign(bus, {
  open,
  view: setView,
  newItem: (kind, defaults) => newItem(kind, defaults),
  connect: () => openConnect(),
  sidebar: (tab) => { setSidebar(true); sidebar.select(tab); },
  report: () => openReport(),
  skills: () => openSkills(),
  engagements: () => openEngagements(),
  focusAgent: (id) => map.focusAgent(id),
});

// ---------- live wiring ----------

let raf = null;
let pendingFull = true;

function schedule(full = false) {
  pendingFull = pendingFull || full;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    const full2 = pendingFull;
    pendingFull = false;
    renderHeader();
    renderToolbar();
    if (view === 'map') map.render(); else boards.render();
    if (sidebarOpen) sidebar.render();
    if (full2) renderBanner();
  });
}

on((evt) => {
  switch (evt.type) {
    case 'hello':
      schedule(true);
      setTimeout(welcome, 600);
      if (location.hash) setView(location.hash.slice(1));
      break;
    case 'reset':
      map.collapse();
      schedule(true);
      break;
    case 'change':
      beat();
      notify(evt);
      if (evt.kind === 'finding' || evt.kind === 'chain') sidebar.refreshReport();
      schedule();
      break;
    case 'project':
      sidebar.refreshReport();
      schedule(true);
      break;
    case 'auth':
      askKey();
      break;
    case 'hunt-activity':
      huntToast(evt);
      break;
    default:
      schedule();
  }
});

// Surface the round trip: when an agent acks or answers you, or proposes something.
function notify({ kind, item, prev, activity }) {
  if (!activity || activity.by?.startsWith('human')) return;
  if (kind === 'steer' && prev && prev.state !== item.state && item.createdBy?.startsWith('human')) {
    if (item.state === 'acknowledged') toast(`${authorName(activity.by)} saw your steer${item.note ? `: "${truncateText(item.note, 50)}"` : ''}`);
    if (item.state === 'addressed') toast(`${authorName(activity.by)} reported back: ${truncateText(item.response || 'done', 80)}`, 'ok');
  }
  if (kind === 'proposal' && !prev) toast(`${authorName(activity.by)} proposes: ${truncateText(item.text, 80)} — open Next to answer`);
  if (kind === 'agent' && !prev) toast(`${item.name} connected over ${item.transport}`, 'ok');
  if (kind === 'message' && !prev && sidebar.tab !== 'talk') toast(`${authorName(activity.by)}: ${truncateText(item.text, 90)} — open Talk to answer`);
}

// An agent is working in a hunt that is not on screen: offer to switch, at most once a minute per hunt.
const huntToasts = new Map();
function huntToast({ hunt, agent, activity }) {
  if (!hunt || Date.now() - (huntToasts.get(hunt.id) || 0) < 60_000) return;
  huntToasts.set(hunt.id, Date.now());
  const t = h('div.toast', icon('target'), h('span', h('b', agent), ` is working in the hunt "${hunt.name}": ${truncateText(activity?.summary || '', 60)}`),
    h('button.btn.btn-xs.btn-primary', { on: { click: async () => { await post(`/api/engagements/${hunt.id}/open`); t.remove(); } } }, 'Switch'));
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 9000);
}

function truncateText(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

setInterval(() => { if (live.state) { renderLive(); if (view === 'map') map.render(); } }, 2500);

// ---------- events ----------

$('menu-btn').addEventListener('click', (e) => openMenu(e.currentTarget));
$('sidebar-btn').addEventListener('click', () => setSidebar(!sidebarOpen));
$('connect-btn').addEventListener('click', () => openConnect());
$('help-btn').addEventListener('click', openHelp);
$('theme-btn').addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark'));
$('project-name').addEventListener('change', async (e) => {
  const v = e.target.value.trim();
  if (!v) { e.target.value = live.state.project.name; return; }
  try { await patch('/api/project', { name: v }); } catch (err) { toast(err.message, 'error'); }
});
// Quick hunt switcher next to the title.
$('engagements-btn')?.addEventListener('click', async (e) => {
  const anchor = e.currentTarget;
  let r;
  try { r = await get('/api/engagements'); } catch (err) { toast(err.message, 'error'); return; }
  const recent = r.engagements.filter((x) => !x.archived).slice(0, 8);
  menu(anchor, [
    { label: 'Hunts' },
    ...recent.map((x) => ({
      text: `${x.id === r.current ? '● ' : ''}${x.name}`, icon: x.example ? 'sparkle' : 'target',
      sub: `${x.stats?.findings ?? 0} findings · ${x.stats?.agents ?? 0} agents`,
      action: async () => { if (x.id !== r.current) { await post(`/api/engagements/${x.id}/open`); toast(`Opened "${x.name}".`, 'ok'); } },
    })),
    '-',
    { text: 'New hunt…', icon: 'plus', action: startOwn },
    { text: 'All hunts and snapshots…', icon: 'clock', shortcut: 'E', action: openEngagements },
  ]);
});
$('project-name').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); });

for (const b of document.querySelectorAll('[data-zoom]')) {
  b.addEventListener('click', () => {
    if (view !== 'map') setView('map');
    const z = b.dataset.zoom;
    if (z === 'in') map.camera.zoomBy(1.25);
    if (z === 'out') map.camera.zoomBy(0.8);
    if (z === 'reset') map.camera.resetZoom();
    if (z === 'fit') map.fit();
  });
}

addEventListener('keydown', (e) => {
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape' && isTyping(e)) e.target.blur();
    return;
  }
  const m = topModal();
  if (e.key === 'Escape') {
    closePopover();
    if (m) { m.close(); return; }
    if (map.expandedId) { map.collapse(); return; }
    if (view !== 'map') { setView('map'); return; }
    return;
  }
  if (m) return;
  const v = VIEWS.find((x) => x.key === e.key);
  if (v) { setView(v.id); return; }
  switch (e.key) {
    case 'f': case 'F': if (view === 'map') map.fit(); break;
    case '+': case '=': if (view === 'map') map.camera.zoomBy(1.25); break;
    case '-': case '_': if (view === 'map') map.camera.zoomBy(0.8); break;
    case '[': setSidebar(!sidebarOpen); break;
    case 'c': case 'C': openConnect(); break;
    case 'e': case 'E': openEngagements(); break;
    case 'r': case 'R': openReport(); break;
    case 'k': case 'K': openSkills(); break;
    case 'n': case 'N': newMenu($('menu-btn')); break;
    case '?': openHelp(); break;
    default:
  }
});

addEventListener('resize', () => schedule());

// ---------- boot ----------

paintIcons();
initTooltips();
setSidebar(sidebarOpen);
renderToolbar();
renderHint();
loadGlossary().then(({ glossary }) => setGlossary(glossary));
connect();

