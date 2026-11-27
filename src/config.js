// One hub, three deployments. Only configuration differs:
//
//   local  (default) - binds 127.0.0.1, no key, data in ~/.recon/data. Data never leaves the machine.
//   server           - self-hosted (docker/vps). Binds 0.0.0.0 and requires RECON_KEY.
//   multi            - multi-tenant. Keys map to tenants via RECON_KEYS_FILE; each tenant
//                      gets its own isolated store (and its own encrypted file, if a key is set).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4317;

export function loadConfig(overrides = {}, env = process.env) {
  const mode = overrides.mode || env.RECON_MODE || 'local';
  if (!['local', 'server', 'multi'].includes(mode)) throw new Error(`RECON_MODE must be local, server or multi (got ${mode})`);
  const cfg = {
    mode,
    host: overrides.host || env.RECON_HOST || (mode === 'local' ? '127.0.0.1' : '0.0.0.0'),
    port: Number(overrides.port ?? env.RECON_PORT ?? env.PORT ?? DEFAULT_PORT),
    dataDir: path.resolve(overrides.dataDir || env.RECON_DATA || path.join(env.RECON_HOME || path.join(os.homedir(), '.recon'), 'data')),
    key: overrides.key ?? env.RECON_KEY ?? null,
    keysFile: overrides.keysFile || env.RECON_KEYS_FILE || null,
    encryptionKey: overrides.encryptionKey ?? env.RECON_ENCRYPTION_KEY ?? null,
    seed: overrides.seed || env.RECON_SEED || 'example', // example | empty
    demo: overrides.demo ?? (env.RECON_DEMO ? env.RECON_DEMO !== '0' : true),
    watch: overrides.watch || (env.RECON_WATCH ? env.RECON_WATCH.split(',').filter(Boolean) : []),
    webDir: overrides.webDir || path.join(ROOT, 'web'),
    allowedHosts: overrides.allowedHosts || (env.RECON_ALLOWED_HOSTS ? env.RECON_ALLOWED_HOSTS.split(',') : null),
    insecure: overrides.insecure ?? env.RECON_INSECURE === '1',
    log: overrides.log || ((...a) => console.error(...a)),
  };
  if (mode === 'server' && !cfg.key && !cfg.insecure) {
    throw new Error('server mode needs RECON_KEY (or --key). agents and browsers send it as a bearer token. use --insecure only on a trusted network.');
  }
  if (mode === 'multi') {
    if (!cfg.keysFile) throw new Error('multi mode needs RECON_KEYS_FILE, a json file mapping api keys to tenants');
    cfg.tenants = loadKeys(cfg.keysFile);
  }
  if (mode === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(cfg.host) && !cfg.key && !cfg.insecure) {
    throw new Error(`refusing to expose an unauthenticated hub on ${cfg.host}. set --key, or use --mode server.`);
  }
  return cfg;
}

// keys file: { "keys": [ { "key": "...", "tenant": "acme", "role": "human" }, { "hash": "<sha256>", "tenant": "acme", "role": "agent", "agent": "scout" } ] }
function loadKeys(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(doc) ? doc : doc.keys;
  if (!Array.isArray(list) || !list.length) throw new Error('keys file has no keys');
  for (const k of list) {
    if (!k.tenant || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(k.tenant)) throw new Error(`invalid tenant id "${k.tenant}"`);
    if (!k.key && !k.hash) throw new Error('each key entry needs "key" or "hash" (sha256 hex)');
  }
  return list;
}
