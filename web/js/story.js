// Plain-English summaries. Whatever you click, it first tells you what it is, what
// is known, and what is still open, in sentences, before any fields.

import { h } from './ui.js';
import { byId, list, authorName } from './state.js';
import { PLAYBOOK_NAMES } from './labels.js';

export const ATTACKER_WORDS = {
  stranger: 'anyone, with no special access',
  holder: 'any token holder',
  privileged: 'someone with a privileged role',
  admin: 'only an admin',
};

export const REACH_WORDS = {
  permissionless: 'no permission is needed',
  'needs-role': 'it needs a special role',
  'needs-config': 'it only works if the team turns on a setting',
  'needs-social': 'it needs someone to be tricked',
};

const STAGE_WORDS = {
  capability: 'For now it is a capability: the power exists, but nothing shows how an attacker would make it happen.',
  trigger: 'A way to trigger it was found, but the damage is not proven yet.',
  full: 'It can be triggered and the damage is shown.',
};

const CONF_WORDS = { low: 'not very', med: 'fairly', high: 'very' };
const REL_WORDS = {
  calls: 'calls', delegates: 'delegatecalls into', inherits: 'inherits from', reads: 'reads from', writes: 'writes to',
  transfers: 'transfers tokens to or from', mints: 'mints', owns: 'owns', configures: 'configures', trusts: 'trusts', other: 'connects to',
};

const p = (...parts) => h('p', ...parts);
const b = (t) => h('b', t);
const nameOf = (id) => byId(id)?.name || byId(id)?.title || byId(id)?.text || '';
const who = (it) => (it.createdBy?.startsWith('human') ? 'You' : authorName(it.createdBy));

