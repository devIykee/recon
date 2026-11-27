// Connect an agent: pick how it talks, copy one snippet, watch it arrive.

import { h, icon, modal, codeBlock } from './ui.js';
import { live, on, get } from './state.js';
import { TRANSPORT } from './labels.js';

const TRANSPORTS = [
  { id: 'mcp', name: 'MCP', icon: 'plug', rec: true, desc: 'For Claude Code, Cursor, and any MCP-capable agent. Tools appear automatically.' },
  { id: 'cli', name: 'CLI', icon: 'terminal', desc: 'For scripts and home-grown agents. Push and pull from a terminal.' },
  { id: 'api', name: 'HTTP + WebSocket', icon: 'globe', desc: 'For anything that speaks HTTP. REST to write, a socket for the live feed.' },
  { id: 'json', name: 'Drop-in JSON', icon: 'file', desc: 'Zero setup. Your agent writes a JSON file; recon watches and merges it.' },
];

export async function openConnect({ transport = 'mcp' } = {}) {
  let info;
  try { info = await get('/api/connect'); } catch { info = { base: location.origin, bin: 'recon', needsKey: false, watching: [], dropinExample: './recon-inbox.json' }; }
  let sel = transport;
  let name = 'my-agent';
  const known = new Set(Object.keys(live.state?.items.agent || {}));
  let arrived = null;

  const m = modal([], { wide: true, onClose: () => off() });
  const off = on((evt) => {
    if (evt.type === 'change' && evt.kind === 'agent' && !known.has(evt.item.id)) {
      arrived = evt.item;
      known.add(evt.item.id);
      render();
    }
  });

  function render() {
    const nameInput = h('input.input.mono', { value: name, placeholder: 'my-agent', style: { maxWidth: '240px' } });
    nameInput.addEventListener('input', () => { name = nameInput.value.trim() || 'my-agent'; renderSnippets(); });
    const snippets = h('div');
    const renderSnippets = () => snippets.replaceChildren(...instructions(sel, name, info));
    renderSnippets();
    m.set(
      h('div.steps', h('span.on'), h('span.on'), h('span', { class: arrived ? 'on' : '' })),
      h('h2', 'Connect an agent'),
      h('p.lead', 'Pick how your agent talks. Everything stays on this machine: recon runs at ', h('code', info.base), '.'),
      h('div.choice-grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))', marginBottom: '16px' } },
        ...TRANSPORTS.map((t) => h('button.choice', {
          type: 'button', 'aria-pressed': String(sel === t.id), on: { click: () => { sel = t.id; render(); } },
        }, t.rec ? h('span.badge-rec', 'recommended') : null, h('b', t.name), h('small', t.desc)))),
      h('div.field', h('label', 'Name your agent'), nameInput, h('span.help', 'Shown on the board next to everything it does. Use a different name per agent to run a swarm.')),
      snippets,
      arrived
        ? h('div.waiting.done', icon('check'), h('span', h('b', arrived.name), ` connected over ${TRANSPORT[arrived.transport] || arrived.transport}. You are running a real engagement together now.`))
        : h('div.waiting', h('span.spinner'), h('span', 'Waiting for your agent… this flips the moment its first request lands.')),
      h('div.modal-actions', h('span.verify-note', 'Agents get a briefing with your steers, the playbook and suggested next moves.'), h('span.spacer'),
        h(`button.btn${arrived ? '.btn-primary' : ''}`, { on: { click: () => m.close() } }, arrived ? 'Go to the board' : 'Close')),
    );
  }

  render();
  return m;
}

function instructions(t, name, info) {
  const bin = info.bin;
  const base = info.base;
  const env = info.needsKey ? `RECON_URL=${base} RECON_KEY=<your key> ` : '';
  const prompt = 'Use the recon tools. Start with recon_briefing, acknowledge my steers, record coverage, assumptions, hypotheses and findings with evidence (file:line), and propose your next move with recon_propose when unsure.';
  switch (t) {
    case 'mcp':
      return [
        h('div.code-label', 'Claude Code'),
        codeBlock(`claude mcp add recon -- ${env ? `env ${env}` : ''}node ${bin} mcp --name ${name}`),
        h('div.code-label', 'Any MCP client (mcp.json / settings)'),
        codeBlock(JSON.stringify({ mcpServers: { recon: { command: 'node', args: [bin, 'mcp', '--name', name], ...(info.needsKey ? { env: { RECON_URL: base, RECON_KEY: '<your key>' } } : {}) } } }, null, 2)),
        h('div.code-label', 'Then tell your agent'),
        codeBlock(prompt),
      ];
    case 'cli':
      return [
        h('div.code-label', 'Point the CLI at this hub'),
        codeBlock(`alias recon="node ${bin}"\nexport RECON_AGENT=${name}${info.needsKey ? `\nexport RECON_URL=${base}\nexport RECON_KEY=<your key>` : ''}`),
        h('div.code-label', 'Read the briefing, then write as you go'),
        codeBlock('recon briefing\nrecon coverage <componentId> scanning\nrecon add hypothesis "share price can be inflated" --component <componentId> --confidence med --evidence "Vault.sol:88"\nrecon steers --mine\nrecon ack <steerId>\nrecon address <steerId> "checked, it holds"'),
      ];
    case 'api':
      return [
        h('div.code-label', 'Read the briefing (any request with X-Recon-Agent registers the agent)'),
        codeBlock(`curl -s ${base}/api/briefing -H 'X-Recon-Agent: ${name}'${info.needsKey ? " -H 'Authorization: Bearer <your key>'" : ''}`),
        h('div.code-label', 'Write per item'),
        codeBlock(`curl -s -X POST ${base}/api/items/hypothesis \\\n  -H 'content-type: application/json' -H 'X-Recon-Agent: ${name}' \\\n  -d '{"text":"first depositor can inflate shares","confidence":"med","evidence":[{"ref":"Vault.sol:88"}]}'`),
        h('div.code-label', 'Live feed'),
        codeBlock(`${base.replace(/^http/, 'ws')}/ws?agent=${encodeURIComponent(name)}`),
        h('p.verify-note', 'Full reference: docs/API.md, or GET /api/model for every field and enum.'),
      ];
    case 'json':
      return [
        h('div.code-label', info.watching.length ? 'recon is already watching' : 'Start recon watching a file'),
        codeBlock(info.watching.length ? info.watching.join('\n') : `node ${bin} serve --watch ${info.dropinExample}`),
        h('div.code-label', 'Have your agent write something like this; recon merges it item by item'),
        codeBlock(JSON.stringify({
          agent: { name },
          targets: [{ name: 'My target', protocolType: 'vault', components: [{ name: 'Vault.deposit()', reviewState: 'reviewed', evidence: [{ ref: 'Vault.sol:40' }] }] }],
          hypotheses: [{ text: 'first depositor can inflate shares', confidence: 'med' }],
        }, null, 2)),
      ];
    default:
      return [];
  }
}
