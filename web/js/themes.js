// Themes: a theme is a light or dark base plus color tokens laid over it. Five
// come built in, adapted from well-known open palettes; anyone can add their own
// as JSON in Appearance. Saved in this browser.

const KEY = 'recon.themeId';
const CUSTOM = 'recon.themes';

// Every color a theme may set (the CSS variable without "--").
export const TOKENS = [
  'bg', 'dot', 'island', 'island-2', 'island-3', 'border', 'border-strong',
  'text', 'muted', 'faint', 'primary', 'primary-strong', 'primary-bg', 'primary-ghost', 'on-primary', 'stroke',
  'st-untouched', 'st-scanning', 'st-reviewed', 'st-flagged',
  'sev-critical', 'sev-high', 'sev-medium', 'sev-low', 'sev-info',
  'ok', 'bad', 'warn', 'info', 'sticky-bg', 'sticky-fg', 'sticky-border',
];

export const BUILTIN = [
  { id: 'dark', name: 'Recon dark', base: 'dark', note: 'The default', colors: {} },
  { id: 'light', name: 'Recon light', base: 'light', note: 'The default, light', colors: {} },
  {
    id: 'nord', name: 'Nord', base: 'dark', note: 'Arctic, calm blues', source: 'https://www.nordtheme.com',
    colors: {
      bg: '#2e3440', dot: '#3b4252', island: '#3b4252', 'island-2': '#434c5e', 'island-3': '#4c566a', border: '#4c566a', 'border-strong': '#5e6a82',
      text: '#eceff4', muted: '#c2c9d6', faint: '#7b88a1', primary: '#88c0d0', 'primary-strong': '#8fbcbb', 'primary-bg': '#3e5466', 'primary-ghost': 'rgba(136, 192, 208, .14)', 'on-primary': '#2e3440', stroke: '#d8dee9',
      'st-untouched': '#7b88a1', 'st-scanning': '#81a1c1', 'st-reviewed': '#a3be8c', 'st-flagged': '#d08770',
      'sev-critical': '#bf616a', 'sev-high': '#d08770', 'sev-medium': '#ebcb8b', 'sev-low': '#81a1c1', 'sev-info': '#a0aab8',
      ok: '#a3be8c', bad: '#bf616a', warn: '#ebcb8b', info: '#81a1c1', 'sticky-bg': '#4a4638', 'sticky-fg': '#ebcb8b', 'sticky-border': '#8a7a4a',
    },
  },
  {
    id: 'dracula', name: 'Dracula', base: 'dark', note: 'High contrast, vivid', source: 'https://draculatheme.com/contribute',
    colors: {
      bg: '#1e1f29', dot: '#2c2e3b', island: '#282a36', 'island-2': '#303341', 'island-3': '#44475a', border: '#44475a', 'border-strong': '#6272a4',
      text: '#f8f8f2', muted: '#c3c5d6', faint: '#7a86b6', primary: '#bd93f9', 'primary-strong': '#d0b3fb', 'primary-bg': '#4b3f6b', 'primary-ghost': 'rgba(189, 147, 249, .15)', 'on-primary': '#1e1f29', stroke: '#f8f8f2',
      'st-untouched': '#6272a4', 'st-scanning': '#8be9fd', 'st-reviewed': '#50fa7b', 'st-flagged': '#ffb86c',
      'sev-critical': '#ff5555', 'sev-high': '#ffb86c', 'sev-medium': '#f1fa8c', 'sev-low': '#8be9fd', 'sev-info': '#a3a7c2',
      ok: '#50fa7b', bad: '#ff5555', warn: '#f1fa8c', info: '#8be9fd', 'sticky-bg': '#3d3b2a', 'sticky-fg': '#f1fa8c', 'sticky-border': '#7f7a3c',
    },
  },
  {
    id: 'mocha', name: 'Catppuccin Mocha', base: 'dark', note: 'Soft pastels on deep blue', source: 'https://catppuccin.com/palette',
    colors: {
      bg: '#11111b', dot: '#1e1e2e', island: '#1e1e2e', 'island-2': '#262637', 'island-3': '#313244', border: '#313244', 'border-strong': '#45475a',
      text: '#cdd6f4', muted: '#a6adc8', faint: '#6c7086', primary: '#cba6f7', 'primary-strong': '#d9bffa', 'primary-bg': '#45385e', 'primary-ghost': 'rgba(203, 166, 247, .14)', 'on-primary': '#11111b', stroke: '#bac2de',
      'st-untouched': '#7f849c', 'st-scanning': '#89b4fa', 'st-reviewed': '#a6e3a1', 'st-flagged': '#fab387',
      'sev-critical': '#f38ba8', 'sev-high': '#fab387', 'sev-medium': '#f9e2af', 'sev-low': '#89dceb', 'sev-info': '#9399b2',
      ok: '#a6e3a1', bad: '#f38ba8', warn: '#f9e2af', info: '#89b4fa', 'sticky-bg': '#3b3628', 'sticky-fg': '#f9e2af', 'sticky-border': '#7d6f45',
    },
  },
  {
    id: 'solarized', name: 'Solarized Light', base: 'light', note: 'Warm paper, low glare', source: 'https://ethanschoonover.com/solarized/',
    colors: {
      bg: '#eee8d5', dot: '#ddd6c1', island: '#fdf6e3', 'island-2': '#f6efdb', 'island-3': '#eee8d5', border: '#e2dbc5', 'border-strong': '#cdc6ae',
      text: '#073642', muted: '#586e75', faint: '#93a1a1', primary: '#268bd2', 'primary-strong': '#1f75b3', 'primary-bg': '#d6e7f2', 'primary-ghost': 'rgba(38, 139, 210, .12)', 'on-primary': '#fdf6e3', stroke: '#586e75',
      'st-untouched': '#93a1a1', 'st-scanning': '#268bd2', 'st-reviewed': '#859900', 'st-flagged': '#cb4b16',
      'sev-critical': '#dc322f', 'sev-high': '#cb4b16', 'sev-medium': '#b58900', 'sev-low': '#2aa198', 'sev-info': '#93a1a1',
      ok: '#859900', bad: '#dc322f', warn: '#b58900', info: '#268bd2', 'sticky-bg': '#f6e7b4', 'sticky-fg': '#5f4c00', 'sticky-border': '#d9c06a',
    },
  },
  {
    id: 'rose-dawn', name: 'Rosé Pine Dawn', base: 'light', note: 'Muted rose and pine', source: 'https://rosepinetheme.com/palette/',
    colors: {
      bg: '#f2e9e1', dot: '#dfdad9', island: '#fffaf3', 'island-2': '#faf4ed', 'island-3': '#f4ede8', border: '#dfdad9', 'border-strong': '#cecacd',
      text: '#575279', muted: '#797593', faint: '#9893a5', primary: '#907aa9', 'primary-strong': '#7d6797', 'primary-bg': '#ebe2f2', 'primary-ghost': 'rgba(144, 122, 169, .13)', 'on-primary': '#fffaf3', stroke: '#575279',
      'st-untouched': '#9893a5', 'st-scanning': '#56949f', 'st-reviewed': '#286983', 'st-flagged': '#d7827e',
      'sev-critical': '#b4637a', 'sev-high': '#d7827e', 'sev-medium': '#ea9d34', 'sev-low': '#56949f', 'sev-info': '#9893a5',
      ok: '#286983', bad: '#b4637a', warn: '#ea9d34', info: '#56949f', 'sticky-bg': '#f6e4c8', 'sticky-fg': '#6e4a12', 'sticky-border': '#ea9d34',
    },
  },
];

