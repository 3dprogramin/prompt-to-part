import * as THREE from 'three';

/**
 * What the pointer ray hits, nearest first. With a section cut (`clip`) the hits on the removed
 * side are dropped, so the first hit is the cut face or whatever is seen through the cut. The BVH
 * then must not stop at each mesh's first hit (that one is usually the removed front, and
 * everything behind it would be lost); without a cut only the nearest hit is needed, as before.
 */
export function pickHits(raycaster: THREE.Raycaster, meshes: THREE.Object3D[], clip: THREE.Plane | null): THREE.Intersection[] {
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = !clip;
  const hits = raycaster.intersectObjects(meshes, false);
  return clip ? hits.filter((h) => clip.distanceToPoint(h.point) >= 0) : hits;
}
