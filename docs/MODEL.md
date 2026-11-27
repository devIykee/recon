# Data model

Everything on the board is one of eight kinds of item. Every field, enum and
ownership rule below comes straight from `src/model.js`, so agents can rely on it.
`GET /api/model` (or `recon model`) returns the same thing as json.

## How writes work

- **The hub is the single writer.** The web ui, mcp agents, the cli, the http api
  and drop-in json files all write through it, so there is one ordering of events.
- **Writes are per item and per field.** Each field is a last-write-wins register
  stamped `{at, by}` (see `_f` on every item). A human setting `verification` and
  an agent setting `reviewState` on the same item never collide; when two writers
  do set the same field, the later one wins on that field only, and the change
  glows on every screen so nobody misses it.
- **Two fields merge instead of replacing.** `evidence` is a set merged by
  evidence id (writes append), and `checklist` merges per check id.
- **Stale writes lose.** Merges from external documents carry the item's
  `updatedAt`; a field write older than the stored clock is ignored, which makes
  merging the same file twice harmless.
- **Human-owned fields** (`verification`, `priority`, `assignment`) are refused
  when an agent writes them. They are the human's judgement, not the agent's.
- **Ownership.** A component with an `owner` can only have its non-evidence fields
  changed by that agent (or a human). Other agents can still attach evidence.
  An agent that sets an unowned component to `scanning` claims it.

## Rules the hub applies

| when | then |
| --- | --- |
| a human sets `verification: disputed` on an item an agent created | a `recheck` steer (or `challenge`, for assumptions) opens for that agent |
| an agent sets `focusItem` to an untouched component | the component moves to `scanning` |
| an agent sets an unowned component to `scanning` | the agent becomes its `owner` |
| a steer moves to `acknowledged` / `addressed` | `ackAt` / `addressedAt` + `addressedBy` are stamped |
| a human accepts a proposal | an `acknowledged` steer "Go ahead: …" goes back to the proposer |
| a finding sets `hypothesisId` | the hypothesis gets `findingId` (two-way link) |

## Fields on every item

| field | meaning |
| --- | --- |
| `id` | `ag_`, `tg_`, `cp_`, `as_`, `hy_`, `fd_`, `st_`, `pr_` prefix + unique suffix. Agents are `ag_<slug of name>`. |
| `kind` | the item kind |
| `createdAt`, `updatedAt` | ms timestamps |
| `createdBy`, `lastTouchedBy` | `human` or an agent id |
| `_f` | per-field clocks: `{ field: { at, by } }` |
| `evidence` | `[{ id, kind, ref, note, by, at }]`, `kind` one of `code` `tx` `log` `test` `link` `note` (guessed from `ref` if omitted) |
| `reasoning` | free text |
| `verification` | `unverified` `verified` `disputed`, human only |
| `priority` | `low` `normal` `high` `urgent`, human only |
| `meta` | free-form object for anything else |

## Kinds

### agent

| field | type | values | who writes |
| --- | --- | --- | --- |
| `name` *(required)* | string |  | human or agent |
| `color` | string |  | human or agent |
| `avatar` | string |  | human or agent |
| `transport` | string | `mcp` `cli` `api` `json` `demo` `ui` (default `api`) | human or agent |
| `status` | string | `active` `idle` `stuck` `offline` (default `active`) | human or agent |
| `focus` | string |  | human or agent |
| `focusItem` | string |  | human or agent |
| `assignment` | array |  | human-only |
| `model` | string |  | human or agent |

### target

| field | type | values | who writes |
| --- | --- | --- | --- |
| `name` *(required)* | string |  | human or agent |
| `chain` | string |  | human or agent |
| `protocolType` | string | `lending` `amm` `perps` `bridge` `staking` `nft-market` `governance` `oracle` `token` `vault` `other` (default `other`) | human or agent |
| `description` | string |  | human or agent |
| `focus` | string |  | human or agent |
| `scope` | string |  | human or agent |

### component

| field | type | values | who writes |
| --- | --- | --- | --- |
| `targetId` *(required)* | string |  | human or agent |
| `name` *(required)* | string |  | human or agent |
| `type` | string | `contract` `function` `module` `endpoint` `storage` `config` `other` (default `contract`) | human or agent |
| `reviewState` | string | `untouched` `scanning` `reviewed` `flagged` (default `untouched`) | human or agent |
| `location` | string |  | human or agent |
| `owner` | string |  | human or agent |
| `checklist` | object |  | human or agent |
| `notes` | string |  | human or agent |

### assumption

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `targetId` | string |  | human or agent |
| `componentId` | string |  | human or agent |
| `scope` | string |  | human or agent |
| `state` | string | `assumed` `verified` `invalidated` (default `assumed`) | human or agent |
| `rationale` | string |  | human or agent |

### hypothesis

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `targetId` | string |  | human or agent |
| `componentId` | string |  | human or agent |
| `bugClass` | string |  | human or agent |
| `confidence` | string | `low` `med` `high` (default `low`) | human or agent |
| `status` | string | `testing` `confirmed` `dropped` (default `testing`) | human or agent |
| `dropReason` | string |  | human or agent |
| `findingId` | string |  | human or agent |

### finding

| field | type | values | who writes |
| --- | --- | --- | --- |
| `title` *(required)* | string |  | human or agent |
| `targetId` | string |  | human or agent |
| `componentId` | string |  | human or agent |
| `chain` | string |  | human or agent |
| `severity` | string | `critical` `high` `medium` `low` `info` (default `medium`) | human or agent |
| `bugClass` | string |  | human or agent |
| `bounty` | number |  | human or agent |
| `stage` | string | `recon` `testing` `reported` `acknowledged` `fixed` `disclosed` (default `recon`) | human or agent |
| `notes` | string |  | human or agent |
| `repro` | string |  | human or agent |
| `hypothesisId` | string |  | human or agent |

### steer

| field | type | values | who writes |
| --- | --- | --- | --- |
| `action` | string | `recheck` `challenge` `cover` `verify` `priority` `note` (default `note`) | human or agent |
| `itemId` | string |  | human or agent |
| `itemKind` | string |  | human or agent |
| `to` | array |  | human or agent |
| `state` | string | `open` `acknowledged` `addressed` (default `open`) | human or agent |
| `note` | string |  | human or agent |
| `response` | string |  | human or agent |

### proposal

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `itemId` | string |  | human or agent |
| `itemKind` | string |  | human or agent |
| `steerKind` | string | `recheck` `challenge` `cover` `verify` `priority` `note` (default `cover`) | human or agent |
| `rationale` | string |  | human or agent |
| `state` | string | `pending` `accepted` `declined` (default `pending`) | human or agent |

## Glossary of states

| enum | values | in plain words |
| --- | --- | --- |
| review state | `untouched` `scanning` `reviewed` `flagged` | nobody looked · being looked at · looked, nothing found · something smells |
| assumption state | `assumed` `verified` `invalidated` | taken for granted · checked and true · checked and false |
| hypothesis status | `testing` `confirmed` `dropped` | being proven · it is real · not a bug (say why in `dropReason`) |
| finding stage | `recon` `testing` `reported` `acknowledged` `fixed` `disclosed` | the responsible-disclosure pipeline |
| steer state | `open` `acknowledged` `addressed` | sent · the agent saw it · the agent reported back |
| steer action | `recheck` `challenge` `cover` `verify` `priority` `note` | what the human is asking for |
| agent status | `active` `idle` `stuck` `offline` | computed from presence; an agent may also report `stuck` itself |
