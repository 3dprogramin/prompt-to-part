// Product photo renders: how far the camera stands to frame the model, and the backdrop behind it.
import * as THREE from 'three';
import type { EvalResult } from '../../shared/types';

/** Camera distance along `dir` at which every corner of `box` is inside `fill` of the frame. */
export function framingDistance(box: THREE.Box3, center: THREE.Vector3, dir: THREE.Vector3, cam: THREE.PerspectiveCamera, fill: number): number {
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * fill, tanH = tanV * cam.aspect;
  const right = new THREE.Vector3().crossVectors(cam.up, dir).normalize();
  if (right.lengthSq() < 0.5) right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  let d = 1;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
    // Depth of the corner from a camera at distance D is D - p·dir.
    d = Math.max(d, p.dot(dir) + Math.abs(p.dot(right)) / tanH, p.dot(dir) + Math.abs(p.dot(up)) / tanV);
  }
  return d;
}

/** The parts are light on the whole (by area). */
export function lightParts(parts: EvalResult['parts']): boolean {
  let sum = 0, weight = 0;
  for (const p of parts) {
    const c = new THREE.Color(p.vertexColors || p.paint ? '#808080' : p.color);
    sum += (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * p.surfaceArea;
    weight += p.surfaceArea;
  }
  return weight > 0 && sum / weight > 0.45;
}

/** A plain grey that the parts stand out from: mid grey behind light models, light grey otherwise. */
export const photoBackground = (parts: EvalResult['parts']) => new THREE.Color(lightParts(parts) ? '#8a8d93' : '#dcdde0');
