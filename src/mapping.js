// Apply an architecture map (components + relations, by name) to a target.
// Shared by recon_map, recon_scan and the cli. Idempotent: components are
// matched by name and relations are unique per (from, to, type).

export async function applyMap(c, targetRef, { components = [], relations = [] } = {}) {
  const t = (await c.resolve(targetRef, 'target')).item;
  const existing = await c.list('component', { targetId: t.id });
  const byName = new Map(existing.map((x) => [x.name.toLowerCase(), x]));
  const out = { components: 0, relations: 0, errors: [] };
  for (const comp of components) {
    try {
      const cur = byName.get(comp.name.toLowerCase());
      const fields = Object.fromEntries(['type', 'summary', 'location'].filter((k) => comp[k] !== undefined && comp[k] !== '').map((k) => [k, comp[k]]));
      const mapOnly = comp.type === 'actor' || comp.type === 'external';
      const item = cur
        ? (Object.keys(fields).length ? await c.update('component', cur.id, cur.summary && fields.summary && cur.lastTouchedBy?.startsWith('human') ? { ...fields, summary: cur.summary } : fields) : cur)
        : await c.create('component', { name: comp.name, targetId: t.id, ...fields, ...(mapOnly ? { reviewState: 'reviewed' } : {}) });
      byName.set(item.name.toLowerCase(), item);
      out.components++;
    } catch (err) { out.errors.push(`${comp.name}: ${err.message}`); }
  }
  for (const r of relations) {
    const from = byName.get(String(r.from).toLowerCase());
    const to = byName.get(String(r.to).toLowerCase());
    if (!from || !to) { out.errors.push(`relation ${r.from} -> ${r.to}: add both components first`); continue; }
    try { await c.create('relation', { targetId: t.id, from: from.id, to: to.id, type: r.type || 'calls', label: r.label || '' }); out.relations++; } catch (err) { out.errors.push(`${r.from} -> ${r.to}: ${err.message}`); }
  }
  const all = await c.list('relation', { targetId: t.id });
  const linked = new Set(all.flatMap((r) => [r.from, r.to]));
  const unconnected = [...byName.values()].filter((x) => !linked.has(x.id)).map((x) => x.name);
  return { ...out, mapSize: { components: byName.size, relations: all.length }, unconnected, phase: t.phase };
}
