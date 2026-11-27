// Drop-in json: the zero-setup transport. Point recon at a file or url, and
// whatever an agent writes there is merged into the board item by item.
//
// Accepted shapes (see docs/API.md):
//   { "agent": { "name": "my-agent" }, "targets": [{ "name": "...", "components": [...] }],
//     "hypotheses": [...], "findings": [...], "assumptions": [...] }
// or a full recon export ({ "items": { ... } }).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function watchSource(store, source, { log = () => {}, interval } = {}) {
  const isUrl = /^https?:\/\//.test(source);
  let lastHash = '';
  let timer = null;
  let closed = false;
  const fallbackName = isUrl ? new URL(source).hostname : path.basename(source).replace(/\.json$/, '');

  const apply = (text) => {
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (hash === lastHash) return;
    lastHash = hash;
    let doc;
    try { doc = JSON.parse(text); } catch (err) { log(`recon: ${source} is not valid json yet (${err.message})`); return; }
    const name = (doc.agent && (doc.agent.name || doc.agent)) || `${fallbackName} (json)`;
    const agent = store.touchAgent(String(name), { transport: 'json' });
    const result = store.merge(doc, agent.id);
    if (result.errors.length) log(`recon: merged ${source} with ${result.errors.length} error(s):\n  ${result.errors.join('\n  ')}`);
  };

  const poll = async () => {
    if (closed) return;
    try {
      if (isUrl) {
        const res = await fetch(source, { headers: { accept: 'application/json' } });
        if (res.ok) apply(await res.text());
      } else if (fs.existsSync(source)) {
        apply(fs.readFileSync(source, 'utf8'));
      }
    } catch (err) {
      log(`recon: could not read ${source}: ${err.message}`);
    }
    if (!closed) timer = setTimeout(poll, interval || (isUrl ? 5000 : 1000));
    timer?.unref?.();
  };

  if (!isUrl) {
    const dir = path.dirname(path.resolve(source));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  poll();
  return {
    source,
    close() { closed = true; clearTimeout(timer); },
  };
}
