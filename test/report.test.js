import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { createHub } from '../src/hub.js';
import { runMcp } from '../src/mcp.js';
import { lintProse } from '../src/report.js';
import { Skills, parseSkill, DISCLOSURE_REPORT } from '../src/skills.js';
import { mustDo } from '../src/proactive.js';

const card = { attacker: 'stranger', reachability: 'permissionless', bound: 'vault balance only', liveFunds: 'unknown', alreadyReported: 'no', verificationMethod: 'fork', testName: 'test_Drain', testResult: 'pass' };

const GOOD = `Hi team,

While reviewing the Vault contracts for your bounty program I found one issue, and my honest assessment is that it is High severity, not Critical: a stranger can take what sits in one vault, but nothing outside that vault is exposed.

Vault.withdraw() sends tokens to the caller before it reduces the caller's shares, so a contract that receives the tokens can call withdraw() again and be paid twice. The call happens at Vault.sol line 42.

The damage stops at the balance of the vault being withdrawn from. Other vaults, the fee controller and the owner role are not affected.

I verified this with test_Drain on a local fork at block 19000000. No production system or mainnet state was touched.

I also checked the deposit path and the fee math and both behaved correctly. I did not review the keeper bot, which runs off-chain, so a problem could still exist there.

The fix is to reduce shares before the transfer, or to add a reentrancy guard to withdraw().

I am reporting this privately by email rather than in a public issue, and nothing harmful was done against production. I am happy to share the test on request.

Thanks,
Iyke`;

function mcpSession(base) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  let id = 0;
  readline.createInterface({ input: output }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const done = runMcp({ name: 'hunter', url: base, input, output, log: () => {}, embed: false });
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); input.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { error: r.result.isError ? r.result.content[0].text : null, data: r.result.isError ? null : JSON.parse(r.result.content[0].text) };
  };
  return { rpc, call, close: async () => { input.end(); await done; } };
}

