// Vercel entry point: every request goes through hosted recon (see src/cloud/server.js).
import { createCloud } from '../src/cloud/server.js';
import { hkdfSync } from 'node:crypto';
import { neon } from '../src/cloud/db.js';

let cloud = null;

export default async function handler(req, res) {
  if (!cloud) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('recon is not configured yet: connect a Neon database to the project (Storage, then Neon).');
      return;
    }
    // The key that signs cookies and passkey challenges. RECON_SECRET if set;
    // otherwise derived from the database URL, a secret Vercel already holds, so
    // a deploy needs nothing but the database. Rotating either signs everyone out.
    const secret = process.env.RECON_SECRET || Buffer.from(hkdfSync('sha256', url, 'recon', 'recon session signing key v1', 32)).toString('hex');
    // Passkeys are bound to one domain. Without RECON_ORIGIN, use the project's
    // production domain (Vercel sets it), never whatever Host a request names.
    const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const origin = process.env.RECON_ORIGIN || (prod ? `https://${prod}` : null);
    cloud = createCloud({ db: neon(url), secret, origin });
  }
  return cloud.handle(req, res);
}
