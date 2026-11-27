// Infinite canvas camera: pan, zoom around the cursor, pinch, fit-to-content and
// animated fly-to. Emits zoom-level classes for semantic zoom.

const MIN_Z = 0.12;
const MAX_Z = 2.5;
const STORE = 'recon.camera';

export const ZOOM = { far: 0.5, near: 1.15 };

export function createCamera(stage, world, { onChange } = {}) {
  const cam = { x: 0, y: 0, z: 1 };
  let level = '';
  let raf = null;
  let anim = null;

  function apply() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    const grid = 24 * cam.z;
    const g = grid < 10 ? grid * Math.ceil(10 / grid) : grid;
    stage.style.setProperty('--grid', `${g}px`);
    stage.style.setProperty('--gx', `${cam.x % g}px`);
    stage.style.setProperty('--gy', `${cam.y % g}px`);
    stage.style.setProperty('--z', cam.z);
    stage.style.setProperty('--lbl', Math.min(3.4, Math.max(1, 0.62 / cam.z)).toFixed(3));
    const next = cam.z < ZOOM.far ? 'z-far' : cam.z < ZOOM.near ? 'z-mid' : 'z-near';
    if (next !== level) {
      stage.classList.remove('z-far', 'z-mid', 'z-near');
      stage.classList.add(next);
      level = next;
    }
    onChange?.(cam, level);
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; apply(); save(); });
  }

  let saveT = null;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(cam)); } catch { /* ignore */ } }, 300);
  }

  function restore() {
    try {
      const c = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (c && Number.isFinite(c.z)) { Object.assign(cam, c); apply(); return true; }
    } catch { /* ignore */ }
    return false;
  }

  function zoomAt(z, sx, sy) {
    z = Math.max(MIN_Z, Math.min(MAX_Z, z));
    const wx = (sx - cam.x) / cam.z;
    const wy = (sy - cam.y) / cam.z;
    cam.z = z;
    cam.x = sx - wx * z;
    cam.y = sy - wy * z;
    schedule();
  }

  function animateTo(target, ms = 450) {
    cancelAnimationFrame(anim);
    const from = { ...cam };
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      cam.x = from.x + (target.x - from.x) * e;
      cam.y = from.y + (target.y - from.y) * e;
      cam.z = from.z + (target.z - from.z) * e;
      apply();
      if (t < 1) anim = requestAnimationFrame(step); else save();
    };
    anim = requestAnimationFrame(step);
  }

  function viewport() {
    const app = document.querySelector('.app');
    const sidebar = app.classList.contains('sidebar-open') ? (document.getElementById('sidebar').offsetWidth + 32) : 0;
    return { left: 24, top: app.classList.contains('has-banner') ? 136 : 90, right: innerWidth - 24 - sidebar, bottom: innerHeight - 70 };
  }

  function fit(bounds, { animate = true, maxZ = 1.1 } = {}) {
    if (!bounds) return;
    const v = viewport();
    const vw = Math.max(200, v.right - v.left);
    const vh = Math.max(200, v.bottom - v.top);
    const z = Math.max(MIN_Z, Math.min(maxZ, vw / bounds.w, vh / bounds.h));
    const target = {
      z,
      x: v.left + (vw - bounds.w * z) / 2 - bounds.x * z,
      y: v.top + (vh - bounds.h * z) / 2 - bounds.y * z,
    };
    if (animate) animateTo(target); else { Object.assign(cam, target); apply(); save(); }
  }

  function centerOn(x, y, z = cam.z) {
    const v = viewport();
    animateTo({ z, x: (v.left + v.right) / 2 - x * z, y: (v.top + v.bottom) / 2 - y * z });
  }

  // Make sure a world rect is visible at a readable zoom.
  function reveal(r, { minZ = 0.85 } = {}) {
    const v = viewport();
    const z = Math.max(cam.z, minZ);
    const sx = r.x * z;
    const sy = r.y * z;
    let x = cam.x;
    let y = cam.y;
    if (z !== cam.z) { x = (v.left + v.right) / 2 - (r.x + r.w / 2) * z; y = v.top + 40 - r.y * z; }
    const left = x + sx;
    const top = y + sy;
    const right = left + r.w * z;
    const bottom = top + r.h * z;
    if (right > v.right) x -= right - v.right + 20;
    if (left + (x - cam.x) < v.left) x += v.left - left + 20;
    if (bottom > v.bottom) y -= Math.min(bottom - v.bottom + 20, top - v.top - 10);
    if (top < v.top) y += v.top - top + 10;
    if (x !== cam.x || y !== cam.y || z !== cam.z) animateTo({ x, y, z });
  }

  // ---------- input ----------

  const pointers = new Map();
  let pan = null;
  let pinch = null;
  let space = false;

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelAnimationFrame(anim);
    const isMouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || isMouseWheel) {
      const factor = Math.exp(-e.deltaY * (e.ctrlKey && !isMouseWheel ? 0.01 : 0.0018) * (e.deltaMode === 1 ? 33 : 1));
      zoomAt(cam.z * factor, e.clientX, e.clientY);
    } else {
      cam.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      cam.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      schedule();
    }
  }, { passive: false });

  stage.addEventListener('pointerdown', (e) => {
    const onBackground = !e.target.closest('.node.comp, .node.card, .node.sticky, .node.summary, .node.add, .marker, .expanded, .frame-label, .frame-bar');
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: cam.z, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      pan = null;
      return;
    }
    if (e.button === 1 || space || (e.button === 0 && onBackground)) {
      cancelAnimationFrame(anim);
      pan = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('panning');
      if (e.button === 1) e.preventDefault();
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch.z * (d / pinch.d), pinch.cx, pinch.cy);
      return;
    }
    if (!pan) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    cam.x = pan.cx + dx;
    cam.y = pan.cy + dy;
    schedule();
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pan) {
      stage.classList.remove('panning');
      if (pan.moved) stage.dataset.justPanned = '1';
      setTimeout(() => delete stage.dataset.justPanned, 0);
      pan = null;
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e)) { space = true; stage.classList.add('space'); }
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'Space') { space = false; stage.classList.remove('space'); }
  });

  return {
    cam,
    apply,
    restore,
    fit,
    centerOn,
    reveal,
    animateTo,
    zoomBy(f) {
      const v = viewport();
      const cx = (v.left + v.right) / 2;
      const cy = (v.top + v.bottom) / 2;
      const z = Math.max(MIN_Z, Math.min(MAX_Z, cam.z * f));
      const wx = (cx - cam.x) / cam.z;
      const wy = (cy - cam.y) / cam.z;
      animateTo({ z, x: cx - wx * z, y: cy - wy * z }, 220);
    },
    resetZoom() { this.zoomBy(1 / cam.z); },
    get level() { return level; },
  };
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
