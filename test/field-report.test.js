import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../src/hub.js';
import { createClient } from '../src/client.js';
import { Store } from '../src/store.js';
import { normalizeEvidence, guessEvidenceKind } from '../src/model.js';
import { evidenceGaps, steersBeingIgnored } from '../src/quality.js';
import { lintProse, checkSubmission, buildReport, reportBrief, buildHandoff } from '../src/report.js';
import { mustDo } from '../src/proactive.js';
import { suggest } from '../src/knowledge.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'recon-fr-'));

test('P2: recon_steer over HTTP MCP and CLI parity, plus hunt-aware 404', async () => {
  const hub = createHub({ dataDir: tmp(), port: 0, demo: false, seed: 'empty' });
  await hub.listen();
  try {
    const cli = createClient({ url: hub.url, agent: 'scout' });
    await cli.heartbeat({ focus: 'starting' });
    const steer = await createClient({ url: hub.url }).create('steer', { action: 'note', to: ['ag_scout'], note: 'check Vault.withdraw()' });

    // Initialize MCP session
    const init = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-recon-agent': 'scout' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'scout', version: '1' } } }),
    });
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid);

    // Ack steer via MCP recon_steer
    const ackRes = await (await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': sid, 'x-recon-agent': 'scout' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recon_steer', arguments: { steerId: steer.id, state: 'acknowledged' } } }),
    })).json();
    assert.equal(ackRes.result.isError, undefined);
    const acked = JSON.parse(ackRes.result.content[0].text);
    assert.equal(acked.state, 'acknowledged');

    // CLI sees the exact same acknowledged state
    const got = await cli.get('steer', steer.id);
    assert.equal(got.item.state, 'acknowledged');

    // Missing steer error names the current hunt
    await assert.rejects(() => cli.steer('st_doesnotexist', 'ack'), /not found in hunt/);
  } finally {
    await hub.close();
  }
});

test('P3: queued and waiting-on-human steer states prevent batch-ack lockout; steer dedup', async () => {
  const hub = createHub({ dataDir: tmp(), port: 0, demo: false, seed: 'empty' });
  await hub.listen();
  try {
    const human = createClient({ url: hub.url });
    const agent = createClient({ url: hub.url, agent: 'scout' });
    await agent.heartbeat({ focus: 'hunting' });

    // Create 5 steers; ack first, queue the other 4
    const steers = [];
    for (let i = 0; i < 5; i++) {
      steers.push(await human.create('steer', { action: 'note', to: ['ag_scout'], note: `task ${i}` }));
    }
    await agent.steer(steers[0].id, 'ack');
    for (let i = 1; i < 5; i++) await agent.steer(steers[i].id, 'queue');

    // Only the actively acknowledged steer is tracked for lockout, not the 4 queued ones
    const st = await human.state();
    assert.equal(steersBeingIgnored(st, 'ag_scout', Date.now() + 20 * 60_000).length, 1);

    // Marking waiting-on-human clears it from overdue/ignored
    await agent.steer(steers[0].id, 'wait-human', 'Drafted report; ready for you to email security@acme.example');
    const st2 = await human.state();
    assert.equal(steersBeingIgnored(st2, 'ag_scout', Date.now() + 20 * 60_000).length, 0);

    // Steer deduplication: creating same note to same recipient returns existing open steer
    const dup1 = await human.create('steer', { action: 'note', to: ['ag_scout'], note: 'unique dedup note' });
    const dup2 = await human.create('steer', { action: 'note', to: ['ag_scout'], note: 'unique dedup note' });
    assert.equal(dup1.id, dup2.id);
  } finally {
    await hub.close();
  }
});

