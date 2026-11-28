// Sign up, sign in, or recover an account. Three small screens in one card.

import { h } from './ui.js';
import { create, signIn, supported, call } from './passkey.js';

const panel = document.getElementById('panel');
const say = (el, msg, kind = 'error') => { el.textContent = msg; el.className = `auth-msg ${kind}`; };

function signInView() {
  const msg = h('p.auth-msg');
  const go = h('button.btn.btn-primary.btn-lg.wide', { on: { click: async () => {
    go.disabled = true; say(msg, 'Waiting for your passkey…', 'info');
    try { await signIn(); location.href = '/'; } catch (err) { say(msg, err.message); go.disabled = false; }
  } } }, 'Sign in with a passkey');
  panel.replaceChildren(
    h('h1', 'Welcome back'),
    h('p.lead', 'Use the passkey you made when you signed up. Your device asks for your face, fingerprint or PIN.'),
    go, msg,
    h('div.auth-alt', h('a', { href: '#signup' }, 'New here? Create an account'), h('a', { href: '#recover' }, 'Lost your passkeys?')),
  );
  go.focus();
}

function signUpView() {
  const msg = h('p.auth-msg');
  const name = h('input.input', { placeholder: 'e.g. iyke', maxlength: 60, autocomplete: 'username webauthn', 'aria-label': 'Account name' });
  const go = h('button.btn.btn-primary.btn-lg.wide', { type: 'submit' }, 'Create account with a passkey');
  const form = h('form', { on: { submit: async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) { say(msg, 'Choose a name for your account.'); name.focus(); return; }
    go.disabled = true; say(msg, 'Follow your device to make the passkey…', 'info');
    try { const r = await create('/auth/register/options', '/auth/register/verify', { name: n, label: deviceLabel() }); savedView(r); } catch (err) { say(msg, err.message); go.disabled = false; }
  } } }, h('div.field', h('label', 'Account name'), name, h('span.help', 'Shown on your board. You can sign in from any device your passkey syncs to.')), go);
  panel.replaceChildren(
    h('h1', 'Create your account'),
    h('p.lead', 'No email and no password. A passkey on this device signs you in.'),
    form, msg,
    h('div.auth-alt', h('a', { href: '#signin' }, 'Already have an account? Sign in')),
  );
  name.focus();
}

// The one time the recovery code is shown.
function savedView(r) {
  const text = `recon account: ${r.user.id}\nrecovery code: ${r.recoveryCode}`;
  const done = h('button.btn.btn-primary.btn-lg.wide', { disabled: true, on: { click: () => { location.href = r.addPasskey ? '/account' : '/'; } } }, r.addPasskey ? 'Add a new passkey' : 'Open my board');
  const ok = h('input', { type: 'checkbox', on: { change: (e) => { done.disabled = !e.target.checked; } } });
  panel.replaceChildren(
    h('h1', r.addPasskey ? 'You are back in' : 'Save your recovery code'),
    h('p.lead', r.addPasskey ? 'Your old recovery code no longer works. Here is the new one: keep it somewhere safe, then add a new passkey.' : 'If you ever lose every device with your passkey, this code and your account id get you back in. It is shown only once.'),
    h('pre.code.recovery', text),
    h('div.row-gap', h('button.btn', { on: { click: () => navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copied'; }) } }, h('span', { id: 'copy' }, 'Copy')),
      h('button.btn', { on: { click: () => { const a = h('a', { href: URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' })), download: 'recon-recovery.txt' }); a.click(); } } }, 'Download')),
    h('label.check', ok, ' I saved my account id and recovery code'),
    done,
  );
  const copy = panel.querySelector('#copy');
}

function recoverView() {
  const msg = h('p.auth-msg');
  const account = h('input.input.mono', { placeholder: 'u_…', 'aria-label': 'Account id' });
  const code = h('input.input.mono', { placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX', 'aria-label': 'Recovery code' });
  const go = h('button.btn.btn-primary.btn-lg.wide', { type: 'submit' }, 'Recover my account');
  const form = h('form', { on: { submit: async (e) => {
    e.preventDefault();
    go.disabled = true;
    try { savedView(await call('/auth/recover', { account: account.value.trim(), code: code.value.trim() })); } catch (err) { say(msg, err.message); go.disabled = false; }
  } } }, h('div.field', h('label', 'Account id'), account), h('div.field', h('label', 'Recovery code'), code), go);
  panel.replaceChildren(
    h('h1', 'Recover your account'),
    h('p.lead', 'Use the account id and recovery code you saved when you signed up. You will get a new code, and can then add a new passkey.'),
    form, msg,
    h('div.auth-alt', h('a', { href: '#signin' }, 'Back to sign in')),
  );
  account.focus();
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'This device';
  return `${os}, added ${new Date().toLocaleDateString()}`;
}

function route() {
  if (!supported()) {
    panel.replaceChildren(h('h1', 'Passkeys are not available here'), h('p.lead', 'This browser cannot use passkeys. Try a recent Chrome, Safari, Edge or Firefox.'));
    return;
  }
  const v = location.hash.slice(1);
  if (v === 'signup') signUpView();
  else if (v === 'recover') recoverView();
  else signInView();
}
addEventListener('hashchange', route);
fetch('/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((me) => { if (me.user && location.hash !== '#recover') location.href = '/'; else route(); }).catch(route);
