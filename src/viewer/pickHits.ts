import * as THREE from 'three';

/**
 * What the pointer ray hits, nearest first. With a section cut (`clip`) the hits on the removed
 * side are dropped, so the first hit is what is seen through the cut. Two things then change:
 * the BVH must not stop at each mesh's first hit (that one is usually the removed front, and
 * everything behind it would be lost), and the ray counts back faces too, because what is seen
 * through the cut of a solid part is the inside of its far wall (the viewer draws it with a
 * separate dark BackSide mesh that is not pickable). Without a cut only the nearest front hit is
 * needed, as before. The materials' sides are put back before returning: drawing is untouched.
 */
export function pickHits(raycaster: THREE.Raycaster, meshes: THREE.Object3D[], clip: THREE.Plane | null): THREE.Intersection[] {
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = !clip;
  if (!clip) return raycaster.intersectObjects(meshes, false);
  const saved: [THREE.Material, THREE.Side][] = [];
  for (const m of meshes) for (const mat of [(m as THREE.Mesh).material].flat()) {
    if (mat && !saved.some(([x]) => x === mat)) { saved.push([mat, mat.side]); mat.side = THREE.DoubleSide; }
  }
  try {
    return raycaster.intersectObjects(meshes, false).filter((h) => clip.distanceToPoint(h.point) >= 0);
  } finally {
    for (const [mat, side] of saved) mat.side = side;
  }
}

/**
 * The nearest hit on a surface that faces the ray, for putting something on a face (text): with a
 * cut on, the removed front is skipped like in pickHits, and the inside of a far wall seen through
 * the cut is not a face to put anything on.
 */
export function pickFrontHit(raycaster: THREE.Raycaster, meshes: THREE.Object3D[], clip: THREE.Plane | null): THREE.Intersection | null {
  const n = new THREE.Vector3();
  return pickHits(raycaster, meshes, clip).find((h) => h.face && n.copy(h.face.normal).transformDirection(h.object.matrixWorld).dot(raycaster.ray.direction) < 0) ?? null;
}
