// `recon mcp` as the agent sees it: a thin process that passes MCP messages to a
// worker running the real server, and swaps the worker for the new version when
// `recon update` (or any reinstall) changes ~/.recon/app. The agent keeps its
// connection, its hunt and its session; its client is told the tool list changed.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { installHash, reconHome } from './launch.js';

const SWAP_INIT = 'recon-swap-init';

export function runSupervisor({ bin, args = [], home = reconHome(), input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`${m}\n`), pollMs = 2000, watch = true } = {}) {
  let worker = null;
  let initMsg = null;
  let initialized = false;
  let hunt = null;
  let closed = false;
  let lastHash = installHash(home);
  let swaps = 0;
  const send = (msg) => output.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);

  const argsWith = (extra) => {
    // a hunt the agent switched to is carried over; drop any --hunt from the original args
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--hunt' && extra.length) { i++; continue; }
      if (args[i].startsWith('--hunt=') && extra.length) continue;
      out.push(args[i]);
    }
    return [...out, ...extra, '--worker'];
  };

  function start(extra = []) {
    const child = spawn(process.execPath, [bin, 'mcp', ...argsWith(extra)], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
    const w = { child, pending: new Set(), ready: true, queue: [], retiring: false };
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      let m;
      try { m = JSON.parse(line); } catch { send(line); return; }
      if (m.method === 'notifications/recon/hunt') { hunt = m.params?.hunt || null; return; }
      if (m.id === SWAP_INIT) { onSwapped(w); return; }
      if (m.id !== undefined && m.id !== null && !m.method) w.pending.delete(m.id);
      send(line);
      if (w.retiring && !w.pending.size) retire(w);
    });
    child.on('exit', (code) => {
      if (closed || w.retiring) return;
      if (w === worker) {
        log(`recon mcp: the server stopped (${code}); starting it again`);
        swap();
      }
    });
    child.stdin.on('error', () => {});
    return w;
  }

  function write(w, line) {
    if (!w.ready) { w.queue.push(line); return; }
    w.child.stdin.write(`${line}\n`);
  }

  function retire(w) {
    if (w.child.exitCode !== null) return;
    w.child.stdin.end();
    setTimeout(() => { if (w.child.exitCode === null) w.child.kill(); }, 5000).unref?.();
  }

  // Start the new version, replay the handshake, then move traffic over.
  function swap() {
    const old = worker;
    const w = start(hunt ? ['--hunt', hunt] : []);
    worker = w;
    swaps++;
    if (initMsg) {
      w.ready = false;
      w.child.stdin.write(`${JSON.stringify({ ...initMsg, id: SWAP_INIT })}\n`);
    }
    if (old && old !== w) {
      old.retiring = true;
      if (!old.pending.size) retire(old);
    }
  }

  function onSwapped(w) {
    if (initialized) w.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    w.ready = true;
    for (const line of w.queue.splice(0)) w.child.stdin.write(`${line}\n`);
    // the tools may have changed with the new version
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    send({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
    log(`recon mcp: switched to the updated recon${hunt ? ` (still in the hunt "${hunt}")` : ''}`);
  }

  worker = start([]);

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let m = null;
    try { m = JSON.parse(line); } catch { /* the worker answers with a parse error */ }
    if (m?.method === 'initialize') initMsg = m;
    if (m?.method === 'notifications/initialized') initialized = true;
    if (m && m.method && m.id !== undefined && m.id !== null) worker.pending.add(m.id);
    write(worker, line);
  });

  const timer = watch ? setInterval(() => {
    const h = installHash(home);
    if (h && h !== lastHash) { lastHash = h; swap(); }
  }, pollMs) : null;

  return new Promise((resolve) => {
    rl.on('close', () => {
      closed = true;
      if (timer) clearInterval(timer);
      worker.child.stdin.end();
      const done = () => resolve({ swaps });
      if (worker.child.exitCode !== null) done(); else worker.child.on('exit', done);
      setTimeout(() => { if (worker.child.exitCode === null) worker.child.kill(); }, 3000).unref?.();
    });
  });
}
