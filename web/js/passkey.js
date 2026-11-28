// The browser side of passkeys: turn the server's options into what
// navigator.credentials wants, and the result back into JSON.

const toBuf = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const supported = () => Boolean(window.PublicKeyCredential && navigator.credentials);

async function call(path, body) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// a friendlier word for what the browser throws
function explain(err) {
  if (err?.name === 'NotAllowedError') return new Error('The passkey prompt was closed or timed out. Try again.');
  if (err?.name === 'InvalidStateError') return new Error('This device already has a passkey for this account.');
  if (err?.name === 'SecurityError') return new Error('Passkeys only work on this site over https (or localhost).');
  return err;
}

export async function create(optionsPath, verifyPath, extra = {}) {
  const o = await call(optionsPath, extra);
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        ...o,
        challenge: toBuf(o.challenge),
        user: { ...o.user, id: toBuf(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
      },
    });
  } catch (err) { throw explain(err); }
  return call(verifyPath, {
    ...extra,
    credential: {
      id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
      response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject), transports: cred.response.getTransports?.() || [] },
    },
  });
}

export async function signIn() {
  const o = await call('/auth/login/options');
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { ...o, challenge: toBuf(o.challenge), allowCredentials: [] } });
  } catch (err) { throw explain(err); }
  return call('/auth/login/verify', {
    credential: {
      id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
      response: {
        clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData),
        signature: toB64u(cred.response.signature), userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null,
      },
    },
  });
}

export { call };
