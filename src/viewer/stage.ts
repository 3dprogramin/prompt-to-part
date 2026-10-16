// The scene's ground: mm grid, axes and the printer's build plate.
import * as THREE from 'three';
import { PRINTER, fitProblem } from '../../shared/printer';
import type { Box3 } from '../../shared/types';
import { label, niceStep } from './overlay';

/** Fills `group` with a mm grid sized for a model of `size` mm, and the X/Y/Z axes; returns the grid step. */
export function buildGrid(group: THREE.Group, size: number): number {
  group.clear();
  const step = niceStep(size * 1.5);
  const extent = Math.max(step * 20, Math.ceil((size * 2.5) / (step * 10)) * step * 10);
  const half = extent / 2;
  const minor: number[] = [], major: number[] = [];
  for (let v = -half; v <= half + 1e-6; v += step) {
    const isMajor = Math.abs(Math.round(v / (step * 5)) * step * 5 - v) < 1e-6;
    const arr = isMajor ? major : minor;
    arr.push(v, -half, 0, v, half, 0, -half, v, 0, half, v, 0);
  }
  const mk = (pts: number[], color: number, opacity: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  };
  group.add(mk(minor, 0x8890a0, 0.13), mk(major, 0x8890a0, 0.3));
  const axes = (to: [number, number, number], color: number) => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(...to)]);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
  };
  group.add(axes([half, 0, 0], 0xe05a5a), axes([0, half, 0], 0x5ac05a), axes([0, 0, Math.min(half, size * 0.6)], 0x5a8ae0));
  return step;
}

/** The printer's plate, its outline and the (dashed) build volume. */
export function buildPlate(group: THREE.Group) {
  const [w, d] = PRINTER.bed, h = PRINTER.height;
  const rect = (z: number) => [[-w / 2, -d / 2, z], [w / 2, -d / 2, z], [w / 2, d / 2, z], [-w / 2, d / 2, z]].map((p) => new THREE.Vector3(...(p as [number, number, number])));
  const loop = (pts: THREE.Vector3[]) => [...pts, pts[0]];
  const plate = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop(rect(0))), new THREE.LineBasicMaterial({ color: 0xe0a43c, transparent: true, opacity: 0.55 }));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: 0xe0a43c, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide }));
  fill.raycast = () => {};
  // Build-volume outline (shown only when the model gets close to the limits)
  const top = rect(h), bottom = rect(0);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) pts.push(bottom[i], top[i], top[i], top[(i + 1) % 4]);
  const volume = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xe0a43c, dashSize: 4, gapSize: 4, transparent: true, opacity: 0.35 }));
  volume.computeLineDistances();
  volume.name = 'volume';
  const tag = label(`${PRINTER.name} · ${w} × ${d} mm plate`, 'plate-label');
  tag.position.set(-w / 2, -d / 2, 0);
  group.add(plate, fill, volume, tag);
}

/** Shows the build volume when the model gets near its limits, and turns the plate red if it doesn't fit. */
export function updatePlate(group: THREE.Group, b: Box3 | null | undefined) {
  const vol = group.getObjectByName('volume');
  if (!vol) return;
  const big = !!b && (b.max[0] - b.min[0] > PRINTER.bed[0] * 0.6 || b.max[1] - b.min[1] > PRINTER.bed[1] * 0.6 || b.max[2] - b.min[2] > PRINTER.height * 0.6);
  vol.visible = big || !!fitProblem(b ?? null);
  const color = fitProblem(b ?? null) ? 0xe5675f : 0xe0a43c;
  for (const o of group.children) {
    const mat = (o as THREE.Line).material as THREE.LineBasicMaterial | undefined;
    if (mat && 'color' in mat && o.type !== 'Mesh') mat.color.set(color);
  }
}
