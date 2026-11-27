// One-line setup.
//
//   recon agent   paste-into-any-agent path: makes sure the board is running, then
//                 prints instructions the agent follows through its shell. No config,
//                 no restart; works in any agent that can run commands.
//   recon setup   install-once path: registers recon's MCP tools in every agent CLI
//                 found on this machine, starts the board and opens it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCopy, ensureHub, openBrowser, reconHome, GITHUB_SPEC } from './launch.js';
import { createClient, defaultUrl } from './client.js';
import { ENUMS } from './model.js';
import { projectName } from './project.js';

export const PASTE_LINE = `Run \`npx -y ${GITHUB_SPEC} agent\` and follow its instructions to do this security review with me on the recon board.`;

// Shorter, shell-friendly path: ~/.recon/bin/recon instead of the absolute home path.
function tilde(p) {
  const home = os.homedir();
  return process.platform !== 'win32' && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

const quote = (s) => (/^[\w./:@=+~-]+$/.test(s) ? s : JSON.stringify(s));

// ---------- recon agent ----------

export async function runAgent({ name, url, key, hunt = undefined, out = process.stdout, err = process.stderr }) {
  const { bin, shim } = installCopy();
  const hub = await ensureHub({ url: url || defaultUrl(), key, bin, log: (m) => err.write(`${m}\n`) });
  const who = name || '<your-name>';
  const env = hub.url !== defaultUrl({}) ? `RECON_URL=${hub.url} ` : '';
  // Different projects get different hunts: name it after the project this agent is working in.
  const huntName = hunt === undefined ? projectName(process.cwd()) : hunt;
  let started = null;
  if (huntName) { try { started = await createClient({ url: hub.url, key, agent: name || null, transport: 'cli' }).start(huntName); } catch (e) { err.write(`recon: could not open the hunt "${huntName}": ${e.message}\n`); } }
  const huntFlag = started ? ` --hunt ${quote(started.hunt?.name || huntName)}` : '';
  const R = `${env}${quote(tilde(shim))} --as ${who}${huntFlag}`;
  let state = null;
  try { state = await createClient({ url: hub.url, key, hunt: started ? (started.hunt?.name || huntName) : null }).state(); } catch { /* board still fine */ }
  const lines = [
    `recon is ready. Tell the human: the live board is at ${hub.url} (open it to watch, verify and steer).`,
    started ? `This project's hunt is "${started.hunt?.name || huntName}"${started.resumed || started.existing ? ' (resumed: call briefing to see where you left off)' : ''}${started.onScreen === false ? '. The human is looking at another hunt; the board offers them a switch.' : '.'}` : '',
    '',
    'You are now an agent on a shared security-research board. The human watches it live,',
    'verifies or disputes your claims, and leaves steers for you. Use the recon CLI below.',
    name ? `Your name on the board is "${name}".` : 'Pick a short name for yourself (e.g. claude-code, opencode, grok, codex) and use it in place of <your-name>.',
    'If your tools already include recon_* MCP tools, you may use those instead; they do the same things.',
    '',
    `  R = ${R}`,
    '',
    'Always work in this order for every target. Do not jump straight to vulnerabilities.',
    '',
    'Start',
    `  ${R} briefing                    what to do next: steers for you, phase, the playbook`,
    `  ${R} start "<hunt name>"         only if you need a different hunt than this project's`,
    `  ${R} add target "<name>" --type <${ENUMS.protocolType.join('|')}>`,
    '',
    '1. Map the system (phase: mapping)',
    `  ${R} add component "<Contract.fn()>" --summary "<what it does>" --location "<file:line>"`,
    `  ${R} add actor "<User|Admin|Keeper|Liquidator...>" --summary "<what they do>"`,
    `  ${R} add external "<Token|Oracle|Other protocol>" --summary "<what it provides>"`,
    `  ${R} relate "<from>" "<to>" <calls|reads|writes|transfers|mints|owns|configures|trusts|delegates|inherits> "<label>"`,
    `  ${R} phase "<target>" assumptions                when every part and connection is on the map`,
    '',
    '2. Record the developers\' assumptions (phase: assumptions)',
    `  ${R} add assumption "<what the devs assume>" --origin developer --category <trust|invariant|input|external|economic> --rationale "<where you see it>"`,
    '     the briefing lists common assumptions for this protocol type; keep only the ones this code actually makes',
    `  ${R} phase "<target>" hunting`,
    '',
    '3. Hunt (phase: hunting). Call briefing between tasks and do its mustDo list top to bottom.',
    `  ${R} ack <steerId>                                   acknowledge every open steer at once; until then findings and coverage are refused`,
    `  ${R} focus "<what you are doing>" --item "<component>"`,
    `  ${R} coverage "<component>" scanning                 when you start on a part (claims it)`,
    `  ${R} coverage "<component>" reviewed --reasoning "<what you checked>" --evidence "<file:line>|<what it shows>"`,
    `  ${R} add hypothesis "<suspected bug>" --component "<component>" --stage <capability|trigger|full> --class <bug-class> --confidence <low|med|high>`,
    '     capability = the power exists but no public path makes it fire: hunt the trigger before calling it a bug',
    `  ${R} coverage "<component>" flagged --reasoning "<what smells>"   (needs a hypothesis on it first)`,
    `  ${R} get "<component>" · ${R} check "<component>" <checkId>      the playbook checklist`,
    `  ${R} set <hypothesisId> status=confirmed             needs a code reference plus a test, fork run or tx as evidence`,
    `  ${R} add finding "<title>" --severity <s> --attacker <stranger|holder|privileged|admin> --reachability <permissionless|needs-role|needs-config|needs-social>`,
    `       --bound "<what still cannot happen>" --funds <none|unknown|"addr amount"> --reported <no|yes|unknown> --verified <fork|unit|fuzz|eth_call|live-tx|manual>`,
    `       --test <test_Name> --test-result pass --component "<component>" --hypothesis <id> --evidence "<file:line>|..."`,
    '     Critical needs a permissionless path and measured live funds; High needs an outsider path. Config the team chose is not Critical.',
    `  ${R} ready "<finding>"                               every gate in one check, before you report it`,
    `  ${R} add chain "<title>" --part <id> --part <id> --glue <same-tx|same-caller|config+code|social+code> --result "<extra impact>"`,
    `  ${R} add lead "<what is left>" --value <high|med|low> --why "<what it would prove>" --blocked "<what is in the way>" --next "<next step>"`,
    `  ${R} address <steerId> "<what you did or found>"     report back on a steer`,
    `  ${R} propose "<question>" --option "<choice A>" --option "<choice B>"   decisions go to the human as one-click options, not chat`,
    '',
    'Before you stop: report back on every steer, record what is left as leads, and end with a propose that offers the next moves.',
    '',
    'Rules',
    '  - Back every claim with evidence (file:line, function, tx). Unbacked claims get disputed, and disputes come back to you as steers.',
    '  - Never set verification or priority: those are the human\'s.',
    '  - Do not overwrite components another agent owns; add evidence instead.',
    `  - Before filing a hypothesis or finding, check what exists (${R} list finding, ${R} list hypothesis). Add evidence to an existing one rather than duplicating it.`,
    '  - Steers never require you to stop. Acknowledge fast, address when you get there.',
    '  - Names work wherever ids do, e.g. "Vault.withdraw()".',
  ];
  if (state) {
    const comps = Object.values(state.items.component);
    lines.push('', `Board now: "${state.project.name}"${state.project.example ? ' (the built-in example: start your own engagement first)' : ''}, ${Object.keys(state.items.target).length} target(s), ${comps.length} component(s), ${Object.values(state.items.steer).filter((s) => s.state === 'open').length} open steer(s), ${Object.keys(state.items.agent).length} agent(s).`);
  }
  lines.push('', `Next: run \`${R} briefing\`.`);
  out.write(`${lines.join('\n')}\n`);
  return hub;
}

// ---------- recon setup ----------

function has(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], { shell: process.platform !== 'win32', stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// Clients that keep MCP servers under { "mcpServers": { name: { command, args } } }.
function mcpServersFile(file, entry) {
  const doc = readJson(file);
  doc.mcpServers = { ...(doc.mcpServers || {}), recon: entry };
  writeJson(file, doc);
}

export function clients(home = os.homedir()) {
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const desktop = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'win32' ? path.join(appData, 'Claude', 'claude_desktop_config.json') : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  const opencodeFile = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'opencode.json');
  return [
    {
      id: 'claude-code', label: 'Claude Code', present: () => has('claude'),
      register: (cmd, args) => {
        run('claude', ['mcp', 'remove', '-s', 'user', 'recon']);
        return run('claude', ['mcp', 'add', '-s', 'user', 'recon', '--', cmd, ...args]);
      },
    },
    {
      id: 'codex', label: 'Codex CLI', present: () => has('codex'),
      register: (cmd, args) => {
        run('codex', ['mcp', 'remove', 'recon']);
        return run('codex', ['mcp', 'add', 'recon', '--', cmd, ...args]);
      },
    },
    {
      id: 'gemini', label: 'Gemini CLI', present: () => has('gemini'),
      register: (cmd, args) => {
        run('gemini', ['mcp', 'remove', '-s', 'user', 'recon']);
        return run('gemini', ['mcp', 'add', '-s', 'user', 'recon', cmd, '--', ...args]);
      },
    },
    {
      id: 'opencode', label: 'OpenCode', present: () => has('opencode') || fs.existsSync(path.dirname(opencodeFile)),
      register: (cmd, args) => {
        const doc = readJson(opencodeFile);
        if (!doc.$schema) doc.$schema = 'https://opencode.ai/config.json';
        doc.mcp = { ...(doc.mcp || {}), recon: { type: 'local', command: [cmd, ...args], enabled: true } };
        writeJson(opencodeFile, doc);
        return { ok: true, out: opencodeFile };
      },
    },
    {
      // Grok CLI only reads MCP servers from the project's .grok/settings.json.
      id: 'grok', label: 'Grok CLI', present: () => has('grok'), projectOnly: true,
      register: (cmd, args, { here }) => {
        if (!here) return { ok: false, skip: true, out: 'keeps MCP servers per project: run `recon setup --here` inside the project, or paste the agent line below' };
        run('grok', ['mcp', 'remove', 'recon']);
        return run('grok', ['mcp', 'add-json', 'recon', JSON.stringify({ command: cmd, args })]);
      },
    },
    {
      id: 'cursor', label: 'Cursor', present: () => fs.existsSync(path.join(home, '.cursor')),
      register: (cmd, args) => { const f = path.join(home, '.cursor', 'mcp.json'); mcpServersFile(f, { command: cmd, args }); return { ok: true, out: f }; },
    },
    {
      id: 'windsurf', label: 'Windsurf', present: () => fs.existsSync(path.join(home, '.codeium', 'windsurf')),
      register: (cmd, args) => { const f = path.join(home, '.codeium', 'windsurf', 'mcp_config.json'); mcpServersFile(f, { command: cmd, args }); return { ok: true, out: f }; },
    },
    {
      id: 'claude-desktop', label: 'Claude Desktop', present: () => fs.existsSync(path.dirname(desktop)),
      register: (cmd, args) => { mcpServersFile(desktop, { command: cmd, args }); return { ok: true, out: desktop }; },
    },
  ];
}

export async function runSetup({ url, key, open = true, only = null, here = false, err = process.stderr, out = process.stdout }) {
  const say = (s = '') => out.write(`${s}\n`);
  const { bin, shim, app } = installCopy();
  say('');
  say(`  recon setup`);
  say('');
  say(`  ✓ installed            ${app}`);
  say(`  ✓ command              ${shim}`);
  const results = [];
  for (const c of clients()) {
    if (only && !only.includes(c.id)) continue;
    if (!c.present()) { say(`  · ${c.label.padEnd(20)} not found`); continue; }
    let r;
    try { r = c.register(process.execPath, [bin, 'mcp', '--name', c.id], { here }); } catch (e) { r = { ok: false, out: e.message }; }
    results.push({ ...c, ...r });
    if (r.skip) say(`  · ${c.label.padEnd(20)} ${r.out}`);
    else say(r.ok ? `  ✓ ${c.label.padEnd(20)} recon tools added${c.projectOnly ? ' (this project)' : ''}` : `  ✗ ${c.label.padEnd(20)} could not register: ${r.out.split('\n').slice(-1)[0]}`);
  }
  const hub = await ensureHub({ url: url || defaultUrl(), key, bin, log: () => {} });
  say(`  ✓ board                ${hub.url}${hub.started ? '' : ' (already running)'}`);
  if (open && process.env.RECON_NO_OPEN !== '1') openBrowser(hub.url);
  say('');
  if (results.some((r) => r.ok)) {
    say('  Restart your agent (or open a new session) so it loads the recon tools, then tell it:');
    say('    "Use recon: call recon_briefing and work the board with me."');
    say('');
  }
  say('  Any agent with a terminal, no restart needed. Paste this into its chat:');
  say(`    ${PASTE_LINE}`);
  say('');
  say(`  Not listed? Add an MCP server with command "${process.execPath}" and args ["${bin}", "mcp", "--name", "my-agent"].`);
  say('');
  void err; void reconHome;
  return { hub, results };
}
