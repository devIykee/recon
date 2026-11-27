// Name the hunt after the project an agent is working in, so different projects
// get different hunts without anyone having to think about it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findUp(start, name) {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// A readable project name: the git remote's repo name, else package.json, else the folder.
export function projectName(cwd = process.cwd()) {
  const home = os.homedir();
  const abs = path.resolve(cwd);
  if (abs === home || abs === path.parse(abs).root) return null;
  const git = findUp(abs, '.git');
  if (git) {
    try {
      const cfg = fs.readFileSync(fs.statSync(git).isDirectory() ? path.join(git, 'config') : git, 'utf8');
      const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
      if (m) return m[1].replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop();
    } catch { /* fall through */ }
    return path.basename(path.dirname(git));
  }
  const pkg = findUp(abs, 'package.json');
  if (pkg && path.dirname(pkg) !== home) {
    try { const name = JSON.parse(fs.readFileSync(pkg, 'utf8')).name; if (name) return String(name).replace(/^@[^/]+\//, ''); } catch { /* fall through */ }
  }
  return path.basename(abs);
}
