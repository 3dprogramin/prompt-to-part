import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { pickHits } from '../src/viewer/pickHits';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: unknown }).computeBoundsTree = computeBoundsTree;

const box = () => {
  const g = new THREE.BoxGeometry(2, 2, 2);
  (g as unknown as { computeBoundsTree: () => void }).computeBoundsTree();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.FrontSide }));
  m.updateMatrixWorld();
  return m;
};
// A ray from in front of the box (+z) going in; the cut keeps z <= 0, as the viewer's plane does.
const ray = () => new THREE.Raycaster(new THREE.Vector3(0.1, 0.2, 5), new THREE.Vector3(0, 0, -1));
const keepBack = () => new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

test('with a section cut on, the ray reaches what is seen through the cut', () => {
  const hit = pickHits(ray(), [box()], keepBack())[0];
  assert.ok(hit, 'the far wall seen through the cut is picked');
  assert.ok(Math.abs(hit.point.z + 1) < 1e-6, `far wall at z=-1, got ${hit.point.z}`);
});

test('the pickable material is left as it was, so drawing and later rays are unchanged', () => {
  const m = box(), r = ray();
  pickHits(r, [m], keepBack());
  assert.equal((m.material as THREE.Material).side, THREE.FrontSide);
  assert.equal(pickHits(r, [m], null)[0].point.z, 1, 'a ray without the cut is front-face again');
  assert.equal((m.material as THREE.Material).side, THREE.FrontSide);
});

test('without a cut the nearest hit is the front wall', () => {
  const hits = pickHits(ray(), [box()], null);
  assert.ok(Math.abs(hits[0].point.z - 1) < 1e-6);
});
