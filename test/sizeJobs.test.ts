import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromFirstPhoto, lacksFirstPhoto, planSizes } from '../src/components/photos/sizeJobs';
import type { PhotoRequest } from '../shared/photos';

const req = (id: string, from?: { photo: string }): PhotoRequest => ({
  render: { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }, ...(from ? { from } : {}), scene: 'wall', aspect: '1:1', saleSize: { id, label: id.toUpperCase() },
  ...(from ? { resize: { base: { label: 'M', size: [150, 100, 6] } } } : {}), product: { name: 'Plaque', size: [225, 150, 6], faceOn: true },
} as PhotoRequest);
let n = 0;
const make = (request: PhotoRequest, camera?: string) => ({ id: `j${++n}`, request, camera });
const PHOTO = '/api/designs/x/images/a.png';

test('sizes of a first photo that exists are in the list with that photo, so a failed one can be tried again', () => {
  const { all, ready, later } = planSizes([{ base: { url: PHOTO }, variants: [req('s', { photo: '' }), req('l', { photo: '' })] }], make);
  assert.equal(all.length, 2);
  // The jobs go into the list as they are: nothing patches them afterwards.
  for (const j of all) {
    assert.equal(j.request.from?.photo, PHOTO);
    assert.equal(lacksFirstPhoto(j), false, 'retry runs it itself instead of looking for a first photo that is not there');
  }
  assert.deepEqual(ready.map((j) => j.id), all.map((j) => j.id), 'and they can start at once');
  assert.equal(later.length, 0);
});

test('sizes of a first photo made now wait for it', () => {
  const { all, ready, later } = planSizes([{ base: { request: req('m') }, variants: [req('l', { photo: '' })], camera: 'front' }], make);
  assert.equal(all.length, 2);
  assert.equal(ready.length, 1, 'only the first photo starts');
  assert.equal(ready[0], later[0].first);
  assert.equal(lacksFirstPhoto(later[0].variants[0]), true);
  assert.equal(later[0].variants[0].camera, 'front');
  const made = fromFirstPhoto(later[0].variants[0], PHOTO);
  assert.equal(lacksFirstPhoto(made), false);
  assert.equal(later[0].variants[0].request.from?.photo, '', 'the original is not changed');
});
