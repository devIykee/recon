// Hand-drawn shapes in the spirit of rough.js: every stroke is drawn twice with
// slightly different, seeded jitter, so the same item always looks the same.

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => Math.round(n * 10) / 10;

function strokeLine(r, x1, y1, x2, y2, rough) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const off = Math.min(rough, len / 10);
  const j = () => (r() - 0.5) * 2 * off;
  const bow = (r() - 0.5) * Math.min(len / 40, 2.4) * rough;
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const mx = (x1 + x2) / 2 + nx * bow * 2;
  const my = (y1 + y2) / 2 + ny * bow * 2;
  const sx = x1 + j();
  const sy = y1 + j();
  const ex = x2 + j();
  const ey = y2 + j();
  const c1x = sx + (mx - sx) * 0.66 + j() * 0.5;
  const c1y = sy + (my - sy) * 0.66 + j() * 0.5;
  const c2x = ex + (mx - ex) * 0.66 + j() * 0.5;
  const c2y = ey + (my - ey) * 0.66 + j() * 0.5;
  return `M${f(sx)} ${f(sy)}C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}`;
}

export function line(x1, y1, x2, y2, { seed = 1, rough = 1.2, double = true } = {}) {
  const r = rng(seed);
  let d = strokeLine(r, x1, y1, x2, y2, rough);
  if (double) d += strokeLine(r, x1, y1, x2, y2, rough * 1.3);
  return d;
}

// Rounded-ish rectangle with overshooting corners, like a quick marker sketch.
export function rect(w, h, { seed = 1, rough = 1.1, inset = 2, double = true } = {}) {
  const r = rng(seed);
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  const sides = (k) => [
    strokeLine(r, x0 - k, y0, x1 + k, y0, rough),
    strokeLine(r, x1, y0 - k, x1, y1 + k, rough),
    strokeLine(r, x1 + k, y1, x0 - k, y1, rough),
    strokeLine(r, x0, y1 + k, x0, y0 - k, rough),
  ].join('');
  return sides(r() * 2) + (double ? sides(r() * 1.5) : '');
}

export function ellipse(cx, cy, rx, ry, { seed = 1, rough = 1, double = true } = {}) {
  const r = rng(seed);
  const pass = (overlap) => {
    const steps = 14;
    const start = r() * Math.PI * 2;
    const pts = [];
    for (let i = 0; i <= steps + overlap; i++) {
      const a = start + (i / steps) * Math.PI * 2;
      const k = 1 + (r() - 0.5) * 0.05 * rough;
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x, y] = pts[i];
      const [nx, ny] = pts[i + 1];
      d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
    }
    return d;
  };
  return pass(1) + (double ? pass(2) : '');
}

// A curved connector with a hand-drawn arrowhead at the end.
export function arrow(x1, y1, x2, y2, { seed = 1, curve = 0.18, rough = 1 } = {}) {
  const r = rng(seed);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = len * curve * (r() > 0.5 ? 1 : -1);
  const cx = (x1 + x2) / 2 + nx * bend;
  const cy = (y1 + y2) / 2 + ny * bend;
  const j = () => (r() - 0.5) * rough * 2;
  const body = `M${f(x1)} ${f(y1)}Q${f(cx + j())} ${f(cy + j())} ${f(x2)} ${f(y2)}`;
  const ang = Math.atan2(y2 - cy, x2 - cx);
  const size = 11;
  const a1 = ang + Math.PI - 0.45;
  const a2 = ang + Math.PI + 0.45;
  const head = `M${f(x2 + Math.cos(a1) * size + j())} ${f(y2 + Math.sin(a1) * size + j())}L${f(x2)} ${f(y2)}L${f(x2 + Math.cos(a2) * size + j())} ${f(y2 + Math.sin(a2) * size + j())}`;
  return { body, head };
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// A sketch layer sized to its node; regenerates only when size changes.
export function sketchInto(svg, w, hgt, seed, opts = {}) {
  const sig = `${w}x${hgt}:${seed}:${opts.rough || ''}`;
  if (svg.dataset.sig === sig) return;
  svg.dataset.sig = sig;
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', hgt);
  let p = svg.firstChild;
  if (!p) { p = svgEl('path'); svg.append(p); }
  p.setAttribute('d', rect(w, hgt, { seed, ...opts }));
}
