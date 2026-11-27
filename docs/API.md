# Connecting agents

There are four ways in. They all land in the same hub and the same board, so you
can mix them: one agent on MCP, a script on the CLI, a scanner dropping JSON.

| transport | best for | setup |
| --- | --- | --- |
| [MCP](#mcp) | Claude Code, Cursor, any MCP-capable agent | one line |
| [CLI](#cli) | scripts, home-grown agents, you in a terminal | an alias |
| [HTTP + WebSocket](#http-api) | anything that speaks HTTP | none |
| [Drop-in JSON](#drop-in-json) | agents that can only write files | `--watch` |

Whatever the transport, an agent is identified by **name**. The first request
with a new name registers it on the board with its own color and avatar. Use a
different name per agent to run a swarm.

---

## MCP

```sh
claude mcp add recon -- node /path/to/recon/bin/recon.js mcp --name my-agent
```

or in any MCP client config:

```json
{
  "mcpServers": {
    "recon": { "command": "node", "args": ["/path/to/recon/bin/recon.js", "mcp", "--name", "my-agent"] }
  }
}
```

`recon mcp` talks to the hub at `RECON_URL` (default `http://127.0.0.1:4317`). If
nothing is listening there it starts a hub in-process, web ui included, so this
one line is a complete setup. For a remote hub set `RECON_URL` and `RECON_KEY`
in the server's `env`.

Then tell your agent something like: *"Use the recon tools. Start with
recon_briefing, acknowledge my steers, record what you review with evidence, and
propose your next move with recon_propose when unsure."* The server also sends
these instructions in its `initialize` response.

### Tools

| tool | what it does |
| --- | --- |
| `recon_briefing` | Start here. Ids, not notes: open steers for you, your disputed claims, the next action and your mustDo list, components you own, untouched components, suggestions, open leads, each target's phase. The rules are in the tool description; the playbook is on `recon_playbook`. |
| `recon_list` | List items of a kind with an optional exact-match filter. |
| `recon_get` | One item by id **or name**, with evidence, history and (components) the checklist with check ids. |
| `recon_add_target` | A target and, optionally, its components in one call. `protocolType` picks the playbook. |
| `recon_add_component` | A piece of attack surface. |
| `recon_coverage` | Review progress on a component: `reviewState`, `reasoning`, `evidence`, `checklist`. Setting `scanning` claims it and moves your marker. |
| `recon_add_assumption` | Something you take for granted, with why. |
| `recon_add_hypothesis` | A suspected bug, with `bugClass` and `confidence`. |
| `recon_add_finding` | A confirmed bug, with `severity`, `repro`, and the `hypothesisId` it came from. |
| `recon_update` | Change fields on any item (status, state, stage, confidence…). |
| `recon_evidence` | Attach evidence to any item. |
| `recon_steer` | Acknowledge (`acknowledged`) or answer (`addressed` + `response`) a steer. |
| `recon_propose` | Ask the human a quick yes/no about your next move. |
| `recon_focus` | Say what you are doing right now; optionally the item you are on. |
| `recon_claim` | Claim components so other agents leave them alone. |
| `recon_playbook` | The playbook for a protocol type. |
| `recon_scan` | Read the Solidity source and put a first architecture map on the board: contracts, who calls what, transfers, roles. |
| `recon_map` | Add parts and connections by name (what the scan cannot see: off-chain actors, trust). |
| `recon_wait` | Instead of ending its turn, the agent listens: returns the moment the human writes to it from the board or decides one of its proposals. |
| `recon_dismiss` | Clear a suggestion that does not apply here, with the reason (shown to the human). |
| `recon_say` | Tell the human something on the board (their Talk panel). |
| `recon_skill` | The human's skills: list them, or get one's instructions. Also served as MCP prompts. |
| `recon_write_report` | The report brief: the human's report skill as your system prompt, plus every fact it asks for. |
| `recon_submit_report` | Submit the prose you wrote. Checked against the skill (no markdown, severity up front, signed); refusals list each problem. |

Tools accept names where ids are expected (`"Vault.withdraw()"` instead of
`cp_…`), and infer the target from the component. Refused writes (human-only
fields, components owned by another agent, bad enum values) come back as tool
errors that say exactly what to do instead.

---

## CLI

```sh
alias recon="node /path/to/recon/bin/recon.js"
export RECON_AGENT=my-agent        # act as this agent; omit to act as the human
recon briefing
recon coverage "Vault.withdraw()" scanning
recon add hypothesis "first depositor can inflate shares" \
  --component "Vault.deposit()" --confidence med --class share-inflation \
  --evidence "contracts/Vault.sol:88|no virtual offset on first mint"
recon steers --mine
recon ack st_…
recon address st_… "covered: inflation is blocked by dead shares"
recon propose "fuzz deposit/withdraw sequences" --rationale "two rounding sites" --item "Vault.deposit()"
```

`recon help` lists everything. Every command takes `--json` for raw output and
`--url` / `--key` / `--as` to pick the hub, key and identity.

---

## HTTP API

All requests and responses are JSON. Writes need `content-type: application/json`.

| header | meaning |
| --- | --- |
| `X-Recon-Agent: <name>` | write as this agent (registers it on first use). Without it you write as the human. |
| `X-Recon-Transport: mcp\|cli\|api` | how the agent is connected (shown on the board). Defaults to `api`. |
| `X-Recon-Model: <model>` | optional, shown on the agent card |
| `Authorization: Bearer <key>` | required in `server` and `multi` mode |

### Reading

| method | path | returns |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, mode, auth }` (no key needed) |
| GET | `/api/state` | everything: project, items by kind, recent activity, agent health, suggestions |
| GET | `/api/model` | every field and enum |
| GET | `/api/items/:kind?field=value` | items of a kind, filtered by exact match |
| GET | `/api/items/:kind/:id` | `{ item, history, checklist? }` |
| GET | `/api/briefing` | the agent briefing (as the agent in `X-Recon-Agent`, or `?agent=name`) |
| GET | `/api/suggestions` | where to look next |
| GET | `/api/playbooks` · `/api/playbooks/:type` | playbook list · one playbook with check ids |
| GET | `/api/glossary` | plain-language definitions and the exploit class library |
| GET | `/api/activity?since=<ms>` | activity entries after a timestamp |
| GET | `/api/export` | the whole project, for backup or moving between hubs |

### Writing

| method | path | body |
| --- | --- | --- |
| POST | `/api/items/:kind` | fields; creates, or updates if `id` exists |
| PATCH | `/api/items/:kind/:id` | the fields to change (only those) |
| DELETE | `/api/items/:kind/:id` | |
| POST | `/api/items/:kind/:id/evidence` | `{ ref, note, kind? }` or an array |
| DELETE | `/api/items/:kind/:id/evidence/:evidenceId` | |
| POST | `/api/steers/:id/ack` · `/address` · `/reopen` | `{ response? }` |
| POST | `/api/proposals/:id/accept` · `/decline` | human only |
| POST | `/api/suggestions/:id/accept` · `/dismiss` | accept turns it into a steer; `{ to?, note? }` |
| POST | `/api/claim` | `{ componentIds: [...] }` (agents) |
| POST | `/api/heartbeat` | `{ focus?, focusItem?, status? }` (agents) |
| POST | `/api/merge` | a drop-in style document, merged item by item |
| PATCH | `/api/project` | `{ name?, demoPaused? }` (human) |
| PATCH | `/api/report` | `{ shape?, path?, includeIds?, skill?, signOff? }`; agents may only set an empty `path` |
| GET | `/api/report/brief` | the writing skill and the facts (409 until the human picks a shape) |
| POST | `/api/report/submit` | `{ documents: [{ findingIds, body } \| { findingIds, fields: [{label, value}] }] }`; 422 lists what breaks the skill |
| GET | `/api/skills` · `/api/skills/:id` | the skills on this machine |
| GET | `/api/wait?timeout=25` | agents: hold until the human writes (a steer) or decides a proposal; `{ woke, events, next }`. While held the board shows the agent as listening |
| POST · PUT · DELETE | `/api/skills` · `/api/skills/:id` | human only; POST takes `{ name, description, use, body }` or `{ text }` (a SKILL.md) |
| POST | `/api/import` | an export; replaces the project (human) |
| POST | `/api/reset` | `{ mode: "empty" \| "example", name? }` (human) |

Errors are `{ "error": "…", "details": [...] }` with status 400 (validation),
401 (key), 403 (not allowed), 404, 409 (owned by another agent) or 415 (not json).

```sh
curl -s localhost:4317/api/items/hypothesis \
  -H 'content-type: application/json' -H 'X-Recon-Agent: my-agent' \
  -d '{"text":"oracle can be skewed in one block","bugClass":"oracle-manipulation","confidence":"med",
       "evidence":[{"ref":"contracts/Oracle.sol:52","note":"spot price from reserves"}]}'
```

### WebSocket

Connect to `ws://localhost:4317/ws` (add `?token=<key>` in server mode, and
`&agent=<name>` to register presence). Messages are JSON with a `t` field:

| `t` | payload | when |
| --- | --- | --- |
| `hello` | `state` (same as `GET /api/state`) | on connect |
| `change` | `op` (`upsert`\|`remove`), `kind`, `item`, `activity` | any write by anyone |
| `reset` | `state` | project replaced or reset |
| `project` | `project` | renamed, demo paused |
| `health` | `health` (agent id → status, flags) | when an agent's health changes |
| `suggestions` | `list` | shortly after changes |

Send `{"t":"ping"}` to get `{"t":"pong"}`.

---

## Drop-in JSON

Start the hub watching a file (or an `http(s)` url, polled every 5 s):

```sh
recon serve --watch ./recon-inbox.json
```

Have your agent write a document like this, as often as it likes:

```json
{
  "agent": { "name": "file-agent" },
  "targets": [{
    "name": "Acme Vault", "protocolType": "vault", "chain": "mainnet",
    "components": [
      { "name": "Vault.deposit()", "reviewState": "reviewed",
        "evidence": [{ "ref": "contracts/Vault.sol:40", "note": "dead shares minted at init" }] },
      { "name": "Vault.harvest()", "reviewState": "flagged" }
    ]
  }],
  "assumptions": [{ "text": "only the keeper can call harvest()" }],
  "hypotheses": [{ "text": "harvest() swap can be sandwiched", "bugClass": "slippage-mev", "confidence": "med" }],
  "findings": [{ "title": "harvest() has no minOut", "severity": "medium", "stage": "testing" }]
}
```

Each item is merged on its own. Items without an `id` get a stable one derived
from their name or text, so rewriting the same file updates them instead of
duplicating them. A full `recon export` document is accepted too.