test('report: the agent writes prose from the human\'s skill and the board\'s facts', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-rep-'));
  const hub = createHub({ port: 0, dataDir, seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const base = `http://127.0.0.1:${hub.port}`;
  const s = hub.tenant().store;
  const a = s.touchAgent('hunter', { transport: 'mcp' }).id;
  const t = s.create('target', { name: 'Vault', phase: 'hunting', disclosureChannel: 'security@example.org', bountyRules: 'one bug per report', outOfScope: 'the keeper bot' }, 'human');
  const c = s.create('component', { targetId: t.id, name: 'Vault.withdraw()', location: 'Vault.sol:42' }, a);
  s.create('component', { targetId: t.id, name: 'Vault.deposit()', reviewState: 'reviewed', reasoning: 'shares are minted after the transfer lands' }, a);
  s.create('hypothesis', { targetId: t.id, text: 'fee math rounds in the user\'s favour', status: 'dropped', dropReason: 'rounds down everywhere', exploitStage: 'capability' }, a);
  const ev = [{ ref: 'Vault.sol:42', kind: 'code' }, { ref: 'test_Drain', kind: 'fork', block: '19000000' }];
  const f = s.create('finding', { title: 'Reentrant drain', severity: 'high', targetId: t.id, componentId: c.id, ...card, evidence: ev, notes: 'calls out before updating shares' }, a);
  s.create('finding', { title: 'Untested rounding', bugClass: 'rounding', severity: 'low', targetId: t.id, componentId: c.id, ...card, testResult: 'not-run', evidence: ev }, a);

  const agentHeaders = { 'content-type': 'application/json', 'x-recon-agent': 'hunter' };
  const human = { 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/report/brief`, { headers: agentHeaders })).status, 409, 'no brief before the human picks a shape');
  for (const body of [{ shape: 'combined' }, { signOff: 'Me' }, { skill: 'disclosure-report' }]) {
    assert.equal((await fetch(`${base}/api/report`, { method: 'PATCH', headers: agentHeaders, body: JSON.stringify(body) })).status, 403, JSON.stringify(body));
  }
  assert.ok(mustDo(s.state, a).some((x) => x.do.includes('no suggested fix')), 'agent is nudged for a fix');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-rep-out-'));
  await fetch(`${base}/api/report`, { method: 'PATCH', headers: human, body: JSON.stringify({ shape: 'separate', path: dir }) });
  assert.ok(mustDo(s.state, a).some((x) => x.do.includes('whose name signs')), 'agent asks who signs');
  await fetch(`${base}/api/report`, { method: 'PATCH', headers: human, body: JSON.stringify({ signOff: 'Iyke' }) });

  const m = mcpSession(base);
  const { data: brief } = await m.call('recon_write_report');
  assert.equal(brief.skill.id, 'disclosure-report');
  assert.equal(brief.skill.systemPrompt, DISCLOSURE_REPORT);
  assert.equal(brief.facts.findings.length, 1);
  const ff = brief.facts.findings[0];
  assert.equal(ff.whoCanDoIt, 'anyone, with no special access');
  assert.match(ff.verifiedWith, /local fork/);
  assert.equal(brief.facts.signOffName, 'Iyke');
  assert.ok(brief.facts.checkedFine.some((x) => /Vault.deposit\(\).*shares are minted/.test(x)));
  assert.ok(brief.facts.checkedFine.some((x) => /ruled out: fee math/.test(x)));
  assert.ok(brief.facts.notReviewed.some((x) => /keeper bot/.test(x)));
  assert.ok(brief.instructions.some((x) => /No suggested fix/.test(x)));
  assert.equal(brief.write.length, 1);
  assert.equal(brief.facts.leftOut[0].title, 'Untested rounding');

  // markdown is refused with the exact problems
  const md = `# Report\n\n**High**: reentrancy in \`withdraw()\`\n\n- drains the vault\n\nThanks, Iyke`;
  const bad = await m.call('recon_submit_report', { documents: [{ findingIds: [f.id], body: md }] });
  assert.match(bad.error, /does not follow the writing skill/);
  for (const re of [/markdown header/, /list item/, /bold markup/, /backticks/]) assert.match(bad.error, re);
  const wrongFinding = await m.call('recon_submit_report', { documents: [{ findingIds: [Object.values(s.state.items.finding).find((x) => x.title === 'Untested rounding').id], body: GOOD }] });
  assert.match(wrongFinding.error, /cannot be reported yet/);

  const ok = await m.call('recon_submit_report', { documents: [{ findingIds: [f.id], body: GOOD }] });
  assert.equal(ok.error, null, ok.error);
  assert.deepEqual(ok.data.written, ['01-reentrant-drain.txt']);
  assert.equal(fs.readFileSync(path.join(dir, '01-reentrant-drain.txt'), 'utf8').trim(), GOOD);
  let r = await (await fetch(`${base}/api/report`)).json();
  assert.equal(r.documents[0].written, true);
  assert.equal(r.documents[0].stale, false);
  assert.ok(!mustDo(s.state, a).some((x) => x.why === 'report' || /rewrite/.test(x.do)));

  await new Promise((res) => setTimeout(res, 5));
  s.patch('finding', f.id, { fix: 'reduce shares before the transfer' }, a);
  r = await (await fetch(`${base}/api/report`)).json();
  assert.equal(r.documents[0].stale, true, 'changing the finding makes the report out of date');
  assert.ok(mustDo(s.state, a).some((x) => /rewrite/.test(x.do)));

  // structured fields for advisory forms
  const fields = await m.call('recon_submit_report', { documents: [{ findingIds: [f.id], fields: [{ label: 'Title', value: 'Reentrancy in Vault.withdraw()' }, { label: 'Severity', value: 'High. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N; I rounded down on scope.' }] }] });
  assert.equal(fields.error, null, fields.error);

  // skills reach agents as a tool and as MCP prompts
  const { data: list } = await m.call('recon_skill');
  assert.ok(list.some((x) => x.id === 'disclosure-report' && x.use === 'report'));
  const prompts = await m.rpc('prompts/list', {});
  assert.ok(prompts.result.prompts.some((p) => p.name === 'disclosure-report'));
  const got = await m.rpc('prompts/get', { name: 'disclosure-report' });
  assert.equal(got.result.messages[0].content.text, DISCLOSURE_REPORT);
  await m.close();
  await hub.close();
});

test('skills: humans add, edit and remove; built-ins restore; SKILL.md round-trips', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-skills-'));
  const hub = createHub({ port: 0, dataDir, seed: 'empty', demo: false, log: () => {} });
  await hub.listen();
  const base = `http://127.0.0.1:${hub.port}`;
  const human = { 'content-type': 'application/json' };
  const md = '---\nname: Lending audit\ndescription: How I audit lending markets\nuse: general\n---\n\nStart with liquidation math.\n';
  assert.equal((await fetch(`${base}/api/skills`, { method: 'POST', headers: { ...human, 'x-recon-agent': 'bot' }, body: JSON.stringify({ text: md }) })).status, 403);
  const added = await (await fetch(`${base}/api/skills`, { method: 'POST', headers: human, body: JSON.stringify({ text: md }) })).json();
  assert.equal(added.id, 'lending-audit');
  assert.ok(fs.existsSync(path.join(dataDir, 'skills', 'lending-audit', 'SKILL.md')));
  assert.equal(parseSkill(fs.readFileSync(path.join(dataDir, 'skills', 'lending-audit', 'SKILL.md'), 'utf8')).body, 'Start with liquidation math.');

  const edited = await (await fetch(`${base}/api/skills/disclosure-report`, { method: 'PUT', headers: human, body: JSON.stringify({ body: 'Write short reports.' }) })).json();
  assert.equal(edited.edited, true);
  assert.equal(edited.body, 'Write short reports.');
  const restored = await (await fetch(`${base}/api/skills/disclosure-report`, { method: 'DELETE', headers: human })).json();
  assert.equal(restored.restoredDefault, true);
  assert.equal(new Skills(dataDir).get('disclosure-report').body, DISCLOSURE_REPORT);
  await fetch(`${base}/api/skills/lending-audit`, { method: 'DELETE', headers: human });
  assert.equal(new Skills(dataDir).get('lending-audit'), null);
  assert.ok(fs.readdirSync(path.join(dataDir, 'skills', '.trash')).length, 'removed skills go to the trash, not away');
  await hub.close();
});

test('prose lint catches what the skill forbids and passes plain prose', () => {
  assert.deepEqual(lintProse(GOOD, { signOff: 'Iyke' }), []);
  assert.ok(lintProse('I hope this email finds you well. This is high severity.').some((x) => /finds you well/.test(x)));
  assert.ok(lintProse('Hello.\n\nI looked at the vault and wrote this up. The function is broken.').some((x) => /severity/.test(x)));
  assert.ok(lintProse(GOOD, { signOff: 'Someone Else' }).some((x) => /sign off/.test(x)));
  assert.deepEqual(lintProse('Severity is Low. The variable __gap and _owner and a * b are fine, as is 2 * 3.'), []);
});
