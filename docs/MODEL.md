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
| `evidence` | `[{ id, kind, ref, note, by, at }]`, `kind` one of `code` `test` `fork` `tx` `log` `link` `note` (guessed from `ref` if omitted) |
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
| `transports` | array |  | human or agent |
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
| `protocolType` | string | `lending` `amm` `perps` `bridge` `staking` `nft-market` `governance` `oracle` `token` `vault` `factory` `dao-module` `nft-custody` `naming` `other` (default `other`) | human or agent |
| `description` | string |  | human or agent |
| `focus` | string |  | human or agent |
| `scope` | string |  | human or agent |
| `phase` | string | `mapping` `assumptions` `hunting` `reporting` (default `mapping`) | human or agent |
| `inScope` | string |  | human or agent |
| `outOfScope` | string |  | human or agent |
| `alreadyReported` | array |  | human or agent |
| `disclosureChannel` | string |  | human or agent |
| `severityScale` | string |  | human or agent |
| `bountyRules` | string |  | human or agent |
| `playbooks` | array |  | human or agent |
| `ignoredClasses` | array |  | human or agent |

### component

| field | type | values | who writes |
| --- | --- | --- | --- |
| `targetId` *(required)* | string |  | human or agent |
| `name` *(required)* | string |  | human or agent |
| `type` | string | `contract` `function` `module` `endpoint` `storage` `config` `actor` `external` `other` (default `contract`) | human or agent |
| `reviewState` | string | `untouched` `scanning` `reviewed` `flagged` (default `untouched`) | human or agent |
| `summary` | string |  | human or agent |
| `location` | string |  | human or agent |
| `owner` | string |  | human or agent |
| `checklist` | object |  | human or agent |
| `notes` | string |  | human or agent |
| `surface` | array |  | human or agent |

### relation

| field | type | values | who writes |
| --- | --- | --- | --- |
| `targetId` *(required)* | string |  | human or agent |
| `from` *(required)* | string |  | human or agent |
| `to` *(required)* | string |  | human or agent |
| `type` | string | `calls` `delegates` `inherits` `reads` `writes` `transfers` `mints` `owns` `configures` `trusts` `other` (default `calls`) | human or agent |
| `label` | string |  | human or agent |

### assumption

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `origin` | string | `developer` `agent` (default `agent`) | human or agent |
| `category` | string | `trust` `invariant` `input` `external` `economic` `other` (default `other`) | human or agent |
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
| `exploitStage` | string | `capability` `trigger` `full` | human or agent |
| `trigger` | string |  | human or agent |
| `confirm` | object |  | human or agent |

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
| `attacker` | string | `stranger` `holder` `privileged` `admin` | human or agent |
| `reachability` | string | `permissionless` `needs-role` `needs-config` `needs-social` | human or agent |
| `bound` | string |  | human or agent |
| `liveFunds` | string |  | human or agent |
| `liveFundsMethod` | string | `eth_call` `fork` `explorer` `not-measured` | human or agent |
| `alreadyReported` | string | `no` `yes` `unknown` | human or agent |
| `alreadyReportedRef` | string |  | human or agent |
| `verificationMethod` | string | `fork` `eth_call` `unit` `fuzz` `live-tx` `manual` | human or agent |
| `testName` | string |  | human or agent |
| `testResult` | string | `pass` `fail` `not-run` | human or agent |
| `productionTouched` | boolean |  | human or agent |
| `productionNote` | string |  | human or agent |
| `fix` | string |  | human or agent |

### chain

| field | type | values | who writes |
| --- | --- | --- | --- |
| `title` *(required)* | string |  | human or agent |
| `targetId` | string |  | human or agent |
| `parts` | array |  | human or agent |
| `glue` | string | `same-tx` `same-caller` `config+code` `social+code` `other` (default `other`) | human or agent |
| `gluePermissionless` | boolean |  | human or agent |
| `result` | string |  | human or agent |
| `severity` | string | `critical` `high` `medium` `low` `info` (default `medium`) | human or agent |

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
| `options` | array |  | human or agent |
| `choice` | string |  | human or agent |
| `state` | string | `pending` `accepted` `declined` (default `pending`) | human or agent |

### lead

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `why` | string |  | human or agent |
| `value` | string | `high` `med` `low` (default `med`) | human or agent |
| `state` | string | `open` `blocked` `done` `dropped` (default `open`) | human or agent |
| `blockedBy` | string |  | human or agent |
| `nextStep` | string |  | human or agent |
| `outcome` | string |  | human or agent |
| `targetId` | string |  | human or agent |
| `componentId` | string |  | human or agent |
| `itemId` | string |  | human or agent |

### message

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `to` | array |  | human or agent |
| `itemId` | string |  | human or agent |
| `replyTo` | string |  | human or agent |

### rule

| field | type | values | who writes |
| --- | --- | --- | --- |
| `text` *(required)* | string |  | human or agent |
| `targetId` | string |  | human or agent |
| `category` | string | `conservation` `solvency` `accounting` `bound` `access` `ordering` `other` (default `conservation`) | human or agent |
| `state` | array |  | human or agent |
| `formal` | string |  | human or agent |
| `engine` | string | `foundry-invariant` `foundry-fuzz` `halmos` `hevm` `echidna` `medusa` `certora` `kontrol` `manual` | human or agent |
| `status` | string | `untested` `holds` `broken` `inconclusive` (default `untested`) | human or agent |
| `runs` | string |  | human or agent |
| `counterexample` | string |  | human or agent |
| `hypothesisId` | string |  | human or agent |

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
