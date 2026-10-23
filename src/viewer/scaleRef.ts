// The reference of known size a size photo's render shows beside the product, at true scale
// (shared/photos scaleRefLayout): a plain wall or table, and on it a light switch or a mug. Only
// in the photo render: added for it and taken away right after.
import * as THREE from 'three';
import { MUG_SIZE, SWITCH_PLATE, type ScaleRef, type ScaleRefLayout } from '../../shared/photos';

/** A rounded rectangle, centred. */
function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** A slab of a rounded rectangle `w` × `h`, `depth` thick from z = 0, with soft edges. */
function slab(w: number, h: number, r: number, depth: number, bevel: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(roundedRect(w - 2 * bevel, h - 2 * bevel, Math.max(0.5, r - bevel)), {
    depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 6,
  });
  g.translate(0, 0, bevel);
  return g;
}

/**
 * The wall or table (a big plane under the product, in `color`) and the reference on it: a white
 * switch plate with its rocker, or a white mug with its handle pointing along `side`.
 */
export function scaleRefModel(kind: ScaleRef, layout: ScaleRefLayout, side: THREE.Vector3, color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const { ref, frame } = layout;
  const z = ref.min[2];
  const reach = Math.max(frame.max[0] - frame.min[0], frame.max[1] - frame.min[1]);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(reach * 20, reach * 20), new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 }));
  // A hair behind the product's back, so it never shows through the plane.
  plane.position.set((frame.min[0] + frame.max[0]) / 2, (frame.min[1] + frame.max[1]) / 2, z - 0.05);
  group.add(plane);
  const white = new THREE.MeshStandardMaterial({ color: '#f4f3ef', roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  const cx = (ref.min[0] + ref.max[0]) / 2, cy = (ref.min[1] + ref.max[1]) / 2;
  if (kind === 'switch') {
    const s = SWITCH_PLATE.side;
    const plate = new THREE.Mesh(slab(s, s, 6, SWITCH_PLATE.depth - 2, 1.5), white);
    // The rocker, tipped a little, so its edges show.
    const rocker = new THREE.Mesh(slab(0.62 * s, 0.62 * s, 3, 2.5, 0.8), new THREE.MeshStandardMaterial({ color: '#f7f6f2', roughness: 0.4, metalness: 0 }));
    rocker.position.z = SWITCH_PLATE.depth - 2.5;
    rocker.rotation.x = THREE.MathUtils.degToRad(3);
    const sw = new THREE.Group();
    sw.add(plate, rocker);
    sw.position.set(cx, cy, z);
    group.add(sw);
  } else {
    const r = MUG_SIZE.diameter / 2, h = MUG_SIZE.height;
    // Its wall and its inside, turned about its axis (the lathe's y, stood up along z).
    const profile = [[0, 0], [r - 2, 0], [r, 2], [r, h - 1.5], [r - 0.6, h], [r - 3, h], [r - 3.6, h - 1.5], [r - 3.6, 9], [0, 9]].map(([a, b]) => new THREE.Vector2(a, b));
    const body = new THREE.LatheGeometry(profile, 64);
    body.rotateX(Math.PI / 2);
    const mug = new THREE.Group();
    mug.add(new THREE.Mesh(body, white));
    // The handle: half a ring on its side, away from the product.
    const handle = new THREE.Mesh(new THREE.TorusGeometry(22, 5, 16, 32, Math.PI), white);
    handle.rotation.set(Math.PI / 2, 0, 0);
    handle.rotateZ(-Math.PI / 2);
    const holder = new THREE.Group();
    holder.add(handle);
    holder.position.set(r - 2, 0, h * 0.52);
    holder.rotation.z = Math.atan2(side.y, side.x);
    holder.position.applyAxisAngle(new THREE.Vector3(0, 0, 1), holder.rotation.z);
    mug.add(holder);
    mug.position.set(cx, cy, z);
    group.add(mug);
  }
  return group;
}

/** Frees what scaleRefModel made. */
export function disposeScaleRef(group: THREE.Group) {
  group.removeFromParent();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  });
}
