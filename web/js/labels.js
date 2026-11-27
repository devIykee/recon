// Plain-language labels, colors and icons for every enum. One place, so the
// whole ui speaks the same words.

export const VIEWS = [
  { id: 'map', label: 'Map', icon: 'map', key: '1', tip: 'The whole engagement at a glance' },
  { id: 'architecture', label: 'Architecture', icon: 'graph', key: '2', tip: 'How the system fits together, and what its developers assume' },
  { id: 'coverage', label: 'Coverage', icon: 'coverage', key: '3', tip: 'Attack surface: what has been looked at', term: 'coverage' },
  { id: 'assumptions', label: 'Assumptions', icon: 'sticky', key: '4', tip: 'What is being taken for granted', term: 'assumption' },
  { id: 'hypotheses', label: 'Hypotheses', icon: 'flask', key: '5', tip: 'Suspected bugs being tested', term: 'hypothesis' },
  { id: 'findings', label: 'Findings', icon: 'bug', key: '6', tip: 'Confirmed bugs, from recon to disclosure', term: 'finding' },
  { id: 'agents', label: 'Agents', icon: 'agents', key: '7', tip: 'Who is working on what' },
];

export const KIND_ICON = {
  target: 'target', component: 'coverage', relation: 'link', chain: 'link', lead: 'compass', assumption: 'sticky', hypothesis: 'flask',
  finding: 'bug', steer: 'flag', proposal: 'sparkle', agent: 'agent', project: 'map', message: 'message',
};

export const REVIEW = {
  untouched: { label: 'Untouched', color: 'var(--st-untouched)', hint: 'Nobody has looked yet' },
  scanning: { label: 'Scanning', color: 'var(--st-scanning)', hint: 'Being looked at right now' },
  reviewed: { label: 'Reviewed', color: 'var(--st-reviewed)', hint: 'Looked at, nothing found' },
  flagged: { label: 'Flagged', color: 'var(--st-flagged)', hint: 'Something smells here' },
};

export const SEVERITY = {
  critical: { label: 'Critical', color: 'var(--sev-critical)' },
  high: { label: 'High', color: 'var(--sev-high)' },
  medium: { label: 'Medium', color: 'var(--sev-medium)' },
  low: { label: 'Low', color: 'var(--sev-low)' },
  info: { label: 'Info', color: 'var(--sev-info)' },
};

export const STAGES = {
  recon: { label: 'Recon', hint: 'Spotted, not yet tested' },
  testing: { label: 'Testing', hint: 'Building a reproduction' },
  reported: { label: 'Reported', hint: 'Sent to the team privately' },
  acknowledged: { label: 'Acknowledged', hint: 'The team confirmed it' },
  fixed: { label: 'Fixed', hint: 'A fix is deployed' },
  disclosed: { label: 'Disclosed', hint: 'Public, after the fix' },
};

export const HYP_STATUS = {
  testing: { label: 'Testing', color: 'var(--primary)', hint: 'Being proven or disproven' },
  confirmed: { label: 'Confirmed', color: 'var(--sev-critical)', hint: 'It is real' },
  dropped: { label: 'Dropped', color: 'var(--faint)', hint: 'Turned out not to be a bug' },
};

export const ASM_STATE = {
  assumed: { label: 'Assumed', color: 'var(--sticky-fg)', hint: 'Taken for granted, unchecked' },
  verified: { label: 'Holds', color: 'var(--ok)', hint: 'Checked and true' },
  invalidated: { label: 'Broken', color: 'var(--bad)', hint: 'Checked and false: look closer' },
};

export const CONFIDENCE = { low: 'Low', med: 'Medium', high: 'High' };

export const VERIFICATION = {
  unverified: { label: 'Unverified', icon: 'eye', hint: 'The agent said so; nobody has checked' },
  verified: { label: 'Verified', icon: 'check', hint: 'You checked the evidence and agree' },
  disputed: { label: 'Disputed', icon: 'x', hint: 'You checked and do not buy it. The agent is asked to revisit.' },
};

