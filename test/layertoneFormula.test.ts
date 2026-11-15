// The preview formula: a filament hides what is under it at TD × 0.1 (95 %), as real prints, the
// slicer and other tools show; with the published TD itself, thin layers looked far too see-through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, layerTop, luma, simulateRgb, toLab, toLinear, type LayerColor } from '../shared/layertone';

const L = { layerHeight: 0.08, firstLayerHeight: 0.16 };
const at = (layer: number, color: string, td: number, name: string): LayerColor => ({ z: layerTop(layer, L), layer, color, td, name });

test('three thin layers of blue over black look blue, not near-black', () => {
  const stack = [at(0, '#000000', 0.2, 'Black'), at(5, '#0a5fb4', 2.6, 'Blue')];
  const c = simulateRgb(layerTop(8, L), stack).map((v) => v * 255);
  const d = toLab(c), b = toLab(hexToRgb('#0a5fb4').map((v) => v * 255));
  const dE = Math.hypot(d[0] - b[0], d[1] - b[1], d[2] - b[2]);
  assert.ok(dE < 10, `ΔE ${dE.toFixed(1)} from the blue`);
});

test('a filament covers 95 % of what is under it at TD × 0.1', () => {
  // White (TD 2.6) over black: 0.26 mm of white lets 5 % of the black through, in linear light.
  const stack = [at(0, '#000000', 0.2, 'Black'), { z: 1, layer: 12, color: '#ffffff', td: 2.6, name: 'White' }];
  const lin = simulateRgb(1.26, stack).map(toLinear);
  assert.ok(Math.abs(luma(lin) - 0.95) < 0.02, `linear luma ${luma(lin).toFixed(3)}`);
});

test('toLab is shared: white is L 100', () => {
  assert.ok(Math.abs(toLab([255, 255, 255])[0] - 100) < 0.01);
});
