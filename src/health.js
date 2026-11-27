// Agent health: who is active, idle, stuck, looping, or producing noise.
// Computed from presence and the activity log, so agents do not have to report it.

export const IDLE_AFTER = 90_000;
export const OFFLINE_AFTER = 10 * 60_000;
export const STUCK_AFTER = 8 * 60_000;

export function agentHealth(state, agent, now = Date.now()) {
  const flags = [];
  const lastSeen = agent.lastSeen || agent.updatedAt || 0;
  const lastWrite = agent.lastWriteAt || agent.createdAt || 0;
  const since = now - lastSeen;
  let status = agent.status;

  if (agent.transport === 'json') status = since > OFFLINE_AFTER ? 'idle' : 'active';
  else if (since > OFFLINE_AFTER) status = 'offline';
  else if (agent.status === 'stuck') status = 'stuck';
  else if (since > IDLE_AFTER) status = 'idle';
  else if (now - lastWrite > STUCK_AFTER) { status = 'stuck'; flags.push('no-output'); }
  else status = 'active';

  if (status === 'idle') flags.push('idle');
  if (status === 'offline') flags.push('offline');

  const recent = state.activity.filter((a) => a.by === agent.id).slice(-10);
  if (recent.length >= 8 && new Set(recent.map((a) => a.summary)).size <= 2) flags.push('looping');

  const hyps = Object.values(state.items.hypothesis).filter((h) => h.createdBy === agent.id);
  if (hyps.length >= 4) {
    const weak = hyps.filter((h) => h.status === 'dropped' || h.verification === 'disputed' || h.confidence === 'low').length;
    if (weak / hyps.length >= 0.6) flags.push('noisy');
  }
  const disputed = ['component', 'assumption', 'hypothesis', 'finding']
    .flatMap((k) => Object.values(state.items[k]))
    .filter((it) => it.createdBy === agent.id && it.verification === 'disputed').length;
  if (disputed >= 3) flags.push('disputed');

  const writes = state.activity.filter((a) => a.by === agent.id && now - a.at < 10 * 60_000).length;
  return { status, flags, lastSeen, lastWriteAt: lastWrite, writes10m: writes };
}

export function healthAll(state, now = Date.now()) {
  const out = {};
  for (const a of Object.values(state.items.agent)) out[a.id] = agentHealth(state, a, now);
  return out;
}
