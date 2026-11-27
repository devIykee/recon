// recon scan: a first architecture map straight from Solidity source, so the
// diagram shows what talks to what before anyone draws an arrow by hand.
//
// It is a heuristic reader, not a compiler: it finds contracts, inheritance,
// typed contract references and the calls made through them (with function
// names), token transfers, reads, low-level calls back to the caller, calls to
// arbitrary addresses, delegatecalls, and who may call what (onlyX modifiers,
// require(msg.sender == ...), unrestricted external functions). Agents refine it.

import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'lib', 'out', 'cache', 'artifacts', 'test', 'tests', 'script', 'scripts', 'mocks', 'mock', '.git', 'broadcast', 'forge-std']);

export function solidityFiles(root, { includeTests = false } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) || (includeTests && /^tests?$/.test(e.name))) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.sol') && (includeTests || !/\.t\.sol$/.test(e.name))) out.push(path.join(dir, e.name));
    }
  };
  if (fs.statSync(root).isFile()) return [root];
  walk(root);
  return out.sort();
}

// Remove comments and string contents but keep line structure, so line numbers stay true.
function clean(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`);
}

function blockEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return src.length;
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

function declarations(file, rel) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = clean(raw);
  const out = [];
  const re = /\b(abstract\s+contract|contract|interface|library)\s+(\w+)(?:\s+is\s+([^{]+))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const end = blockEnd(src, open);
    out.push({
      kind: m[1].includes('contract') ? 'contract' : m[1],
      name: m[2],
      parents: (m[3] || '').split(',').map((s) => s.trim().split(/[\s(]/)[0]).filter(Boolean),
      body: src.slice(open + 1, end),
      bodyStart: open + 1,
      src,
      file: rel,
      line: lineAt(src, m.index),
    });
    re.lastIndex = end;
  }
  return out;
}

const READ = /^(get|is|has|balanceOf|allowance|total|latest|decimals|symbol|name|owner|price|quote|preview|convert|max|min|peek|read|view)/i;
const TRANSFER = /^(safe)?transfer(from)?$|^send$/i;
const MINT = /^(mint|burn|safeMint)/i;

function kindFor(method) {
  if (TRANSFER.test(method)) return 'transfers';
  if (MINT.test(method)) return 'mints';
  if (READ.test(method)) return 'reads';
  return 'calls';
}

function functionsIn(decl) {
  const fns = [];
  const re = /\bfunction\s+(\w+)\s*\(([^)]*)\)([^{;]*)(\{|;)/g;
  let m;
  while ((m = re.exec(decl.body))) {
    const header = m[3];
    let body = '';
    if (m[4] === '{') {
      const open = m.index + m[0].length - 1;
      const end = blockEnd(decl.body, open);
      body = decl.body.slice(open + 1, end);
      re.lastIndex = end;
    }
    fns.push({
      name: m[1],
      params: m[2],
      visibility: (header.match(/\b(external|public|internal|private)\b/) || [])[1] || 'public',
      mutability: (header.match(/\b(view|pure|payable)\b/) || [])[1] || '',
      modifiers: [...header.matchAll(/\b(only\w+|whenNotPaused|nonReentrant|initializer|auth|requiresAuth)\b/g)].map((x) => x[1]),
      body,
      line: lineAt(decl.src, decl.bodyStart + m.index),
    });
  }
  return fns;
}

function stateVars(decl, known) {
  // top-level of the contract body only
  let depth = 0;
  let top = '';
  for (const ch of decl.body) {
    if (ch === '{') depth++;
    if (depth === 0) top += ch;
    if (ch === '}') depth--;
  }
  const vars = new Map();
  const re = /(?:^|;|\n)\s*([A-Z]\w*)\s+(?:(?:public|private|internal|immutable|constant|override)\s+)*(\w+)\s*(?:=|;)/g;
  let m;
  while ((m = re.exec(top))) if (known.has(m[1]) || /^I[A-Z]/.test(m[1])) vars.set(m[2], m[1]);
  return vars;
}

// Every state variable of a contract (any type), from its top level.
function allStateVars(decl) {
  let depth = 0;
  let top = '';
  for (const ch of decl.body) {
    if (ch === '{') depth++;
    if (depth === 0) top += ch;
    if (ch === '}') depth--;
  }
  const names = new Set();
  for (const stmt of top.split(';')) {
    const st = stmt.replace(/\s+/g, ' ').trim();
    if (!st || /^(event|error|using|struct|enum|modifier|function|constructor|pragma|import|type)\b/.test(st)) continue;
    // drop the initializer, then the last identifier is the name
    const head = st.split(/=(?!>)/)[0].trim();
    if (!/^(mapping\s*\(|[A-Za-z_]\w*)/.test(head)) continue;
    const m = head.match(/(\w+)\s*$/);
    if (!m || /^(public|private|internal|immutable|constant|override|payable)$/.test(m[1])) continue;
    if (/\bconstant\b/.test(head)) continue;
    names.add(m[1]);
  }
  return names;
}

// Which state a function body writes and reads.
function stateAccess(body, vars) {
  const writes = new Set();
  const reads = new Set();
  for (const v of vars) {
    const id = `\\b${v}\\b`;
    const write = new RegExp(`(^|[^.\\w])${v}\\s*(\\[[^\\]]*\\]\\s*)*(\\.\\w+\\s*)*(\\+\\+|--|[-+*/%|&^]?=(?!=)|\\.push\\s*\\(|\\.pop\\s*\\()|\\b(delete)\\s+${v}\\b|(\\+\\+|--)\\s*${v}\\b`);
    if (write.test(body)) writes.add(v);
    else if (new RegExp(id).test(body)) reads.add(v);
  }
  return { writes: [...writes], reads: [...reads] };
}

const roleName = (mod) => {
  const r = mod.replace(/^only/, '').replace(/Or\w+$/, '');
  return r ? `${r.charAt(0).toUpperCase()}${r.slice(1)}` : 'Owner';
};

export function scanSolidity(root, { includeTests = false } = {}) {
  const base = fs.statSync(root).isFile() ? path.dirname(root) : root;
  const files = solidityFiles(root, { includeTests });
  const decls = files.flatMap((f) => declarations(f, path.relative(base, f) || path.basename(f)));
  const known = new Set(decls.map((d) => d.name));
  const byName = new Map(decls.map((d) => [d.name, d]));
  // an interface implemented in the scanned code points at its implementation
  const implOf = new Map();
  for (const d of decls) for (const p of d.parents) if (byName.get(p)?.kind === 'interface' && d.kind === 'contract') implOf.set(p, d.name);

  const components = new Map();
  const relations = new Map();
  const surfaces = new Map();
  const addComp = (name, type, summary, location) => { if (!components.has(name)) components.set(name, { name, type, summary, location }); };
  const addRel = (from, to, type, label) => {
    if (from === to) return;
    const key = `${from}|${to}|${type}`;
    const r = relations.get(key) || { from, to, type, labels: new Set() };
    if (label) r.labels.add(label);
    relations.set(key, r);
  };
  const target = (typeName) => {
    if (implOf.has(typeName)) return implOf.get(typeName);
    const d = byName.get(typeName);
    if (d && d.kind !== 'interface') return d.name;
    addComp(typeName, 'external', d ? `Interface ${typeName}: no implementation in scope (a token, oracle or other protocol)` : `${typeName}: outside the scanned code`, d ? `${d.file}:${d.line}` : '');
    return typeName;
  };

  for (const d of decls) {
    if (d.kind === 'interface') continue;
    const fns = functionsIn(d);
    const entry = fns.filter((f) => (f.visibility === 'external' || f.visibility === 'public') && f.mutability !== 'view' && f.mutability !== 'pure');
    addComp(d.name, d.kind === 'library' ? 'module' : 'contract',
      `${d.kind === 'library' ? 'Library' : 'Contract'}${entry.length ? ` with ${entry.length} state-changing entry point${entry.length === 1 ? '' : 's'}: ${entry.slice(0, 5).map((f) => `${f.name}()`).join(', ')}${entry.length > 5 ? ', ...' : ''}` : ''}`,
      `${d.file}:${d.line}`);
    for (const p of d.parents) if (known.has(p) && byName.get(p).kind !== 'interface') addRel(d.name, p, 'inherits', '');
    const vars = stateVars(d, known);
    // state declared here and in the contracts it inherits from
    const own = new Set(allStateVars(d));
    for (const p of d.parents) { const pd = byName.get(p); if (pd && pd.kind !== 'interface') for (const v of allStateVars(pd)) own.add(v); }
    const access = new Map(fns.map((f) => [f.name, stateAccess(f.body, own)]));
    // a public function also writes what the internal helpers it calls write
    for (let pass = 0; pass < 3; pass++) {
      for (const f of fns) {
        const a = access.get(f.name);
        for (const g of fns) {
          if (g === f || (g.visibility !== 'internal' && g.visibility !== 'private')) continue;
          if (!new RegExp(`\\b${g.name}\\s*\\(`).test(f.body)) continue;
          const ga = access.get(g.name);
          a.writes = [...new Set([...a.writes, ...ga.writes])];
          a.reads = [...new Set([...a.reads, ...ga.reads])].filter((x) => !a.writes.includes(x));
        }
      }
    }
    surfaces.set(d.name, fns.filter((f) => f.name !== 'constructor').map((f) => {
      const roles = f.modifiers.filter((x) => x.startsWith('only')).map(roleName);
      const req = [...f.body.matchAll(/require\s*\(\s*msg\.sender\s*==\s*([\w.]+)(?:\(\))?/g)].map((x) => { const r = x[1].split('.').pop(); return r.charAt(0).toUpperCase() + r.slice(1); });
      const external = f.visibility === 'external' || f.visibility === 'public';
      const view = f.mutability === 'view' || f.mutability === 'pure';
      const who = !external ? 'internal' : view ? 'view' : roles.length || req.length ? `role:${[...roles, ...req].join('|')}` : 'anyone';
      const a = access.get(f.name);
      return { fn: `${f.name}()`, access: who, writes: a.writes, reads: a.reads, line: f.line };
    }));

    for (const f of fns) {
      const b = f.body;
      // who may call it
      if (f.visibility === 'external' || f.visibility === 'public') {
        const roles = f.modifiers.filter((x) => x.startsWith('only'));
        const req = [...b.matchAll(/require\s*\(\s*msg\.sender\s*==\s*([\w.]+)(?:\(\))?/g)].map((x) => x[1].split('.').pop());
        if (roles.length || req.length) {
          for (const r of roles) { addComp(roleName(r), 'actor', `Holds the ${r} permission`, ''); addRel(roleName(r), d.name, 'owns', `${r}: ${f.name}()`); }
          for (const r of req) { const n = r.charAt(0).toUpperCase() + r.slice(1); addComp(n, 'actor', `The address checked by msg.sender == ${r}`, ''); addRel(n, d.name, 'calls', `${f.name}() (only ${r})`); }
        } else if (f.mutability !== 'view' && f.mutability !== 'pure' && f.name !== 'constructor') {
          addComp('Anyone', 'actor', 'Any address: these functions have no caller restriction', '');
          addRel('Anyone', d.name, 'calls', `${f.name}()`);
        }
      }
      // calls through typed state variables: asset.transferFrom(...)
      for (const m of b.matchAll(/\b(\w+)\s*\.\s*(\w+)\s*(?:\{[^}]*\})?\s*\(/g)) {
        const [_, recv, method] = m;
        if (vars.has(recv)) addRel(d.name, target(vars.get(recv)), kindFor(method), `${method}()`);
      }
      // calls through casts: IERC20(token).transfer(...)
      for (const m of b.matchAll(/\b([A-Z]\w*)\s*\(\s*[^()]*\)\s*\.\s*(\w+)\s*\(/g)) {
        const [_, type, method] = m;
        if (known.has(type) || /^I[A-Z]/.test(type)) addRel(d.name, target(type), kindFor(method), `${method}()`);
      }
      // low-level calls
      if (/msg\.sender\s*\.\s*call\s*[({]/.test(b)) {
        addComp('Caller (msg.sender)', 'actor', 'Whoever called; receives a low-level callback (a reentrancy entry point)', '');
        addRel(d.name, 'Caller (msg.sender)', 'calls', `low-level call in ${f.name}()`);
      }
      for (const m of b.matchAll(/\b(\w+)\s*\.\s*(call|delegatecall)\s*[({]/g)) {
        const [_, recv, how] = m;
        if (recv === 'msg' || recv === 'sender' || vars.has(recv)) continue;
        if (new RegExp(`\\baddress\\b[^,)]*\\b${recv}\\b`).test(f.params) || /^(target|to|strategy|dest|recipient|callee|module|implementation|impl)$/i.test(recv)) {
          addComp('Any address', 'external', 'An address chosen by the caller: arbitrary external calls go here', '');
          addRel(d.name, 'Any address', how === 'delegatecall' ? 'delegates' : 'calls', `${how} in ${f.name}()`);
        }
      }
    }
  }

  for (const [name, surface] of surfaces) if (components.has(name)) components.get(name).surface = surface;
  return {
    files: files.map((f) => path.relative(base, f) || path.basename(f)),
    components: [...components.values()],
    relations: [...relations.values()].map((r) => ({ from: r.from, to: r.to, type: r.type, label: [...r.labels].slice(0, 4).join(', ') + (r.labels.size > 4 ? ', ...' : '') })),
  };
}
