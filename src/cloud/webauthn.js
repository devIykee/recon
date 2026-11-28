// Passkeys (WebAuthn) with node:crypto only. Registration takes "none" attestation
// (we trust the authenticator to hold the key, not to prove its make), and stores
// the public key; sign-in checks the challenge, the origin, the relying party,
// the user-presence flag and the signature.

import crypto from 'node:crypto';

export const b64url = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s || ''), 'base64url'),
};

// ---------- a minimal CBOR reader (what attestation objects and COSE keys use) ----------

export function cborDecode(buf) {
  let off = 0;
  const u8 = Buffer.from(buf);
  const readLen = (info) => {
    if (info < 24) return info;
    if (info === 24) return u8[off++];
    if (info === 25) { const v = u8.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = u8.readUInt32BE(off); off += 4; return v; }
    if (info === 27) { const v = Number(u8.readBigUInt64BE(off)); off += 8; return v; }
    throw new Error('cbor: indefinite lengths are not supported');
  };
  const item = () => {
    const first = u8[off++];
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const len = readLen(info); const v = u8.subarray(off, off + len); off += len; return Buffer.from(v); }
      case 3: { const len = readLen(info); const v = u8.subarray(off, off + len).toString('utf8'); off += len; return v; }
      case 4: { const len = readLen(info); const a = []; for (let i = 0; i < len; i++) a.push(item()); return a; }
      case 5: { const len = readLen(info); const m = new Map(); for (let i = 0; i < len; i++) { const k = item(); m.set(k, item()); } return m; }
      case 6: readLen(info); return item();
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        if (info === 25) { const v = u8.readUInt16BE(off); off += 2; return v; }
        if (info === 26) { const v = u8.readFloatBE(off); off += 4; return v; }
        if (info === 27) { const v = u8.readDoubleBE(off); off += 8; return v; }
        throw new Error('cbor: unsupported simple value');
      }
      default: throw new Error('cbor: bad major type');
    }
  };
  const value = item();
  return { value, length: off };
}

// ---------- authenticator data ----------

export function parseAuthData(buf) {
  const d = Buffer.from(buf);
  if (d.length < 37) throw new Error('authenticator data too short');
  const out = { rpIdHash: d.subarray(0, 32), flags: d[32], counter: d.readUInt32BE(33) };
  out.userPresent = Boolean(out.flags & 0x01);
  out.userVerified = Boolean(out.flags & 0x04);
  if (out.flags & 0x40) {
    const credLen = d.readUInt16BE(53);
    out.credentialId = d.subarray(55, 55 + credLen);
    const rest = d.subarray(55 + credLen);
    const { value, length } = cborDecode(rest);
    out.coseKey = value;
    out.coseKeyBytes = rest.subarray(0, length);
  }
  return out;
}

// COSE key -> a node KeyObject (as an SPKI PEM to store) and its algorithm.
export function coseToPem(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  let jwk;
  if (kty === 2) { // EC2
    const crv = { 1: 'P-256', 2: 'P-384', 3: 'P-521' }[cose.get(-1)];
    jwk = { kty: 'EC', crv, x: b64url.enc(cose.get(-2)), y: b64url.enc(cose.get(-3)) };
  } else if (kty === 3) { // RSA
    jwk = { kty: 'RSA', n: b64url.enc(cose.get(-1)), e: b64url.enc(cose.get(-2)) };
  } else if (kty === 1) { // OKP (Ed25519)
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url.enc(cose.get(-2)) };
  } else {
    throw new Error(`unsupported key type ${kty}`);
  }
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return { pem: key.export({ type: 'spki', format: 'pem' }), alg };
}

function checkClient(clientDataJSON, { type, challenge, origin }) {
  let c;
  try { c = JSON.parse(b64url.dec(clientDataJSON).toString('utf8')); } catch { throw new Error('unreadable client data'); }
  if (c.type !== type) throw new Error(`expected ${type}`);
  if (c.challenge !== challenge) throw new Error('the challenge does not match: start again');
  if (c.origin !== origin) throw new Error(`wrong origin ${c.origin}`);
  if (c.crossOrigin) throw new Error('cross-origin passkey use is not allowed');
  return c;
}

const sha256 = (x) => crypto.createHash('sha256').update(x).digest();

// A new passkey: returns what to store.
export function verifyRegistration(credential, { challenge, origin, rpId }) {
  const r = credential?.response || {};
  checkClient(r.clientDataJSON, { type: 'webauthn.create', challenge, origin });
  const { value: att } = cborDecode(b64url.dec(r.attestationObject));
  const auth = parseAuthData(att.get('authData'));
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new Error('the passkey was made for another site');
  if (!auth.userPresent) throw new Error('no user presence');
  if (!auth.credentialId || !auth.coseKey) throw new Error('no credential in the response');
  const { pem, alg } = coseToPem(auth.coseKey);
  return { id: b64url.enc(auth.credentialId), publicKey: pem, alg, counter: auth.counter, transports: Array.isArray(r.transports) ? r.transports.slice(0, 6) : [] };
}

// Sign-in with a stored passkey: returns the new signature counter.
export function verifyAssertion(credential, stored, { challenge, origin, rpId }) {
  const r = credential?.response || {};
  checkClient(r.clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authBytes = b64url.dec(r.authenticatorData);
  const auth = parseAuthData(authBytes);
  if (!auth.rpIdHash.equals(sha256(rpId))) throw new Error('the passkey was made for another site');
  if (!auth.userPresent) throw new Error('no user presence');
  const data = Buffer.concat([authBytes, sha256(b64url.dec(r.clientDataJSON))]);
  const sig = b64url.dec(r.signature);
  const key = crypto.createPublicKey(stored.publicKey);
  let ok;
  if (stored.alg === -8) ok = crypto.verify(null, data, key, sig);
  else if (stored.alg === -257) ok = crypto.verify('sha256', data, key, sig);
  else ok = crypto.verify({ '-7': 'sha256', '-35': 'sha384', '-36': 'sha512' }[stored.alg] || 'sha256', data, { key, dsaEncoding: 'der' }, sig);
  if (!ok) throw new Error('the signature does not match');
  // a counter that goes backwards means a cloned authenticator (counters of 0 mean "not kept")
  if (auth.counter && stored.counter && auth.counter <= stored.counter) throw new Error('this passkey was used more recently somewhere else; it may be cloned');
  return { counter: auth.counter };
}
