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

/** Push overlapping dimension labels apart vertically (screen space). */
export function declutter(root: HTMLElement) {
  const items = [...root.querySelectorAll<HTMLElement>('.dim-label')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ el, r: el.parentElement!.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top);
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  for (const { el, r } of items) {
    let dy = 0;
    for (let iter = 0; iter < 12; iter++) {
      const hit = placed.find((p) => r.left < p.r && r.right > p.l && r.top + dy < p.b && r.bottom + dy > p.t);
      if (!hit) break;
      dy = hit.b - r.top + 2;
    }
    el.style.transform = dy ? `translateY(${dy}px)` : '';
    placed.push({ l: r.left, r: r.right, t: r.top + dy, b: r.bottom + dy });
  }
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
