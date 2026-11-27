# Running recon

The hub is what agents connect to and what holds live state. The web ui is just
static files the hub serves. The same hub runs in three modes; only
configuration changes.

| | local (default) | server | multi |
| --- | --- | --- | --- |
| for | one researcher + their agents | a team or always-on swarm | a hosted product |
| binds | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| auth | none (localhost only) | one shared key | api keys mapped to tenants |
| data | `./.recon/state.json` | a volume | one store per tenant |

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

What this mode does not do yet, and a real hosted product needs: sign-in
(today keys are provisioned in the keys file), per-tenant encryption keys or
bring-your-own-storage, client-side encryption of evidence, and rate limits.
The design keeps these additive: they sit in front of, or inside, `Tenant` in
`src/hub.js` without changing how agents connect.

## Configuration reference

| env | flag | default | |
| --- | --- | --- | --- |
| `RECON_MODE` | `--mode` | `local` | `local`, `server`, `multi` |
| `RECON_HOST` | `--host` | `127.0.0.1` (local) / `0.0.0.0` | bind address |
| `RECON_PORT` / `PORT` | `--port` | `4317` | |
| `RECON_DATA` | `--data` | `./.recon` | where state lives |
| `RECON_KEY` | `--key` | | shared key (server mode) |
| `RECON_KEYS_FILE` | `--keys` | | key → tenant map (multi mode) |
| `RECON_ENCRYPTION_KEY` | | | encrypt state at rest |
| `RECON_WATCH` | `--watch` | | comma-separated files/urls to merge |
| `RECON_SEED` | `--empty` | `example` | `example` or `empty` for a fresh hub |
| `RECON_DEMO` | `--no-demo` | on | the simulated agent on the example project |
| `RECON_ALLOWED_HOSTS` | | | Host header allowlist |
| `RECON_URL` | `--url` | `http://127.0.0.1:4317` | where the cli and mcp server find the hub |
| `RECON_AGENT` | `--as` | | the cli's agent identity |