export const PRIORITY = {
  low: { label: 'Low', icon: 'down' },
  normal: { label: 'Normal', icon: 'minus' },
  high: { label: 'High', icon: 'up' },
  urgent: { label: 'Urgent', icon: 'zap' },
};

export const STEER = {
  recheck: { label: 'Re-check', icon: 'recheck', verb: 'Re-check this', hint: 'Ask for another look' },
  challenge: { label: 'Challenge', icon: 'challenge', verb: 'Challenge this assumption', hint: 'Ask the agent to try to break it' },
  cover: { label: 'Cover', icon: 'cover', verb: 'Cover this', hint: 'Point an agent at it' },
  verify: { label: 'Verify', icon: 'verify', verb: 'Verify this', hint: 'Ask for stronger evidence or a repro' },
  priority: { label: 'Priority', icon: 'priority', verb: 'Re-prioritize', hint: 'Change what gets attention first' },
  note: { label: 'Note', icon: 'message', verb: 'Leave a note', hint: 'A note or a question' },
};

export const STEER_STATE = {
  open: { label: 'Open', hint: 'Waiting for the agent to see it' },
  acknowledged: { label: 'Seen', hint: 'The agent saw it and will get to it' },
  addressed: { label: 'Done', hint: 'The agent reported back' },
};

export const STEERS_FOR = {
  component: ['cover', 'recheck', 'note'],
  assumption: ['challenge', 'recheck', 'note'],
  hypothesis: ['verify', 'recheck', 'note'],
  finding: ['verify', 'recheck', 'note'],
  target: ['cover', 'note'],
  agent: ['note', 'cover'],
};

export const TRANSPORT = {
  mcp: 'MCP', cli: 'CLI', api: 'HTTP', json: 'JSON file', demo: 'example', ui: 'browser',
};

export const PLAYBOOK_NAMES = {
  lending: 'lending market', amm: 'AMM / DEX', perps: 'perpetuals', bridge: 'bridge', staking: 'staking', 'nft-market': 'NFT marketplace',
  governance: 'governance', oracle: 'oracle', token: 'token', vault: 'vault', factory: 'factory', 'dao-module': 'DAO on Safe modules',
  'nft-custody': 'NFT custody', naming: 'naming / ENS', other: 'protocol',
};

export const PROTOCOL_ICON = {
  lending: '🏦', amm: '🔁', perps: '📈', bridge: '🌉', staking: '🥩', 'nft-market': '🖼️',
  governance: '🗳️', oracle: '🔮', token: '🪙', vault: '🧰', other: '🧩',
};

export const ACTION_LABEL = {
  added: 'added', joined: 'joined', moved: 'moved', updated: 'updated', verified: 'verified',
  disputed: 'disputed', unverified: 'unverified', steered: 'steered', acknowledged: 'acknowledged',
  addressed: 'addressed', reopened: 'reopened', proposed: 'proposed', accepted: 'accepted',
  declined: 'declined', removed: 'removed', prioritized: 'prioritized', claimed: 'claimed',
  evidence: 'evidence', imported: 'imported', note: 'note', focus: 'focus',
};

export const EVIDENCE_ICON = { code: 'code', tx: 'hash', log: 'log', test: 'test', link: 'link', note: 'note' };

export const PHASES = [
  { id: 'mapping', label: 'Map', hint: 'Every contract, actor and dependency, and how they connect' },
  { id: 'assumptions', label: 'Assumptions', hint: 'What the developers assume: trust, invariants, inputs' },
  { id: 'hunting', label: 'Hunt', hint: 'Review each part against the playbook' },
  { id: 'reporting', label: 'Report', hint: 'Write up and disclose' },
];

export const RELATION = {
  calls: { label: 'calls', color: 'var(--st-scanning)' },
  delegates: { label: 'delegatecalls', color: 'var(--sev-critical)' },
  inherits: { label: 'inherits', color: 'var(--faint)' },
  reads: { label: 'reads', color: 'var(--st-reviewed)' },
  writes: { label: 'writes', color: 'var(--st-flagged)' },
  transfers: { label: 'transfers', color: 'var(--sev-medium)' },
  mints: { label: 'mints', color: 'var(--sev-medium)' },
  owns: { label: 'owns', color: 'var(--primary)' },
  configures: { label: 'configures', color: 'var(--primary)' },
  trusts: { label: 'trusts', color: 'var(--sev-high)' },
  other: { label: 'connects', color: 'var(--muted)' },
};

