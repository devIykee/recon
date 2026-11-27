# Contributing to recon

Thanks for wanting to make recon better. It is a small codebase with a few strong
opinions, and this page is mostly about those, so your change fits on the first try.

## What recon is trying to be

A shared board where a person and their agents hunt vulnerabilities together,
and where the agent's work stays honest: every claim has evidence, every
severity is earned, nothing the human said gets lost. When you are unsure
whether a change belongs, ask whether it makes the hunt more *visible*, more
*honest*, or *easier to steer*. If it does none of those, it probably belongs
somewhere else.

## Ground rules

- **Zero dependencies.** recon runs from `npx` with nothing to install. Use
  what Node ships (`node:http`, `node:test`, `node:crypto`, `fetch`, `zlib`).
  A new dependency needs a very good reason in the pull request.
- **No build step.** The UI in `web/` is plain ES modules loaded straight by the
  browser. What is in the repository is what runs.
- **Local-first.** Nothing leaves the machine unless the person asked for it.
  Findings and embargoed disclosures are sensitive; treat them that way.
- **Gates, not guidelines.** If agents keep getting something wrong, the fix is
  usually a gate in `src/quality.js` that refuses the write and says exactly
  what to do instead, plus a test. Prompt wording alone drifts.
- **Plain words.** The board is read by people who are not security experts.
  Copy says what something is, what is known, and what to do next, in full
  sentences. Explain jargon or avoid it.
- **Never fake a result.** No made-up test outcomes, funds, or verification, in
  code, fixtures presented as real, or docs. If something was not measured, say
  so.

## Getting set up

You need Node 20 or newer and `git`. That is all.

```sh
git clone https://github.com/devIykee/recon.git
cd recon
npm test                                   # the whole suite, about a minute
node bin/recon.js serve --empty --no-demo  # a board at http://127.0.0.1:4317
```

`node bin/recon.js serve` without `--empty` opens on the built-in example with
**Scout**, a simulated agent, which is the quickest way to see a change move.

To try your checkout the way users run it (installed in `~/.recon/app`, with
every connected agent switching over live):

```sh
node bin/recon.js update --from .
```

Point an agent at your local board with `node bin/recon.js mcp --name my-agent`,
or paste the agent line from the README into any coding agent.

## Where things live

```
bin/recon.js        the cli: serve, mcp, setup, update, and every read/write command
src/model.js        every kind of item, its fields and enums, who may write each field
src/store.js        the per-field store: writes, merges, persistence, encryption at rest
src/quality.js      the gates agents must pass (steers, finding card, severity, evidence)
src/proactive.js    what an agent must do now, its pulse, before-you-stop
src/knowledge.js    exploit classes, playbooks, checklists, suggestions, the briefing
src/rules.js        rules: exposure, starter rules per protocol, engine hints
src/scan.js         the Solidity scanner; mapping.js puts a map on the board
src/report.js       the report brief, the prose checks, submission
src/skills.js       skills as SKILL.md folders
src/engagements.js  hunts: one file each, snapshots, restore, trash
src/hub.js          http api, websocket, auth, mcp over http, static ui
src/mcp.js          the mcp tools; mcpsup.js swaps the server for a new version live
src/setup.js        one-line setup for every agent cli; update.js for recon update
web/js/             the ui, one module per area (map, sysmap, boards, sidebar, panels…)
docs/               API.md, MODEL.md, DEPLOY.md and the README screenshots
test/               node:test suites, with fixtures under test/fixtures
```

## Common changes

**A new field or kind of item.** Add it to `SCHEMA` (and `ENUMS` if it has
fixed values) in `src/model.js`, give new kinds an id prefix, and make sure
`src/client.js` can resolve that prefix. Then regenerate the field tables in
`docs/MODEL.md` so they match the schema. Human-only fields (verdicts,
priority, assignment) are marked as such and agents must never be able to set
them.

**A new MCP tool.** Add it to `TOOLS` in `src/mcp.js` with a description
written for the agent: what it does, when to use it, and what a refusal means.
Give it a CLI command in `bin/recon.js` and the agent guide in `src/setup.js`
if CLI agents need it, and a row in `docs/API.md`. Keep the tool count in the
README right.

**A new gate.** Put it in `enforce()` in `src/quality.js`. The error has to say
what to do instead, in one or two sentences an agent can act on. Add a test
that shows the refusal and the write that passes.

**Playbooks, exploit classes and rules.** Classes and playbooks live in
`src/knowledge.js`, starter rules per protocol type in `src/rules.js`. Write
them the way a good reviewer would explain them to a newcomer.

**The UI.** Build elements with `h()` from `web/js/ui.js`, put shared words,
colors and icons in `web/js/labels.js`, and use the CSS variables, never fixed
colors, so every theme works. If you add a clickable item, give it a plain
summary in `web/js/story.js`. Check light and dark, the text sizes in
Appearance, and a phone-sized window.

## Tests

```sh
npm test                               # everything
node --test test/rules.test.js         # one file
node --test --test-name-pattern="lens" test/rules.test.js
```

Every change that touches behavior comes with a test. Tests start their own hub
on port 0 with a temporary data folder, so they never touch your `~/.recon`.
The update tests use the system `tar` to build a GitHub-style tarball.

For the UI, a quick headless check is often worth more than a long
explanation: Playwright works well, and a screenshot of the change belongs in
the pull request.

Changes to how agents behave (briefing, gates, tools, wording) should also be
tried with a real agent when you can: run a short hunt on the vault in
`test/fixtures/vault` and say in the pull request what the agent did.

## Commits and pull requests

- One idea per commit. The title says what changed in plain words
  ("Popovers stay on screen at every text size"), the body says why and what
  the person or agent will notice. Look at `git log` for the tone.
- Keep pull requests focused and describe how you tested them: which tests,
  which screens, which agent.
- Update the README and `docs/` when what someone sees or calls changes.

## Reporting a vulnerability in recon

Please do not open a public issue. Use a private security advisory on GitHub
(Security → Report a vulnerability) with what you found, how to reproduce it,
and what it lets an attacker do. You will get an answer before anything is
made public.

## License

By contributing you agree that your work is released under the MIT license,
like the rest of recon.
