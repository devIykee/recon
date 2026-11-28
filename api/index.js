// Vercel entry point: every request goes through hosted recon (see src/cloud/server.js).
import { createCloud } from '../src/cloud/server.js';
import { neon } from '../src/cloud/db.js';

let cloud = null;

export default async function handler(req, res) {
  if (!cloud) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url || !process.env.RECON_SECRET) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('recon is not configured yet: it needs DATABASE_URL (a Neon database) and RECON_SECRET.');
      return;
    }
    cloud = createCloud({ db: neon(url), secret: process.env.RECON_SECRET, origin: process.env.RECON_ORIGIN || null });
  }
  return cloud.handle(req, res);
}
