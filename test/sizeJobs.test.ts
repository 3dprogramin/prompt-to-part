import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromFirstPhoto, lacksFirstPhoto } from '../src/components/photos/sizeJobs';
import type { PhotoRequest } from '../shared/photos';

const variant = { request: {
  render: { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' }, from: { photo: '' }, scene: 'wall', aspect: '1:1', saleSize: { id: 'l', label: 'L' },
  resize: { base: { label: 'M', size: [150, 100, 6] } }, product: { name: 'Plaque', size: [225, 150, 6], faceOn: true },
} as PhotoRequest };

test('a size waits for its first photo until it has one, then it can be made and tried again', () => {
  assert.equal(lacksFirstPhoto(variant), true);
  const made = fromFirstPhoto(variant, '/api/designs/x/images/a.png');
  assert.equal(made.request.from?.photo, '/api/designs/x/images/a.png');
  assert.equal(lacksFirstPhoto(made), false, 'a failed size with its photo is retried itself, not sent to a first photo that is not there');
  assert.equal(variant.request.from?.photo, '', 'the original is not changed');
});