export const COMPONENT_TYPE = {
  actor: { label: 'actor', icon: 'user', hint: 'A person or role: users, admins, keepers' },
  external: { label: 'external', icon: 'globe', hint: 'A dependency: tokens, oracles, other protocols' },
  contract: { label: 'contract', icon: 'file' },
  function: { label: 'function', icon: 'code' },
  module: { label: 'module', icon: 'coverage' },
  endpoint: { label: 'endpoint', icon: 'link' },
  storage: { label: 'storage', icon: 'log' },
  config: { label: 'config', icon: 'edit' },
  other: { label: 'other', icon: 'note' },
};

export const ORIGIN = {
  developer: { label: 'developers assume', short: 'dev', hint: 'What the code\'s authors assume' },
  agent: { label: 'agent assumes', short: 'agent', hint: 'What a researcher is taking for granted' },
};

export const CATEGORY = {
  trust: 'trust', invariant: 'invariant', input: 'input', external: 'external', economic: 'economic', other: 'other',
};

export const CARD_FIELDS = [
  { id: 'attacker', label: 'Attacker', options: ['stranger', 'holder', 'privileged', 'admin'], hint: 'Who can do it' },
  { id: 'reachability', label: 'Reachability', options: ['permissionless', 'needs-role', 'needs-config', 'needs-social'], hint: 'What stands in the way' },
  { id: 'bound', label: 'Bound', hint: 'What still cannot happen' },
  { id: 'liveFunds', label: 'Funds at risk', hint: '"none", "unknown", or address + amount' },
  { id: 'liveFundsMethod', label: 'Measured by', options: ['eth_call', 'fork', 'explorer', 'not-measured'] },
  { id: 'alreadyReported', label: 'Already reported', options: ['no', 'yes', 'unknown'] },
  { id: 'alreadyReportedRef', label: 'Checked against', hint: 'Audit, report, or "distinct: ..."' },
  { id: 'verificationMethod', label: 'Verified by', options: ['fork', 'eth_call', 'unit', 'fuzz', 'live-tx', 'manual'] },
  { id: 'testName', label: 'Test', hint: 'test_Name' },
  { id: 'testResult', label: 'Last run', options: ['pass', 'fail', 'not-run'] },
];

export const EXPLOIT_STAGE = {
  capability: { label: 'Capability', hint: 'The power exists, but no public path makes it fire yet. Hunt the trigger.' },
  trigger: { label: 'Trigger found', hint: 'A path makes it fire; impact not proven yet.' },
  full: { label: 'Full exploit', hint: 'Trigger plus impact. Can become a finding.' },
};

export const CONFIRM_STEPS = [
  { id: 'caller', text: 'Name the function and the caller who can hit it without extra trust' },
  { id: 'fork', text: 'Run it on a fork against live bytecode (not a rewritten local copy)' },
  { id: 'bound', text: 'Write the bound next to the scary part: what still cannot happen' },
  { id: 'reported', text: 'Check already-reported issues and third-party scope' },
  { id: 'funds', text: 'Measure live funds, or say they were not measured' },
  { id: 'severity', text: 'Only then pick severity, on the program\'s scale' },
];

export const LEAD_STATE = {
  open: { label: 'Open', color: 'var(--primary)' },
  blocked: { label: 'Blocked', color: 'var(--warn)' },
  done: { label: 'Done', color: 'var(--ok)' },
  dropped: { label: 'Dropped', color: 'var(--faint)' },
};

export const VALUE = { high: 'High value', med: 'Medium value', low: 'Low value' };

export const GLUE = {
  'same-tx': 'same transaction', 'same-caller': 'same caller', 'config+code': 'a config the team chose + code', 'social+code': 'a social step + code', other: 'other',
};
