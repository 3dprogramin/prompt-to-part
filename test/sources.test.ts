import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageKey, siteName, sourcesProblem, sourcesSummary, weakestKind, type DimensionSource } from '../shared/sources';

const src = (kind: DimensionSource['kind'], url?: string): DimensionSource => ({ dimension: 'PCB', value: '85 × 56 mm', kind, url });

test('a page is the same with or without https, www., a trailing slash or a fragment', () => {
  const k = pageKey('https://www.raspberrypi.com/products/raspberry-pi-3-model-b/#specs');
  assert.equal(k, pageKey('http://raspberrypi.com/products/raspberry-pi-3-model-b'));
  assert.notEqual(k, pageKey('https://raspberrypi.com/products/raspberry-pi-4-model-b/'));
  assert.equal(pageKey('file:///etc/passwd'), null);
  assert.equal(pageKey('javascript:alert(1)'), null);
});

test('siteName: the site of a valid web link, null (never a throw) for anything else', () => {
  assert.equal(siteName('https://www.Prusa3D.com/product/x#y'), 'prusa3d.com');
  assert.equal(siteName('http://example.org'), 'example.org');
  // A bad source like "https://" used to throw while drawing the filament picker and blank Jig.
  for (const bad of ['https://', 'http://', 'https:// spaces', 'javascript:alert(1)', 'file:///etc/passwd', 'Prusament datasheet', '', undefined]) {
    assert.equal(siteName(bad), null, String(bad));
  }
});

test('web sources need their page; others may go without', () => {
  assert.equal(sourcesProblem([src('official', 'https://datasheets.raspberrypi.com/rpi3/raspberry-pi-3-b-mechanical-drawing.pdf'), src('memory'), src('estimate'), src('user')]), null);
  assert.match(sourcesProblem([src('official')])!, /no http\(s\) URL/);
  assert.match(sourcesProblem([src('social', 'javascript:alert(1)')])!, /no http\(s\) URL/);
  assert.match(sourcesProblem([src('memory', 'ftp://x')])!, /http\(s\)/);
});

test('summary and weakest source', () => {
  const list = [src('estimate'), src('official', 'https://a.example/x'), src('official', 'https://a.example/y'), src('memory')];
  assert.equal(sourcesSummary(list), '2 official, 1 from memory, 1 estimated');
  assert.equal(weakestKind(list), 'estimate');
  assert.equal(weakestKind([]), null);
});
