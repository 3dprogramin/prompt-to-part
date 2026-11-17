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
