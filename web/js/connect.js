// Connect an agent: pick how it talks, copy one snippet, watch it arrive.

import { h, icon, modal, codeBlock } from './ui.js';
import { live, on, get, post } from './state.js';
import { TRANSPORT } from './labels.js';

const TRANSPORTS = [
  { id: 'mcp', name: 'MCP', icon: 'plug', rec: true, desc: 'For Claude Code, Cursor, and any MCP-capable agent. Tools appear automatically.' },
  { id: 'cli', name: 'CLI', icon: 'terminal', desc: 'For scripts and home-grown agents. Push and pull from a terminal.' },
  { id: 'api', name: 'HTTP + WebSocket', icon: 'globe', desc: 'For anything that speaks HTTP. REST to write, a socket for the live feed.' },
  { id: 'json', name: 'Drop-in JSON', icon: 'file', desc: 'Zero setup. Your agent writes a JSON file; recon watches and merges it.' },
];

// Hosted: the agent runs on your computer (or anywhere) and reaches this board over
// the internet with an API key. One click makes a key and fills it in below.
function openHostedConnect() {
  let name = 'claude-code';
  let key = null;
  let busy = false;
  const base = location.origin;
  const known = new Set(Object.keys(live.state?.items.agent || {}));
  let arrived = null;
  const m = modal([], { wide: true, onClose: () => off() });
  const off = on((evt) => {
    if (evt.type === 'change' && evt.kind === 'agent' && !known.has(evt.item.id)) { arrived = evt.item; known.add(evt.item.id); render(); }
  });
  const makeKey = async () => {
    busy = true; render();
    try { key = (await post('/auth/keys', { label: name })).key; } catch (err) { alert(err.message); }
    busy = false; render();
  };
  const snippetsFor = (k) => [
    h('div.code-label', 'Paste this into any coding agent (Claude Code, Codex, Gemini, OpenCode, Grok…)'),
    codeBlock(`Run \`RECON_URL=${base} RECON_KEY=${k} npx -y github:devIykee/recon agent --as ${name}\` and follow its instructions to do this security review with me on the recon board.`),
    h('div.code-label', 'Or add it as a remote MCP server (Claude Code)'),
    codeBlock(`claude mcp add --transport http recon ${base}/mcp --header "Authorization: Bearer ${k}" --header "X-Recon-Agent: ${name}"`),
    h('div.code-label', 'Any MCP client that starts a local command'),
    codeBlock(JSON.stringify({ mcpServers: { recon: { command: 'npx', args: ['-y', 'github:devIykee/recon', 'mcp', '--name', name], env: { RECON_URL: base, RECON_KEY: k } } } }, null, 2)),
  ];
  function render() {
    const k = key || '<your api key>';
    // typing updates the snippets only: re-rendering the whole dialog on blur
    // would replace the button under the mouse before its click lands
    const nameInput = h('input.input.mono', { value: name, style: { maxWidth: '240px' }, disabled: Boolean(key) });
    nameInput.addEventListener('input', () => { name = nameInput.value.trim() || 'my-agent'; snippets.replaceChildren(...snippetsFor(k)); makeBtn?.replaceChildren(icon('plus'), `Make an API key for ${name}`); });
    const makeBtn = key ? null : h('button.btn.btn-primary', { disabled: busy, on: { click: makeKey } }, icon('plus'), busy ? 'Making a key…' : `Make an API key for ${name}`);
    const snippets = h('div', ...snippetsFor(k));
    m.set(
      h('h2', 'Connect an agent'),
      h('p.lead', 'Your agent runs wherever you like and reaches this board over the internet with an API key. Each key can be revoked on your ', h('a', { href: '/account' }, 'account page'), '.'),
      h('div.field', h('label', 'Name your agent'), nameInput),
      key
        ? h('div.key-shown', icon('check'), h('span', 'Your key is filled in below. It is shown only now: copy what you need.'))
        : makeBtn,
      snippets,
      arrived
        ? h('div.waiting.done', icon('check'), h('span', h('b', arrived.name), ' is connected. You are hunting together now.'))
        : h('div.waiting', h('span.spinner'), h('span', 'Waiting for your agent… this flips the moment its first request lands.')),
      h('div.modal-actions', h('span.spacer'), h(`button.btn${arrived ? '.btn-primary' : ''}`, { on: { click: () => m.close() } }, arrived ? 'Go to the board' : 'Close')),
    );
  }
  render();
  return m;
}

export async function openConnect({ transport = 'mcp' } = {}) {
  if (live.hosted) return openHostedConnect();
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
