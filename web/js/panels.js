// Two modals: the report slot, and the list of hunts (long-lived sessions, one per project).

import { h, icon, modal, toast, setChildren, confirmDialog, ago } from './ui.js';
import { get, patch, post, del, list, api, on, authorName } from './state.js';
import { openSteerComposer } from './steer.js';
import { SEVERITY } from './labels.js';

// ---------- report ----------
// The human sets the slot once (shape, where, which skill writes it, whose name
// signs it); an agent writes the prose from that skill and submits it here.

export async function openReport() {
  let off = () => {};
  const m = modal([h('div.empty', h('span.spinner'))], { wide: true, onClose: () => off() });
  m.el.style.width = 'min(1080px, 100%)';
  let r;
  let skills = [];
  let docIdx = 0;
  const load = async () => {
    [r, { skills }] = await Promise.all([get('/api/report'), get('/api/skills')]);
    render();
  };
  const set = async (fields) => { try { r = await patch('/api/report', fields); render(); } catch (err) { toast(err.message, 'error'); } };
  // re-render when an agent submits while the window is open
  off = on((e) => { if (e.type === 'project' && document.body.contains(m.el)) get('/api/report').then((x) => { r = x; render(); }).catch(() => {}); });

  function render() {
    const cfg = r.config;
    const shape = cfg.shape;
    const findings = list('finding');
    const include = new Set(cfg.includeIds?.length ? cfg.includeIds : findings.map((f) => f.id));
    const reportSkills = skills.filter((x) => x.use === 'report');
    const skill = skills.find((x) => x.id === cfg.skill) || reportSkills[0] || skills[0];
    const pathInput = h('input.input.mono', { value: cfg.path || '', placeholder: shape === 'separate' ? 'reports/acme/ (a folder)' : 'reports/acme-disclosure.txt' });
    pathInput.addEventListener('change', () => set({ path: pathInput.value.trim() }));
    const signInput = h('input.input', { value: cfg.signOff || '', placeholder: 'e.g. Iyke' });
    signInput.addEventListener('change', () => set({ signOff: signInput.value.trim() }));
    const docs = r.documents;
    const doc = docs[Math.min(docIdx, Math.max(0, docs.length - 1))];
    const written = docs.filter((d) => d.written);

    const ask = (e) => openSteerComposer(e.currentTarget, {
      action: 'note', to: ['all'],
      text: `${written.length ? 'Rewrite' : 'Write'} the disclosure report: call recon_write_report, follow the "${skill?.name || 'Disclosure report'}" skill it returns, then submit with recon_submit_report.`,
    });

    const status = !shape ? 'Choose a shape first.'
      : !r.included.length ? 'No finding passes every check yet, so there is nothing to write.'
        : !cfg.signOff ? 'Add the name that signs it, then ask an agent to write it.'
          : r.missing.length ? `${r.missing.length} document${r.missing.length === 1 ? '' : 's'} still to write.`
            : r.stale.length ? 'Findings changed after it was written: ask for a rewrite.' : 'Written and up to date.';

    m.set(
      h('h2', 'Report'),
      h('p.lead', 'Decide once how the disclosure goes out. An agent writes it in plain prose following your report skill, and only findings that pass every check go in.'),
      h('div.report-grid',
        h('div',
          h('div.field', h('label', 'Shape'),
            h('div.choice-grid', { style: { gridTemplateColumns: '1fr' } },
              h('button.choice', { type: 'button', 'aria-pressed': String(shape === 'combined'), on: { click: () => set({ shape: 'combined' }) } },
                h('b', 'One combined document'), h('small', 'Each finding gets its own paragraphs and its own honest severity.')),
              h('button.choice', { type: 'button', 'aria-pressed': String(shape === 'separate'), on: { click: () => set({ shape: 'separate' }) } },
                h('b', 'One report per finding'), h('small', 'For programs that want one vulnerability per submission.')))),
          h('div.field', h('label', 'Written following'),
            h('div.row-gap',
              h('select.input', { on: { change: (e) => set({ skill: e.target.value }) } },
                ...(reportSkills.length ? reportSkills : skills).map((x) => h('option', { value: x.id, selected: x.id === skill?.id }, x.name))),
              h('button.btn.btn-sm', { on: { click: () => openSkills(skill?.id) } }, icon('book'), 'Open')),
            h('span.help', 'The skill is the agent\'s system prompt while it writes. Edit it, or add your own, under Skills.')),
          h('div.field', h('label', 'Signed by'), signInput),
          h('div.field', h('label', 'Where the agent saves it'), pathInput, h('span.help', 'A path on the agent\'s machine. Leave empty and download it from here.')),
          h('div.field', h('label', 'Candidates'),
            findings.length ? h('div.list-editor', ...findings.map((f) => h('label.li', { style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: include.has(f.id),
                on: { change: (e) => { if (e.target.checked) include.add(f.id); else include.delete(f.id); set({ includeIds: include.size === findings.length ? [] : [...include] }); } },
              }), h('span', h('b', { style: { color: SEVERITY[f.severity].color, fontWeight: 600 } }, `${f.severity} `), f.title)))) : h('div.prose.muted', 'No findings yet.')),
          r.excluded.length ? h('div.field', h('label', `Left out (${r.excluded.length})`),
            h('ul.excluded', { style: { paddingLeft: '16px', margin: 0 } }, ...r.excluded.map((x) => h('li', h('b', x.title), h('br'), x.reasons.join('; '))))) : null),
        h('div',
          docs.length ? h('div.report-files', ...docs.map((d, i) => h('button.filter', { 'aria-pressed': String(d === doc), on: { click: () => { docIdx = i; render(); } } },
            d.name, d.written ? (d.stale ? h('span.pill.pill-warn', 'out of date') : null) : h('span.pill', 'not written')))) : null,
          doc?.written
            ? (doc.fields?.length
              ? h('div.report-prose', ...doc.fields.map((f) => h('div.report-field', h('div.sec-label', f.label), ...paras(f.value))))
              : h('div.report-prose', ...paras(doc.body)))
            : h('div.report-prose.empty-prose',
              h('p', h('b', status)),
              h('p', 'When it is ready, an agent calls recon_write_report. It gets your skill as its instructions and every fact the skill asks for from the board: the confirmation card, evidence, suggested fix, what was checked and held, what was not reviewed, scope and the disclosure channel. It writes the report and submits it; anything that breaks the skill, like markdown or a missing severity up front, is sent back to fix.')),
          h('div.modal-actions',
            h('span.verify-note', doc?.written ? `Written ${ago(doc.at)} by ${authorName(doc.by)}` : status),
            h('span.spacer'),
            shape && r.included.length ? h(`button.btn${doc?.written && !doc.stale ? '' : '.btn-primary'}`, { on: { click: ask } }, icon('send'), written.length ? 'Ask for a rewrite' : 'Ask an agent to write it') : null,
            doc?.written ? h('button.btn', { on: { click: () => { navigator.clipboard.writeText(doc.body).then(() => toast('Copied.', 'ok'), () => toast('Could not copy.', 'error')); } } }, icon('copy'), 'Copy') : null,
            written.length ? h('button.btn.btn-primary', { on: { click: () => download(written.map((d) => ({ name: d.name, body: d.body }))) } }, icon('download'), written.length > 1 ? `Download ${written.length}` : 'Download') : null))),
    );
  }

  try { await load(); } catch (err) { toast(err.message, 'error'); m.close(); off(); }
  return m;
}

