// The account page: passkeys, API keys for agents, the recovery code, and the
// doors out (sign out everywhere, delete the account).

import { h } from './ui.js';
import { create, call } from './passkey.js';

const root = document.getElementById('account');
const when = (t) => (t ? new Date(t).toLocaleString() : 'never');
let fresh = null; // a key or code shown once, right after it was made

async function load() {
  const me = await (await fetch('/auth/me', { credentials: 'same-origin' })).json();
  if (!me.user) { location.href = '/login'; return; }
  render(me);
}

function act(btn, fn) {
  return async () => {
    btn.disabled = true;
    try { await fn(); } catch (err) { alert(err.message); }
    btn.disabled = false;
    load();
  };
}

function render(me) {
  const base = location.origin;
  const keyLabel = h('input.input', { placeholder: 'e.g. claude-code on my laptop', maxlength: 60, 'aria-label': 'Key name' });
  const makeKey = h('button.btn.btn-primary', 'Make an API key');
  makeKey.addEventListener('click', act(makeKey, async () => { const r = await call('/auth/keys', { label: keyLabel.value.trim() || 'agent' }); fresh = { kind: 'key', value: r.key, label: r.label }; }));
  const addPasskey = h('button.btn', 'Add a passkey on this device');
  addPasskey.addEventListener('click', act(addPasskey, () => create('/auth/passkeys/options', '/auth/passkeys/verify', { label: `${navigator.platform || 'Device'}, added ${new Date().toLocaleDateString()}` })));
  const rotate = h('button.btn', 'Make a new recovery code');
  rotate.addEventListener('click', act(rotate, async () => { if (!confirm('Your current recovery code will stop working. Continue?')) return; const r = await call('/auth/recovery/rotate'); fresh = { kind: 'code', value: r.recoveryCode }; }));
  const everywhere = h('button.btn', 'Sign out everywhere');
  everywhere.addEventListener('click', act(everywhere, async () => { await call('/auth/signout-everywhere'); location.href = '/login'; }));
  const del = h('button.btn.btn-danger', 'Delete my account');
  del.addEventListener('click', act(del, async () => {
    const typed = prompt(`This deletes your account, every hunt on it and every API key. It cannot be undone.\n\nType your account name (${me.user.name}) to confirm:`);
    if (typed === null) return;
    await call('/auth/delete', { confirm: typed });
    location.href = '/';
  }));

  const shownKey = fresh?.kind === 'key' ? fresh : null;
  const shownCode = fresh?.kind === 'code' ? fresh : null;
  fresh = null;

  root.replaceChildren(
    h('h1', me.user.name),
    h('p.fine', 'Account id ', h('code', me.user.id), ` · since ${new Date(me.user.createdAt).toLocaleDateString()}`),

    h('section.acct-card',
      h('h2', 'API keys for your agents'),
      h('p', 'An agent uses a key to reach your board from anywhere. Make one per agent or machine, so you can revoke one without touching the others.'),
      shownKey ? h('div.once', h('b', `Your new key "${shownKey.label}". Copy it now: it is not shown again.`), h('pre.code', shownKey.value),
        h('p.fine', 'Paste this into your agent:'),
        h('pre.code', `Run \`RECON_URL=${base} RECON_KEY=${shownKey.value} npx -y github:devIykee/recon agent\` and follow its instructions to do this security review with me on the recon board.`),
        h('p.fine', 'Or add it as a remote MCP server in Claude Code:'),
        h('pre.code', `claude mcp add --transport http recon ${base}/mcp --header "Authorization: Bearer ${shownKey.value}"`)) : null,
      h('div.row-gap', keyLabel, makeKey),
      me.apiKeys.length ? h('table.acct-table', h('tbody', ...me.apiKeys.map((k) => {
        const rm = h('button.btn.btn-xs.btn-danger', 'Revoke');
        rm.addEventListener('click', act(rm, async () => { if (confirm(`Revoke "${k.label}"? Agents using it stop working at once.`)) await call('/auth/keys/remove', { id: k.id }); }));
        return h('tr', h('td', h('b', k.label), h('br'), h('code', `${k.prefix}…`)), h('td.fine', `made ${when(k.createdAt)}`, h('br'), `last used ${when(k.lastUsed)}`), h('td', rm));
      }))) : h('p.fine', 'No keys yet.')),

    h('section.acct-card',
      h('h2', 'Passkeys'),
      h('p', 'Each passkey signs you in. Add one on every device you use, so losing one never locks you out.'),
      h('table.acct-table', h('tbody', ...me.passkeys.map((k) => {
        const rm = h('button.btn.btn-xs', 'Remove');
        rm.disabled = me.passkeys.length < 2;
        rm.title = rm.disabled ? 'Add another passkey before removing your only one' : '';
        rm.addEventListener('click', act(rm, async () => { if (confirm(`Remove the passkey "${k.label}"?`)) await call('/auth/passkeys/remove', { id: k.id }); }));
        return h('tr', h('td', h('b', k.label || 'Passkey')), h('td.fine', `added ${when(k.createdAt)}`, h('br'), `last used ${when(k.lastUsed)}`), h('td', rm));
      }))),
      addPasskey),

    h('section.acct-card',
      h('h2', 'Recovery code'),
      h('p', 'With your account id, it gets you back in if every passkey is lost. It works once and is then replaced.'),
      shownCode ? h('div.once', h('b', 'Your new recovery code. Save it now: it is not shown again.'), h('pre.code', `recon account: ${me.user.id}\nrecovery code: ${shownCode.value}`)) : null,
      rotate),

    h('section.acct-card.danger',
      h('h2', 'Leaving'),
      h('div.row-gap', everywhere, del)),
  );
}

load().catch((err) => { root.replaceChildren(h('p.auth-msg.error', err.message)); });
