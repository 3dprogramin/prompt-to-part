// Labels, dimension lines and other overlays drawn over the 3D view.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export const fmt = (n: number) => (Math.abs(n) < 0.005 ? '0' : n.toFixed(2));

export function niceStep(span: number) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  return steps.find((s) => span / s <= 30) ?? 1000;
}

export function label(text: string, cls: string) {
  const wrap = document.createElement('div');
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  wrap.appendChild(el);
  return new CSS2DObject(wrap);
}

/** Each dimension label's line ends (in its parent's space), for sliding the label along its line. */
const lineEnds = new WeakMap<HTMLElement, { obj: CSS2DObject; a: THREE.Vector3; b: THREE.Vector3 }>();
/** The spot each label took last frame: kept while it stays free, so labels don't hop as the view turns. */
const lastSpot = new WeakMap<HTMLElement, number>();

// Where along its own line a label may sit, best first: the middle, then out towards the ends.
const ALONG = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78, 0.15, 0.85];
const GAP = 6; // px kept clear around every label
// Labels placed first keep the best spots: a measurement just taken, then the overall size, then callouts.
const rank = (el: HTMLElement) => (el.classList.contains('dim-measure') ? 0 : el.classList.contains('dim-ann') ? 2 : 1);

type Box = { l: number; r: number; t: number; b: number };
const overlap = (p: Box, q: Box) => Math.max(0, Math.min(p.r, q.r) - Math.max(p.l, q.l)) * Math.max(0, Math.min(p.b, q.b) - Math.max(p.t, q.t));

/**
 * Keep dimension labels from covering each other (screen space). A label first slides along its own
 * dimension line, where it still plainly belongs to that line; only when the whole line is taken does
 * it step off to the side, with a thin leader line back to its dimension.
 */
export function declutter(root: HTMLElement, camera?: THREE.Camera) {
  const view = root.getBoundingClientRect();
  const v = new THREE.Vector3();
  const screen = (p: THREE.Vector3, obj: CSS2DObject) => {
    v.copy(p);
    if (obj.parent) v.applyMatrix4(obj.parent.matrixWorld);
    v.project(camera!);
    return { x: view.left + ((v.x + 1) / 2) * view.width, y: view.top + ((1 - v.y) / 2) * view.height };
  };
  const items = [...root.querySelectorAll<HTMLElement>('.dim-label')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, r: el.parentElement!.getBoundingClientRect() }))
    .sort((p, q) => rank(p.el) - rank(q.el) || p.r.top - q.r.top);
  const placed: Box[] = [];
  for (const { el, r } of items) {
    const wrap = el.parentElement!;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const w = r.width + GAP, h = r.height + GAP;
    // Candidate offsets from the label's own spot (the line's middle), in order of preference.
    const spots: { dx: number; dy: number; lead: boolean }[] = [];
    const ends = camera && lineEnds.get(wrap);
    let dir = { x: 0, y: 1 };
    if (ends) {
      const a = screen(ends.a, ends.obj), b = screen(ends.b, ends.obj);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // The spot itself is where the label already is: no projection rounding moves it.
      spots.push({ dx: 0, dy: 0, lead: false });
      const p = new THREE.Vector3();
      for (const t of ALONG.slice(1)) {
        // Along the line in 3D, then onto the screen (under perspective the screen midpoint isn't the 3D one).
        const q = screen(p.lerpVectors(ends.a, ends.b, t), ends.obj);
        // Not past the line's own ends: the label must stay on it.
        if (Math.abs(t - 0.5) * len * 2 < len - Math.max(r.width, r.height) * 0.6) spots.push({ dx: q.x - cx, dy: q.y - cy, lead: false });
      }
      if (len > 1) dir = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    } else spots.push({ dx: 0, dy: 0, lead: false });
    // Then off to either side of the line's middle, a step further each time.
    const step = Math.abs(dir.x) * w + Math.abs(dir.y) * h;
    for (let k = 1; k <= 8; k++) for (const s of [1, -1]) spots.push({ dx: dir.x * step * k * s, dy: dir.y * step * k * s, lead: true });

    const boxAt = (s: { dx: number; dy: number }): Box => ({ l: r.left + s.dx - GAP / 2, r: r.right + s.dx + GAP / 2, t: r.top + s.dy - GAP / 2, b: r.bottom + s.dy + GAP / 2 });
    const cost = (i: number) => {
      const bx = boxAt(spots[i]);
      // Leaving the view counts as covering something.
      const out = (Math.max(0, view.left - bx.l) + Math.max(0, bx.r - view.right)) * h + (Math.max(0, view.top - bx.t) + Math.max(0, bx.b - view.bottom)) * w;
      return placed.reduce((sum, p) => sum + overlap(bx, p), 0) + out;
    };
    let best = 0, bestCost = Infinity;
    const prev = lastSpot.get(el);
    // A spot on the line is kept while free; one off to the side only until the line has room again.
    if (prev !== undefined && prev < spots.length && !spots[prev].lead && cost(prev) === 0) best = prev;
    else for (let i = 0; i < spots.length; i++) {
      const c = cost(i);
      if (c < bestCost) { best = i; bestCost = c; }
      if (c === 0) break;
    }
    lastSpot.set(el, best);
    const s = spots[best];
    el.style.transform = s.dx || s.dy ? `translate(${Math.round(s.dx)}px, ${Math.round(s.dy)}px)` : '';
    leader(wrap, el, s.lead ? s : null);
    placed.push(boxAt(s));
  }
}