// Returns { lines, tone, status } for an item.
export function storyFor(it) {
  switch (it.kind) {
    case 'assumption': {
      const status = it.state === 'verified' ? ['Checked: it holds.', 'ok']
        : it.state === 'invalidated' ? ['Checked: it is false. Look for what breaks because of it.', 'bad']
          : ['Nobody has checked whether this is true yet. If it is false, anything relying on it may be a bug.', 'warn'];
      return {
        lines: [
          p(it.origin === 'developer' ? 'The developers assume: ' : `${who(it)} is assuming: `, b(it.text)),
          it.rationale ? p('Why we think so: ', it.rationale) : null,
          it.componentId ? p('This is about ', b(nameOf(it.componentId)), '.') : null,
        ],
        status: status[0], tone: status[1],
      };
    }
    case 'hypothesis': {
      const comp = nameOf(it.componentId);
      const ev = (it.evidence || []).length;
      const status = it.status === 'confirmed' ? ['Confirmed: it is a real bug.', 'bad']
        : it.status === 'dropped' ? [`Dropped: not a bug${it.dropReason ? ` (${it.dropReason})` : ''}.`, 'muted']
          : ['Still being tested.', 'warn'];
      return {
        lines: [
          p('Suspected bug', comp ? [' in ', b(comp)] : '', ': ', b(it.text)),
          it.exploitStage ? p(STAGE_WORDS[it.exploitStage], it.trigger ? [' Trigger: ', it.trigger] : '') : p('Nobody has said yet whether an attacker can actually trigger this.'),
          p(`${who(it)} is ${CONF_WORDS[it.confidence] || 'not very'} confident. `, ev ? `${ev} piece${ev === 1 ? '' : 's'} of evidence attached.` : 'No evidence attached yet.'),
        ],
        status: status[0], tone: status[1],
      };
    }
    case 'finding': {
      const comp = nameOf(it.componentId);
      const missing = ['attacker', 'reachability', 'bound', 'liveFunds', 'alreadyReported', 'verificationMethod'].filter((k) => !it[k]);
      return {
        lines: [
          p(b(`${cap(it.severity)} bug`), comp ? [' in ', b(comp)] : '', ': ', it.title),
          it.attacker || it.reachability ? p('Who can do it: ', ATTACKER_WORDS[it.attacker] || 'not said yet', it.reachability ? `, and ${REACH_WORDS[it.reachability]}.` : '.') : null,
          it.bound ? p('What still cannot happen: ', it.bound) : null,
          it.liveFunds ? p('Funds at risk now: ', it.liveFunds, it.liveFundsMethod && it.liveFundsMethod !== 'not-measured' ? ` (measured with ${it.liveFundsMethod})` : '') : null,
          it.testName ? p('Proven by ', h('code', it.testName), it.testResult ? ` (last run: ${it.testResult})` : '', '.') : null,
        ],
        status: missing.length ? `Not ready to report: still missing ${missing.join(', ')}.` : it.stage === 'recon' || it.stage === 'testing' ? 'Ready for its report once the evidence checks pass.' : `Stage: ${it.stage}.`,
        tone: missing.length ? 'warn' : 'ok',
      };
    }
    case 'component': {
      const hyps = list('hypothesis', (x) => x.componentId === it.id && x.status !== 'dropped').length;
      const finds = list('finding', (x) => x.componentId === it.id).length;
      const owner = it.owner ? authorName(it.owner) : null;
      if (it.type === 'actor' || it.type === 'external') {
        return { lines: [p(b(it.name), ': ', it.summary || (it.type === 'actor' ? 'a person or role that uses the system.' : 'something outside the system it depends on.'))], status: it.type === 'actor' ? 'An actor: who uses the system.' : 'An outside dependency.', tone: 'muted' };
      }
      const state = {
        untouched: ['Nobody has looked at this part yet.', 'warn'],
        scanning: [`${owner || 'An agent'} is looking at it now.`, 'info'],
        reviewed: ['Looked at: nothing wrong found.', 'ok'],
        flagged: ['Something looks wrong here.', 'bad'],
      }[it.reviewState];
      return {
        lines: [
          p(b(it.name), it.summary ? [': ', it.summary] : ''),
          it.reasoning ? p(it.reviewState === 'flagged' ? 'What looks wrong: ' : 'What was checked: ', it.reasoning) : null,
          hyps || finds ? p(`${hyps} suspected bug${hyps === 1 ? '' : 's'} and ${finds} finding${finds === 1 ? '' : 's'} here.`) : null,
        ],
        status: state[0], tone: state[1],
      };
    }
    case 'relation':
      return { lines: [p(b(nameOf(it.from)), ` ${REL_WORDS[it.type] || 'connects to'} `, b(nameOf(it.to)), it.label ? ` (${it.label})` : '', '.')], status: 'A connection on the architecture map.', tone: 'muted' };
    case 'lead':
      return {
        lines: [
          p(b(it.text)),
          it.why ? p('Why it matters: ', it.why) : null,
          it.blockedBy ? p('Blocked by: ', it.blockedBy) : null,
          it.nextStep ? p('Next step: ', it.nextStep) : null,
          it.outcome ? p('What came of it: ', it.outcome) : null,
        ],
        status: { open: 'Still to do.', blocked: 'Waiting on something.', done: 'Done.', dropped: 'Dropped.' }[it.state], tone: it.state === 'done' ? 'ok' : it.state === 'blocked' ? 'warn' : 'info',
      };
    case 'chain':
      return {
        lines: [
          p('These combine: ', ...(it.parts || []).flatMap((id, i) => [i ? ' + ' : '', b(nameOf(id) || id)])),
          it.result ? p('Together: ', it.result) : null,
          p(it.gluePermissionless ? 'An attacker can force the combination.' : 'The combination depends on circumstances the attacker does not control, so it does not raise severity much.'),
        ],
        status: `${cap(it.severity)} as a chain.`, tone: 'warn',
      };
    case 'target':
      return {
        lines: [
          p(b(it.name), ` (${PLAYBOOK_NAMES[it.protocolType] || it.protocolType}${it.chain ? `, on ${it.chain}` : ''}).`),
          it.inScope ? p('In scope: ', it.inScope) : null,
          it.outOfScope ? p('Out of scope: ', it.outOfScope) : null,
          it.disclosureChannel ? p('Report to: ', it.disclosureChannel) : null,
        ],
        status: { mapping: 'Step 1 of 3: mapping how it fits together.', assumptions: 'Step 2 of 3: writing down what the developers assume.', hunting: 'Step 3 of 3: hunting for bugs.', reporting: 'Writing the report.' }[it.phase || 'mapping'], tone: 'info',
      };
    case 'agent':
      return { lines: [p(b(it.name), it.focus ? [' is working on: ', it.focus] : ' has not said what it is doing.')], status: `Status: ${it.status}.`, tone: 'info' };
    default:
      return { lines: [], status: '', tone: 'muted' };
  }
}

function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
