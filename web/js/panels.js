// Two modals: the report slot, and the list of engagements (long-lived sessions).

import { h, icon, modal, toast, setChildren, confirmDialog, ago } from './ui.js';
import { get, patch, post, del, list } from './state.js';
import { SEVERITY } from './labels.js';

// ---------- report ----------

export async function openReport() {
  const m = modal([h('div.empty', h('span.spinner'))], { wide: true });
  m.el.style.width = 'min(1040px, 100%)';
  let r;
  const load = async () => { r = await get('/api/report'); render(); };
  let fileIdx = 0;

  function render() {
    const cfg = r.config;
    const shape = cfg.shape;
    const pathInput = h('input.input.mono', { value: cfg.path || '', placeholder: shape === 'separate' ? 'reports/acme/ (a folder)' : 'reports/acme-report.md' });
    pathInput.addEventListener('change', async () => { r = await patch('/api/report', { path: pathInput.value.trim() }); render(); });
    const findings = list('finding');
    const include = new Set(cfg.includeIds?.length ? cfg.includeIds : findings.map((f) => f.id));
    const file = r.files[Math.min(fileIdx, r.files.length - 1)];
    m.set(
      h('h2', 'Report'),
      h('p.lead', 'Decide once how the disclosure goes out. The agent writes it there, and only findings that pass every check are included.'),
      h('div.report-grid',
        h('div',
          h('div.field', h('label', 'Shape'),
            h('div.choice-grid', { style: { gridTemplateColumns: '1fr' } },
              h('button.choice', { type: 'button', 'aria-pressed': String(shape === 'combined'), on: { click: async () => { r = await patch('/api/report', { shape: 'combined' }); render(); } } },
                h('b', 'One combined document'), h('small', 'Each bug in its own section with its own severity, bound and test.')),
              h('button.choice', { type: 'button', 'aria-pressed': String(shape === 'separate'), on: { click: async () => { r = await patch('/api/report', { shape: 'separate' }); render(); } } },
                h('b', 'One report per finding'), h('small', 'For programs that want one vulnerability per submission. Cross-linked.')))),
          h('div.field', h('label', 'Where the agent writes it'), pathInput, h('span.help', 'A path on the agent\'s machine. Leave empty to download it from here.')),
          h('div.field', h('label', 'Candidates'),
            h('div.list-editor', ...findings.map((f) => h('label.li', { style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: include.has(f.id),
                on: {
                  change: async (e) => {
                    if (e.target.checked) include.add(f.id); else include.delete(f.id);
                    r = await patch('/api/report', { includeIds: include.size === findings.length ? [] : [...include] });
                    render();
                  },
                },
              }), h('span', h('b', { style: { color: SEVERITY[f.severity].color, fontWeight: 600 } }, `${f.severity} `), f.title))))),
          r.excluded.length ? h('div.field', h('label', `Left out (${r.excluded.length})`),
            h('ul.excluded', { style: { paddingLeft: '16px', margin: 0 } }, ...r.excluded.map((x) => h('li', h('b', x.title), h('br'), x.reasons.join('; '))))) : null),
        h('div',
          h('div.report-files', ...r.files.map((f, i) => h(`button.filter`, { 'aria-pressed': String(i === Math.min(fileIdx, r.files.length - 1)), on: { click: () => { fileIdx = i; render(); } } }, f.name))),
          h('div.report-preview', file?.body || ''),
          h('div.modal-actions',
            h('span.verify-note', `${r.included.length} finding(s) included${cfg.last ? ` · last written ${ago(cfg.last.at)} by ${cfg.last.by}` : ''}`),
            h('span.spacer'),
            h('button.btn', { on: { click: () => { navigator.clipboard.writeText(file?.body || '').then(() => toast('Copied.', 'ok'), () => toast('Could not copy.', 'error')); } } }, icon('copy'), 'Copy'),
            h('button.btn.btn-primary', { on: { click: () => download(r.files) } }, icon('download'), r.files.length > 1 ? `Download ${r.files.length} files` : 'Download')))),
    );
  }

  try { await load(); } catch (err) { toast(err.message, 'error'); m.close(); }
  return m;
}

function download(files) {
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(new Blob([f.body], { type: 'text/markdown' })), download: f.name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
}

// ---------- engagements ----------