/** A thin line from a label's dimension (the wrapper's centre) to the label moved off it, or none. */
function leader(wrap: HTMLElement, el: HTMLElement, to: { dx: number; dy: number } | null) {
  let line = wrap.querySelector<HTMLElement>(':scope > .dim-leader');
  if (!to) { if (line) line.style.display = 'none'; return; }
  if (!line) {
    line = document.createElement('div');
    line.className = 'dim-leader';
    line.style.background = getComputedStyle(el).borderColor;
    wrap.prepend(line);
  }
  line.style.display = '';
  line.style.width = `${Math.hypot(to.dx, to.dy)}px`;
  line.style.transform = `rotate(${Math.atan2(to.dy, to.dx)}rad)`;
}

/**
 * A dimension line from `from` to `to`, drawn `offset` away with extension lines, arrowheads and a
 * label. `size` (the model's size) scales the arrows; `onEdit` makes the label editable.
 */
export function dimLine(group: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, offset: THREE.Vector3, text: string, color: number, cls: string, size: number,
onEdit?: (el: HTMLElement, current: number) => void) {
  const a = from.clone().add(offset), b = to.clone().add(offset);
  const len = a.distanceTo(b);
  if (len < 1e-6) return;
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const pts: THREE.Vector3[] = [a, b];
  if (offset.lengthSq() > 1e-9) {
    const ext = offset.clone().normalize().multiplyScalar(size * 0.02);
    pts.push(from, a.clone().add(ext), to, b.clone().add(ext));
  }
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat);
  lines.renderOrder = 999;
  group.add(lines);
  const dir = b.clone().sub(a).normalize();
  const arrowLen = Math.min(len * 0.25, size * 0.035);
  const coneGeom = new THREE.ConeGeometry(arrowLen * 0.32, arrowLen, 12);
  coneGeom.translate(0, -arrowLen / 2, 0);
  const coneMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  for (const [p, d] of [[a, dir.clone().negate()], [b, dir]] as const) {
    const cone = new THREE.Mesh(coneGeom, coneMat);
    cone.position.copy(p);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    cone.renderOrder = 999;
    cone.raycast = () => {};
    group.add(cone);
  }
  const lbl = label(text, cls);
  lbl.position.copy(a.clone().add(b).multiplyScalar(0.5));
  lineEnds.set(lbl.element, { obj: lbl, a, b });
  if (onEdit) {
    const el = lbl.element.firstElementChild as HTMLElement;
    el.classList.add('editable');
    el.title = 'Double-click to edit';
    el.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      onEdit(el, from.distanceTo(to));
    });
  }
  group.add(lbl);
}

/** Empties a group, removing its HTML labels and freeing its geometry. */
export function clearGroup(group: THREE.Group) {
  group.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
  });
  group.clear();
}