const paras = (text) => String(text || '').split(/\n{2,}/).map((p) => h('p', p.trim()));

function download(files) {
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(new Blob([`${f.body}\n`], { type: 'text/plain' })), download: f.name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
}

// ---------- skills ----------
// Reusable instructions kept on this machine and offered to every agent in every
// hunt. Stored as SKILL.md folders, so Claude skills can be imported as they are.

export async function openSkills(focusId) {
  const m = modal([h('div.empty', h('span.spinner'))], { wide: true });
  m.el.style.width = 'min(1080px, 100%)';
  let skills = [];
  let reportSkill = '';
  let sel = focusId || null;
  let draft = null; // a new, unsaved skill

  const load = async () => { ({ skills, reportSkill } = await get('/api/skills')); if (!draft && !skills.some((x) => x.id === sel)) sel = skills[0]?.id || null; render(); };

  const importFile = () => {
    const input = h('input', { type: 'file', accept: '.md,text/markdown,text/plain', multiple: true });
    input.addEventListener('change', async () => {
      let n = 0;
      for (const file of input.files) {
        try {
          const text = await file.text();
          const base = file.name.replace(/\.md$/i, '');
          const s = await post('/api/skills', { text, name: /^---[\s\S]*?\bname:/m.test(text) ? undefined : (/^skill$/i.test(base) ? '' : base) });
          sel = s.id; n++;
        } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
      }
      if (n) toast(`Imported ${n} skill${n === 1 ? '' : 's'}.`, 'ok');
      draft = null;
      load();
    });
    input.click();
  };

  function render() {
    const cur = draft || skills.find((x) => x.id === sel);
    const name = h('input.input', { value: cur?.name || '', placeholder: 'e.g. Lending audit' });
    const desc = h('input.input', { value: cur?.description || '', placeholder: 'One line: when an agent should use it' });
    const use = h('select.input', h('option', { value: 'general', selected: cur?.use !== 'report' }, 'General: agents follow it when it fits'), h('option', { value: 'report', selected: cur?.use === 'report' }, 'Report: the system prompt for writing reports'));
    const body = h('textarea.textarea.skill-body', { rows: 18, placeholder: 'The instructions, written to the agent.' });
    body.value = cur?.body || '';
    const save = async () => {
      const fields = { name: name.value.trim(), description: desc.value.trim(), use: use.value, body: body.value };
      try {
        const s = draft ? await post('/api/skills', fields) : await api('PUT', `/api/skills/${encodeURIComponent(cur.id)}`, fields);
        draft = null; sel = s.id; toast('Saved. Agents see it from their next briefing.', 'ok'); load();
      } catch (err) { toast(err.message, 'error'); }
    };
    const remove = async () => {
      const builtin = cur.builtin;
      const q = builtin ? (cur.edited ? [`Restore "${cur.name}" to the original?`, 'Your edits move to the trash in the skills folder.', 'Restore'] : [`Hide "${cur.name}"?`, 'It is built in; editing it later brings it back.', 'Hide']) : [`Remove "${cur.name}"?`, 'It moves to the trash in the skills folder; it is not erased.', 'Remove'];
      if (!(await confirmDialog(q[0], q[1], { ok: q[2], danger: !builtin }))) return;
      try { await del(`/api/skills/${encodeURIComponent(cur.id)}`); load(); } catch (err) { toast(err.message, 'error'); }
    };
    m.set(
      h('h2', 'Skills'),
      h('p.lead', 'Instructions you keep for your agents: how you want reports written, how you audit a kind of protocol, your house rules. Every agent in every hunt sees the list in its briefing and can open one; the report skill is its system prompt while it writes the report. Import any Claude SKILL.md as it is.'),
      h('div.skills-grid',
        h('div.skill-list',
          ...skills.map((x) => h(`button.skill-item${!draft && x.id === sel ? '.on' : ''}`, { on: { click: () => { draft = null; sel = x.id; render(); } } },
            h('b', x.name, x.use === 'report' ? h('span.pill', { style: { marginLeft: '6px' } }, x.id === reportSkill ? 'writes reports' : 'report') : null),
            h('small', x.description || 'No description'))),
          draft ? h('button.skill-item.on', h('b', 'New skill'), h('small', 'Not saved yet')) : null,
          h('div.row-gap', { style: { marginTop: '8px' } },
            h('button.btn.btn-sm', { on: { click: () => { draft = { name: '', description: '', use: 'general', body: '' }; render(); } } }, icon('plus'), 'New'),
            h('button.btn.btn-sm', { on: { click: importFile } }, icon('upload'), 'Import SKILL.md'))),
        cur ? h('div.skill-edit',
          h('div.row-2', h('div.field', h('label', 'Name'), name), h('div.field', h('label', 'Used for'), use)),
          h('div.field', h('label', 'Description'), desc),
          h('div.field', h('label', 'Instructions'), body),
          h('div.modal-actions',
            h('span.verify-note', draft ? 'New skill' : cur.builtin ? (cur.edited ? 'Built in, edited by you' : 'Built in') : `Saved as skills/${cur.id}/SKILL.md`),
            h('span.spacer'),
            !draft && (!cur.builtin || cur.edited) ? h('button.btn.btn-danger', { on: { click: remove } }, icon(cur.builtin ? 'refresh' : 'trash'), cur.builtin ? 'Restore original' : 'Remove') : null,
            h('button.btn.btn-primary', { on: { click: save } }, icon('check'), 'Save'))) : h('div.empty', 'No skills yet.')),
    );
  }

  try { await load(); } catch (err) { toast(err.message, 'error'); m.close(); }
  return m;
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
      h('h2', 'Hunts'),
      h('p.lead', 'One hunt per project, saved as you work and kept until you remove it. Agents start or resume the hunt for the project they are working in. Close the tab or the laptop; it is all here when you come back, even a year later. Snapshots are taken hourly while things change.'),
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
              await post('/api/engagements', { name: name.value.trim() || 'New hunt', mode: 'empty' });
              m.close();
              toast('Started a new hunt. The previous one is saved.', 'ok');
            },
          },
        }, icon('plus'), 'New hunt')),
    );
    void setChildren;
  }

  await render();
  return m;
}
