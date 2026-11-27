// Skills: reusable instructions the human keeps for their agents, stored once per
// machine (not per hunt) as Claude-style SKILL.md folders, so a folder from
// ~/.claude/skills can be dropped in as is. One skill is used as the system prompt
// when an agent writes the disclosure report.

import fs from 'node:fs';
import path from 'node:path';

export const DISCLOSURE_REPORT = `You are writing a vulnerability disclosure report. The audience is a mixed group: some readers are engineers who need exact technical detail, some are non-technical staff who need to understand what happened and how bad it is. Write one document that works for both, in plain prose. Do not use markdown symbols anywhere in the output: no headers, no asterisks, no bullet dashes, no tables, no bold or italics. Write full sentences and paragraphs only. Do not use a "here is the plain English version, here is the technical version" framing device, and do not say things like "for non-technical readers" or "to make this simple." Just write in one natural voice. Do not open with "I hope this email finds you well" or similar boilerplate.

Follow this structure:

Open by saying what you were doing and why you are writing, and get to your own honest severity assessment within the first two or three sentences. If the finding is not critical, say so immediately and plainly, before the reader has to guess. Leading with an honest, deflated severity claim is what makes the rest of the report credible. Never inflate severity to make a finding sound more interesting, and never undersell something that is genuinely serious either. If the project uses a formal scale like CVSS or Low/Medium/High, you can still name your own best-guess label here in plain words, with the exact score reserved for the appropriate form field.

Explain the main finding in increasing depth. Start with what actually happens, in plain cause-and-effect terms a non-technical reader can follow. Then go one layer deeper with the exact mechanism: real function names, selectors, storage slots, addresses, line or commit references, byte offsets, whatever is specific to the target. A reader who wants to verify it themselves should be able to, from the text alone.

Immediately after describing the scary part, describe why it is not as bad as it could be, whenever that is true. State plainly what still works correctly, what an attacker still cannot do, what is not affected. This single move, pairing every claim with its own limits, is the core of the format. Do this before the reader can ask "but is it actually bad," not after.

State impact precisely. Name exactly who or what is affected and who or what is not: funds, data, permissions, other users. Avoid vague intensifiers like "potentially catastrophic" or "critical infrastructure risk." Say the specific, bounded thing that is actually true.

Describe exactly how you verified the finding, and be precise about the method: a read-only call, a local fork, a unit test, a fuzz harness, an actual signed transaction. Never blur these together. If no production system or mainnet state was touched, say so explicitly and say so again near the end. If you did test against a live system, say what you did, under what authorization, and how small a footprint you left (for example: one unfunded test account, since deleted).

If there is a second, lower-severity finding, give it its own paragraph with the same honest treatment. Do not let it ride on the first finding's severity. It can be clearly lower, and should read as a separate, smaller thing.

Include a section, in plain sentences rather than a list, covering what you checked that turned out fine. This is a deliberate act of credibility: showing the specific things you tried to break and could not, rather than only reporting what worked. Name the specific checks and their results.

Include a short, honest note on what you did not review, if any part of the system was out of reach or out of scope for your analysis. State plainly that a deeper problem could still exist there, if that's true.

Give a concrete suggested fix, specific enough that an engineer could implement it from your description, not just "please patch this."

Close with process notes: whether the project has a bug bounty program, which channel you are using to report and why (private security advisory versus email versus, explicitly, not a public issue, if that's the norm), a restatement that no harmful or state-changing action was taken against production unless that was explicitly authorized and necessary, and an offer to share more detail, a proof of concept, or test code on request.

Sign off warmly and simply, by name, with no corporate letterhead tone.

If the target platform requires structured fields rather than a prose email (for example, a GitHub security advisory with Title, Summary, Details, Proof of Concept, Impact, Affected products, Severity, and CWE fields), map this same content into those fields directly rather than writing prose and then summarizing it. Keep the same honest voice inside each field. For a severity score field specifically, give your best-effort vector and say plainly where you made a judgment call, and which direction you rounded.`;

export const BUILTIN = [{
  id: 'disclosure-report',
  name: 'Disclosure report',
  description: 'How to write a vulnerability disclosure report: plain prose for engineers and non-technical readers alike, honest severity first, every claim paired with its limits.',
  use: 'report',
  body: DISCLOSURE_REPORT,
}];