test('P5: evidence fork/log detection, collapsed-ref rejection, rich evidenceGaps, removeEvidence', async () => {
  assert.equal(guessEvidenceKind('mainnet fork run, 5M position'), 'fork');
  assert.equal(guessEvidenceKind('forge test --fork-url $ETH_RPC_URL'), 'fork');
  assert.equal(guessEvidenceKind('trace-output.log'), 'log');

  assert.throws(() => normalizeEvidence([{ ref: 'src/Vault.sol:12|https://etherscan.io/tx/0x1|test_Drain' }], 'ag_a'), /multiple refs joined with "\|"/);

  const gaps = evidenceGaps({ id: 'fd_123', evidence: [{ kind: 'code', ref: 'Vault.sol:10' }, { kind: 'note', ref: 'something' }] });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /you attached 2 item\(s\): code, note/);
  assert.match(gaps[0], /recon evidence fd_123/);

  const hub = createHub({ dataDir: tmp(), port: 0, demo: false, seed: 'empty' });
  await hub.listen();
  try {
    const cli = createClient({ url: hub.url, agent: 'scout' });
    const t = await cli.create('target', { name: 'Acme', protocolType: 'vault' });
    const c = await cli.create('component', { targetId: t.id, name: 'Vault.sol' });
    const added = await cli.evidence('component', c.id, { kind: 'fork', ref: 'mainnet fork', command: 'forge test --fork-url $RPC', env: ['RPC'] });
    assert.equal(added.evidence[0].command, 'forge test --fork-url $RPC');
    assert.deepEqual(added.evidence[0].env, ['RPC']);
    const removed = await cli.removeEvidence('component', c.id, added.evidence[0].id);
    assert.equal(removed.evidence.length, 0);
  } finally {
    await hub.close();
  }
});

test('P6: client URL failover, ngrok offline diagnosis, and hosted /api/connect MCP config', async () => {
  const hub = createHub({ dataDir: tmp(), port: 0, demo: false, seed: 'empty' });
  await hub.listen();
  try {
    // Fallback from dead tunnel URL to live hub URL
    const c = createClient({
      url: `https://dead-tunnel.ngrok.example,${hub.url}`,
      fetch: async (u, init) => {
        if (String(u).includes('ngrok')) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '<html>ERR_NGROK_3200 tunnel offline</html>' };
        return globalThis.fetch(u, init);
      },
    });
    const h = await c.health();
    assert.equal(h.ok, true);
    assert.equal(c.url, hub.url);

    // /api/connect returns ready mcpConfig with x-recon-agent header
    const conn = await (await fetch(`${hub.url}/api/connect`)).json();
    assert.equal(conn.mcpConfig.mcpServers.recon.headers['x-recon-agent'], '<agent-name>');
  } finally {
    await hub.close();
  }
});