export async function openEngagements() {
  const m = modal([h('div.empty', h('span.spinner'))], { wide: true });
  let snapsFor = null;
  let snaps = [];
  let showArchived = false;

  async function render() {
    let r;
    try { r = await get('/api/engagements'); } catch (err) { toast(err.message, 'error'); return; }
    const visible = r.engagements.filter((e) => showArchived || !e.archived || e.id === r.current);
    const name = h('input.input', { placeholder: 'e.g. Acme bounty, June audit' });
    m.set(
      h('h2', 'Engagements'),
      h('p.lead', 'Every engagement on this machine, saved as you work and kept until you remove it. Close the tab or the laptop; it is all here when you come back, even a year later. Snapshots are taken hourly while things change.'),
      h('div.eng-list', ...visible.map((e) => h(`div.eng${e.id === r.current ? '.current' : ''}`,
        h('b', e.name, e.example ? h('span.pill.pill-example', { style: { marginLeft: '8px' } }, 'example') : null, e.archived ? h('span.pill', { style: { marginLeft: '8px' } }, 'archived') : null),
        h('div.acts',
          e.id === r.current ? h('span.pill', 'open now') : h('button.btn.btn-sm.btn-primary', { on: { click: async () => { await post(`/api/engagements/${e.id}/open`); m.close(); toast(`Opened "${e.name}".`, 'ok'); } } }, 'Open'),
          h('button.btn.btn-sm', { 'data-tip': 'Snapshots', on: { click: async () => { snapsFor = e; snaps = await get(`/api/engagements/${e.id}/snapshots`); render(); } } }, icon('clock')),
          h('button.btn.btn-sm', {
            'data-tip': e.archived ? 'Unarchive' : 'Archive (hide from this list)',
            on: { click: async () => { await patch(`/api/engagements/${e.id}`, { archived: !e.archived }); render(); } },
          }, icon(e.archived ? 'upload' : 'download')),
          e.id !== r.current ? h('button.btn.btn-sm.btn-danger', {
            'data-tip': 'Move to trash (recoverable from the data folder)',
            on: { click: async () => { if (await confirmDialog(`Remove "${e.name}"?`, 'It moves to the trash folder in your recon data directory; it is not erased.', { ok: 'Remove', danger: true })) { await del(`/api/engagements/${e.id}`); render(); } } },
          }, icon('trash')) : null),
        h('span.meta', `${e.stats?.targets ?? 0} targets · ${e.stats?.findings ?? 0} findings · ${e.stats?.agents ?? 0} agents · last change ${ago(e.updatedAt)}`)))),
      snapsFor ? h('div', { style: { marginTop: '14px' } },
        h('div.sec-label', icon('clock'), `Snapshots of "${snapsFor.name}"`,
          snapsFor.id === r.current ? h('span.right', h('button.btn.btn-xs', { on: { click: async () => { await post(`/api/engagements/${snapsFor.id}/snapshots`); snaps = await get(`/api/engagements/${snapsFor.id}/snapshots`); render(); } } }, icon('plus'), 'Take one now')) : null),
        snaps.length ? h('div.snap-list', ...snaps.map((x) => h('div.snap', icon('clock'), h('span', `${new Date(x.at).toLocaleString()} · ${ago(x.at)}`),
          h('button.btn.btn-xs', {
            on: {
              click: async () => {
                if (!(await confirmDialog('Restore this snapshot?', 'The current state is snapshotted first, so this can be undone.', { ok: 'Restore' }))) return;
                await post(`/api/engagements/${snapsFor.id}/restore`, { snapshot: x.id });
                if (snapsFor.id !== r.current) await post(`/api/engagements/${snapsFor.id}/open`);
                m.close();
                toast('Restored.', 'ok');
              },
            },
          }, 'Restore')))) : h('div.prose.muted', 'No snapshots yet. They are taken hourly while there are changes, and whenever you switch engagements.')) : null,
      h('div.modal-actions',
        h('label', { style: { fontSize: '12px', color: 'var(--muted)', display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: showArchived, on: { change: (e) => { showArchived = e.target.checked; render(); } } }), 'Show archived'),
        h('span.spacer'), name,
        h('button.btn.btn-primary', {
          on: {
            click: async () => {
              await post('/api/engagements', { name: name.value.trim() || 'New engagement', mode: 'empty' });
              m.close();
              toast('Started a new engagement. The previous one is saved.', 'ok');
            },
          },
        }, icon('plus'), 'New engagement')),
    );
    void setChildren;
  }

  await render();
  return m;
}
