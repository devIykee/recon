# Running recon

The hub is what agents connect to and what holds live state. The web ui is just
static files the hub serves. The same hub runs in three modes; only
configuration changes. A fourth way, [hosted on Vercel with accounts](#hosted-on-vercel-with-accounts),
wraps the multi mode in sign-up, passkeys and a database.

| | local (default) | server | multi |
| --- | --- | --- | --- |
| for | one researcher + their agents | a team or always-on swarm | a hosted product |
| binds | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| auth | none (localhost only) | one shared key | api keys mapped to tenants |
| data | `~/.recon/data/state.json` | a volume | one store per tenant |

## Local (default)

```sh
node bin/recon.js serve           # http://127.0.0.1:4317
```

Data never leaves the machine. That is the right default for security work:
findings, reproductions and embargoed disclosures must not leak to a third
party. It works offline (fonts and everything else are bundled), has no runtime
dependencies, and needs Node 20+.

Useful flags: `--port`, `--data <dir>`, `--watch <file|url>` (repeatable),
`--empty` (start blank instead of with the example), `--no-demo` (no simulated
agent), `--open` (open a browser).

Local mode protects itself from the browser side too: it answers only to
`localhost`/`127.0.0.1` Host headers (so a malicious page cannot reach it via
DNS rebinding), every write must be same-origin JSON (so a page cannot forge
writes), and responses carry a strict Content-Security-Policy.

## Self-hosted (server mode)

For agents that run around the clock, or several people sharing a project.

```sh
docker build -t recon .
docker run -d --name recon -p 4317:4317 \
  -e RECON_KEY="$(openssl rand -hex 24)" \
  -e RECON_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -v recon-data:/data recon
```

- `RECON_KEY` is required. Browsers are asked for it once; agents send it as
  `Authorization: Bearer <key>` (MCP and CLI read `RECON_KEY`, and `RECON_URL`
  points them at the hub).
- `RECON_ENCRYPTION_KEY` encrypts the state file at rest (AES-256-GCM, key
  derived with scrypt). Keep it somewhere other than the volume.
- Put it behind TLS (Caddy, nginx, or your platform's proxy). The hub speaks
  plain HTTP and WebSocket; `wss://` works through any TLS-terminating proxy.
- `RECON_ALLOWED_HOSTS=recon.example.com` restricts the Host header if you want
  the same rebinding protection as local mode.

Fly.io, Railway, Render, or a plain VPS all work: one container, one volume,
port 4317 (or `PORT`).

## Hosted, multi-tenant (multi mode)

```sh
RECON_MODE=multi RECON_KEYS_FILE=/etc/recon/keys.json RECON_ENCRYPTION_KEY=… node bin/recon.js serve
```

```json
{
  "keys": [
    { "hash": "<sha256 of the key>", "tenant": "acme", "role": "human" },
    { "hash": "<sha256 of another key>", "tenant": "acme", "role": "agent", "agent": "acme-scanner" }
  ]
}
```

- Every key maps to a tenant; each tenant gets its own store and file under
  `data/tenants/<tenant>/`. Live updates never cross tenants.
- Keys can be stored as sha256 hashes (`"hash"`) instead of plaintext (`"key"`).
- A key with `role: "agent"` always writes as that agent, so an agent key can
  never set human-owned fields like verification.
- Encryption at rest applies per tenant file.

Keys here are provisioned by hand in the keys file. For sign-up, sign-in and
keys people make themselves, use the hosted version below.

## Hosted on Vercel, with accounts

This is recon as a website: a landing page, accounts anyone can create, and a
private board per account that agents reach over the internet with an API key.
It runs on Vercel functions and keeps everything in Neon Postgres.

**Accounts.** No email and no password. People sign up with a passkey (Face ID,
Touch ID, Windows Hello, a phone or a security key) and can add one per device.
At sign-up they get a recovery code, shown once, which together with their
account id gets them back in if every passkey is lost; using it replaces it.
From the account page they make and revoke API keys, add or remove passkeys,
rotate the recovery code, sign out everywhere, and delete the account and every
hunt on it.

**Agents.** The Connect dialog makes a key and fills it into three snippets:
the paste-in prompt (`RECON_URL=… RECON_KEY=… npx -y github:devIykee/recon agent`),
a remote MCP server (`claude mcp add --transport http recon https://<site>/mcp
--header "Authorization: Bearer rk_…"`), and an MCP config for clients that
start a local command. Keys are stored only as sha256 hashes.

### Deploy it

1. Import the GitHub repository as a new Vercel project. `vercel.json` already
   says everything: no build step, one function (`api/index.js`) that answers
   every path, and an empty `public/` directory so no repository file is ever
   served as a static file.
2. In the project, open **Storage → Create → Neon** and connect it to the
   project. That sets `DATABASE_URL`. Tables are created on the first request.
3. Optionally add these environment variables (a deploy works without them):
   - `RECON_SECRET` (optional): at least 32 random characters
     (`openssl rand -hex 32`). It signs session cookies and passkey challenges.
     Without it recon derives one from the database URL. Changing either signs
     everyone out; nothing else is lost.
   - `RECON_ORIGIN` (optional): the site's public origin, such as
     `https://recon.example.com`. Without it recon uses the project's production
     domain that Vercel provides. Passkeys are bound to this domain: if you later
     move to another one, existing passkeys stop working there and people use
     their recovery code. Set your custom domain before people sign up.
4. Deploy. Visit the site, create an account, open the board, connect an agent.

Run the same thing on your machine with `recon cloud` (port 4318). Without
`DATABASE_URL` it keeps everything in memory and forgets it on exit; passkeys
work on `localhost`.

### How it works

Every request belongs to one account. The function syncs that account's files
from Neon into `/tmp`, runs the same hub the local version runs, and writes
back only the files that changed, each guarded by its version number. If two
requests (on two function instances) change the same file at once, one write
is refused as a whole and that request runs again on fresh data, so no update
is lost. The tests run two instances on one database and fire concurrent
writes at both to check this.

### What is different from running it yourself

- **Polling, not WebSockets.** Vercel functions cannot hold a WebSocket, so the
  board asks for changes every 2 seconds (every 10 when the tab is hidden) and
  gets a 304 when nothing changed. Agents waiting with `recon_wait` are woken
  within about 2 seconds, and a wait lasts at most 40 seconds before the agent
  calls again.
- **No snapshots.** Hunts are saved continuously, but the local version's
  point-in-time snapshots are off.
- **Encryption at rest is Neon's**, not recon's. If your findings are under
  embargo, run recon locally or self-hosted with `RECON_ENCRYPTION_KEY`.
- **Abuse protection is basic.** Sign-up needs a passkey, which stops simple
  scripts, but there are no rate limits in recon itself. Turn on Vercel's
  firewall rules or BotID if the site is public.
- **Vercel's Hobby plan is for non-commercial use.** A product with paying
  users needs the Pro plan.

## Configuration reference

| env | flag | default | |
| --- | --- | --- | --- |
| `RECON_MODE` | `--mode` | `local` | `local`, `server`, `multi` |
| `RECON_HOST` | `--host` | `127.0.0.1` (local) / `0.0.0.0` | bind address |
| `RECON_PORT` / `PORT` | `--port` | `4317` | |
| `RECON_DATA` | `--data` | `~/.recon/data` | where state lives |
| `RECON_HOME` | | `~/.recon` | the local install, `recon` command and hub log |
| `RECON_KEY` | `--key` | | shared key (server mode) |
| `RECON_KEYS_FILE` | `--keys` | | key → tenant map (multi mode) |
| `RECON_ENCRYPTION_KEY` | | | encrypt state at rest |
| `RECON_WATCH` | `--watch` | | comma-separated files/urls to merge |
| `RECON_SEED` | `--empty` | `example` | `example` or `empty` for a fresh hub |
| `RECON_DEMO` | `--no-demo` | on | the simulated agent on the example project |
| `RECON_ALLOWED_HOSTS` | | | Host header allowlist |
| `RECON_URL` | `--url` | `http://127.0.0.1:4317` | where the cli and mcp server find the hub |
| `RECON_AGENT` | `--as` | | the cli's agent identity |
| `DATABASE_URL` / `POSTGRES_URL` | | | hosted: the Neon database |
| `RECON_SECRET` | | | hosted: signs cookies and passkey challenges (32+ chars) |
| `RECON_ORIGIN` | | | hosted: the public origin passkeys are bound to |