test('P7 & P10: actionable proposals, foldedInto, narrower rewrite trigger, sign-off aliases, PoC appendix, disclosure handoff', async () => {
  const hub = createHub({ dataDir: tmp(), port: 0, demo: false, seed: 'empty' });
  await hub.listen();
  try {
    const human = createClient({ url: hub.url });
    const agent = createClient({ url: hub.url, agent: 'scout' });
    const t = await human.create('target', { name: 'Acme', protocolType: 'vault', phase: 'hunting', securityContact: 'security@acme.example' });
    const comp = await human.create('component', { targetId: t.id, name: 'Vault.sol' });

    const f1 = await human.create('finding', {
      title: 'Primary vault drain', targetId: t.id, componentId: comp.id, severity: 'high', bugClass: 'rounding',
      attacker: 'stranger', reachability: 'permissionless', bound: 'bounded by vault balance',
      liveFunds: '0x123 5M USDC', liveFundsMethod: 'fork', alreadyReported: 'no',
      verificationMethod: 'fork', testName: 'test_Drain', testResult: 'pass', fix: 'Round shares up',
      evidence: [{ kind: 'code', ref: 'Vault.sol:100' }, { kind: 'fork', ref: 'mainnet fork run' }],
    });
    const f2 = await human.create('finding', {
      title: 'Secondary symptom of rounding', targetId: t.id, componentId: comp.id, severity: 'medium', bugClass: 'accounting',
      attacker: 'stranger', reachability: 'permissionless', bound: 'bounded by vault balance',
      liveFunds: 'none', alreadyReported: 'no', verificationMethod: 'unit', testName: 'test_Sym', testResult: 'pass',
      foldedInto: f1.id,
      evidence: [{ kind: 'code', ref: 'Vault.sol:110' }, { kind: 'test', ref: 'test_Sym' }],
    });

    // Actionable proposal sets report shape & signOff on accept
    const prop = await agent.create('proposal', {
      text: 'Choose report shape',
      options: ['combined', 'separate'],
      onAccept: { report: { shape: 'combined', signOff: 'alice (Alice)' } },
    });
    await human.proposal(prop.id, 'accept', 'combined');
    const rep = await human.report();
    assert.equal(rep.config.shape, 'combined');
    assert.equal(rep.config.signOff, 'alice (Alice)');
    // f2 is folded into f1, so only f1 is in included
    assert.deepEqual(rep.included.map((x) => x.id), [f1.id]);

    // Brief includes f2 under f1.foldedFindings
    const brief = await agent.reportBrief();
    assert.equal(brief.facts.findings[0].foldedFindings.length, 1);
    assert.equal(brief.facts.findings[0].foldedFindings[0].id, f2.id);

    // Prose lint accepts alias ("alice") and exempts fenced PoC code after --- APPENDIX ---
    const body = [
      'Hi Acme team,',
      '',
      'This is a high severity rounding issue in Vault.sol that lets any caller extract value up to the vault balance.',
      '',
      'Rounding shares down on withdraw lets an attacker siphon funds. Round shares up to fix it.',
      '',
      'Best,',
      'alice',
      '',
      '--- APPENDIX ---',
      '```solidity',
      'function test_Drain() public { assertTrue(true); }',
      '```',
    ].join('\n');
    assert.deepEqual(lintProse(body, { signOff: 'alice (Alice)' }), []);

    // Submit report returns disclosure handoff with mailto
    const sub = await agent.submitReport([{ findingIds: [f1.id], body }]);
    assert.equal(sub.handoff.length, 1);
    assert.equal(sub.handoff[0].to, 'security@acme.example');
    assert.match(sub.handoff[0].mailto, /^mailto:security%40acme\.example/);

    // Changing card-hygiene field (alreadyReportedRef) on f1 does NOT trigger rewrite
    await new Promise((r) => setTimeout(r, 10));
    await human.update('finding', f1.id, { alreadyReportedRef: 'checked prior audit 2025' });
    const st = await human.state();
    assert.equal(mustDo(st, 'ag_scout').some((m) => m.kind === 'report' && /rewrite/i.test(m.do)), false);
  } finally {
    await hub.close();
  }
});

test('P8: repro suggestion counts fork/test evidence and out-of-scope assumptions are suppressed', () => {
  const store = new Store({ file: null });
  const t = store.create('target', {
    name: 'Acme', protocolType: 'vault', phase: 'hunting',
    outOfScope: 'CCIP token pools, lockboxes, and privileged admin role issues are out of scope.',
  }, 'human');
  const c = store.create('component', { targetId: t.id, name: 'Vault.sol' }, 'human');

  // Finding with fork evidence but empty repro field -> no "Get a reproduction" suggestion
  const f = store.create('finding', {
    title: 'Fork-proven bug', targetId: t.id, componentId: c.id, severity: 'high',
    attacker: 'stranger', reachability: 'permissionless', bound: 'bounded',
    liveFunds: 'none', alreadyReported: 'no', verificationMethod: 'fork', testName: 'test_X', testResult: 'pass',
    evidence: [{ kind: 'code', ref: 'Vault.sol:10' }, { kind: 'fork', ref: 'mainnet fork' }],
  }, 'human');

  // Out-of-scope assumption -> suppressed from challenge suggestions
  const aOos = store.create('assumption', {
    targetId: t.id, text: 'CCIP lockbox bridge cannot be paused by privileged admin', origin: 'developer',
  }, 'human');
  const aIn = store.create('assumption', {
    targetId: t.id, text: 'Share price never decreases during normal deposits', origin: 'developer',
  }, 'human');

  const sugs = suggest(store.state, { limit: 50 });
  assert.equal(sugs.some((s) => s.rule === 'finding-no-repro' && s.itemId === f.id), false);
  assert.equal(sugs.some((s) => s.rule === 'unverified-assumption' && s.itemId === aOos.id), false);
  assert.equal(sugs.some((s) => s.rule === 'unverified-assumption' && s.itemId === aIn.id), true);
});
