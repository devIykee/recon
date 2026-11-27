// Navigation hooks shared between views. main.js wires the real implementations,
// which keeps feature modules free of circular imports.

export const bus = {
  open: (_id) => {},
  view: (_name) => {},
  newItem: (_kind, _defaults) => {},
  connect: () => {},
  sidebar: (_tab) => {},
};

// Client-side cache of knowledge from the hub.
import { get } from './state.js';

const playbooks = new Map();
let glossaryPromise = null;

export function loadPlaybook(type = 'other') {
  if (!playbooks.has(type)) playbooks.set(type, get(`/api/playbooks/${encodeURIComponent(type)}`).catch(() => null));
  return playbooks.get(type);
}

export function loadGlossary() {
  if (!glossaryPromise) glossaryPromise = get('/api/glossary').catch(() => ({ glossary: {}, classes: {} }));
  return glossaryPromise;
}

let playbookList = null;
export function loadPlaybookList() {
  if (!playbookList) playbookList = get('/api/playbooks').catch(() => []);
  return playbookList;
}