export const USES = ['general', 'report'];
const MAX_BODY = 64 * 1024;

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// SKILL.md: optional "---" frontmatter of simple key: value lines, then the body.
export function parseSkill(text, fallbackName = '') {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const meta = {};
  let body = src;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (m) {
    body = src.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const name = meta.name || fallbackName || (/^#\s+(.+)$/m.exec(body)?.[1] ?? '').trim();
  return { name, description: meta.description || '', use: USES.includes(meta.use) ? meta.use : 'general', body: body.trim() };
}

export function formatSkill(s) {
  const esc = (v) => String(v || '').replace(/\n/g, ' ');
  return `---\nname: ${esc(s.name)}\ndescription: ${esc(s.description)}\nuse: ${s.use || 'general'}\n---\n\n${s.body.trim()}\n`;
}

export class SkillError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Skills {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'skills');
  }

  // Files on disk override the built-in of the same id; a ".removed" marker hides a built-in.
  list() {
    const out = new Map(BUILTIN.map((b) => [b.id, { ...b, builtin: true, edited: false }]));
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { /* no skills folder yet */ }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let file = null;
      let id = null;
      if (e.isDirectory()) { file = path.join(this.dir, e.name, 'SKILL.md'); id = e.name; }
      else if (e.isFile() && e.name.endsWith('.md')) { file = path.join(this.dir, e.name); id = e.name.slice(0, -3); }
      if (!file) continue;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const s = parseSkill(text, id);
      if (!s.body) continue;
      const base = out.get(id);
      let updatedAt = 0;
      try { updatedAt = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
      out.set(id, { id, ...s, name: s.name || id, builtin: Boolean(base?.builtin), edited: Boolean(base?.builtin), updatedAt });
    }
    for (const id of this.removed()) if (out.get(id)?.builtin && !out.get(id).edited) out.delete(id);
    return [...out.values()].sort((a, b) => (a.use === 'report' ? 0 : 1) - (b.use === 'report' ? 0 : 1) || a.name.localeCompare(b.name));
  }

  removed() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, '.removed.json'), 'utf8')); } catch { return []; }
  }

  get(ref) {
    if (!ref) return null;
    const all = this.list();
    const r = String(ref).toLowerCase();
    return all.find((s) => s.id === r) || all.find((s) => s.name.toLowerCase() === r) || all.find((s) => s.id === slug(r)) || null;
  }

  reportSkill(id) {
    return (id && this.get(id)) || this.list().find((s) => s.use === 'report') || { ...BUILTIN[0], builtin: true };
  }

  save(input, { id: fixedId } = {}) {
    const s = typeof input === 'string' ? parseSkill(input) : { ...parseSkill(input.text || '', input.name), ...pickDefined(input, ['name', 'description', 'use', 'body']) };
    s.name = String(s.name || '').trim();
    s.body = String(s.body || '').trim();
    if (!s.name) throw new SkillError(400, 'a skill needs a name');
    if (!s.body) throw new SkillError(400, 'a skill needs instructions (the body)');
    if (s.body.length > MAX_BODY) throw new SkillError(413, `a skill is at most ${MAX_BODY / 1024} KB`);
    if (s.use && !USES.includes(s.use)) throw new SkillError(400, `use must be one of ${USES.join(', ')}`);
    const id = fixedId || slug(s.name);
    if (!id) throw new SkillError(400, 'the name needs at least one letter or digit');
    const folder = path.join(this.dir, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), formatSkill(s));
    const flat = path.join(this.dir, `${id}.md`);
    if (fs.existsSync(flat)) fs.rmSync(flat);
    const removed = this.removed().filter((x) => x !== id);
    if (removed.length !== this.removed().length) fs.writeFileSync(path.join(this.dir, '.removed.json'), JSON.stringify(removed));
    return this.get(id);
  }

  // Custom skills move to skills/.trash; an edited built-in goes back to the original;
  // an unedited built-in is hidden.
  remove(ref) {
    const s = this.get(ref);
    if (!s) throw new SkillError(404, `no skill "${ref}"`);
    const folder = path.join(this.dir, s.id);
    const flat = path.join(this.dir, `${s.id}.md`);
    const trash = path.join(this.dir, '.trash');
    let moved = false;
    for (const p of [folder, flat]) {
      if (!fs.existsSync(p)) continue;
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(p, path.join(trash, `${path.basename(p)}-${Date.now()}`));
      moved = true;
    }
    if (s.builtin && !moved) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, '.removed.json'), JSON.stringify([...new Set([...this.removed(), s.id])]));
    }
    return { removed: s.id, restoredDefault: s.builtin && moved };
  }
}

function pickDefined(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== null).map((k) => [k, obj[k]]));
}