export function customThemes() {
  try { return JSON.parse(localStorage.getItem(CUSTOM) || '[]').filter((t) => t && t.id && t.colors); } catch { return []; }
}

export function allThemes() {
  return [...BUILTIN, ...customThemes()];
}

export function currentThemeId() {
  try { return localStorage.getItem(KEY) || document.documentElement.dataset.theme || 'dark'; } catch { return document.documentElement.dataset.theme || 'dark'; }
}

// Apply a theme: its base sets data-theme (light or dark), its colors go on :root.
export function applyTheme(id, { save = true } = {}) {
  const t = allThemes().find((x) => x.id === id) || BUILTIN[0];
  const root = document.documentElement;
  root.dataset.theme = t.base === 'light' ? 'light' : 'dark';
  for (const k of TOKENS) root.style.removeProperty(`--${k}`);
  for (const [k, v] of Object.entries(t.colors || {})) if (TOKENS.includes(k)) root.style.setProperty(`--${k}`, v);
  root.dataset.themeName = t.id;
  if (save) { try { localStorage.setItem(KEY, t.id); localStorage.setItem('recon.theme', root.dataset.theme); } catch { /* ignore */ } }
  return t;
}

const isColor = (v) => typeof v === 'string' && v.length < 80 && (typeof CSS === 'undefined' || CSS.supports('color', v));

// Validate a theme someone pasted: { name, base: "dark"|"light", colors: { bg: "#..", ... } }.
export function parseTheme(text) {
  let t;
  try { t = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw new Error(`not valid JSON: ${e.message}`); }
  if (!t || typeof t !== 'object') throw new Error('a theme is a JSON object');
  const name = String(t.name || '').trim().slice(0, 40);
  if (!name) throw new Error('give the theme a "name"');
  const base = t.base === 'light' ? 'light' : 'dark';
  const colors = {};
  const bad = [];
  for (const [k0, v] of Object.entries(t.colors || {})) {
    const k = k0.replace(/^--/, '');
    if (!TOKENS.includes(k)) { bad.push(`unknown color "${k0}"`); continue; }
    if (!isColor(v)) { bad.push(`"${k0}" is not a color: ${v}`); continue; }
    colors[k] = v;
  }
  if (bad.length) throw new Error(`${bad.slice(0, 4).join('; ')}. Colors you can set: ${TOKENS.join(', ')}`);
  if (!Object.keys(colors).length) throw new Error('set at least one color under "colors"');
  const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme'}`;
  return { id, name, base, colors, custom: true, note: 'Added by you' };
}

export function addTheme(t) {
  const list = customThemes().filter((x) => x.id !== t.id);
  list.push(t);
  localStorage.setItem(CUSTOM, JSON.stringify(list));
  return t;
}

export function removeTheme(id) {
  localStorage.setItem(CUSTOM, JSON.stringify(customThemes().filter((x) => x.id !== id)));
  if (currentThemeId() === id) applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
}

// The theme in use, as JSON someone can copy, edit and add back.
export function exportTheme(id = currentThemeId()) {
  const t = allThemes().find((x) => x.id === id) || BUILTIN[0];
  const css = getComputedStyle(document.documentElement);
  const colors = {};
  for (const k of TOKENS) colors[k] = (t.colors?.[k] || css.getPropertyValue(`--${k}`)).trim();
  return JSON.stringify({ name: `${t.name} (my copy)`, base: t.base, colors }, null, 2);
}
