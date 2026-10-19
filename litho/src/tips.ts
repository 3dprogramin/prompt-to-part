// Photo tips: warn the customer, before they order, when a picture is likely to make a poor
// lithophane (too dark, washed out, too small for the size). Pure functions over the picture's
// brightness bytes.
import type { StringKey } from './i18n';

export interface PhotoStats {
  /** Mean brightness, 0–255. */
  mean: number;
  /** 5th and 95th percentile brightness: their gap is the usable contrast. */
  p5: number;
  p95: number;
}

/** Brightness statistics of 8-bit luminance pixels. */
export function photoStats(luma: ArrayLike<number>): PhotoStats {
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < luma.length; i++) { hist[luma[i]]++; sum += luma[i]; }
  const n = Math.max(1, luma.length);
  const pct = (p: number) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; } return 255; };
  return { mean: sum / n, p5: pct(0.05), p95: pct(0.95) };
}

/** Fewer photo pixels per mm of print than this looks soft (white PLA resolves about 0.2–0.3 mm). */
export const MIN_PX_PER_MM = 3;

/**
 * The tips for a photo: its brightness statistics, how many photo pixels the crop has across its
 * longer side, and the picture's longer side in mm. Empty when it should print well.
 */
export function photoTips(s: PhotoStats, cropLongPx: number, pictureLongMm: number): StringKey[] {
  const tips: StringKey[] = [];
  if (s.mean < 70 || s.p95 < 140) tips.push('tipDark');
  else if (s.mean > 200 && s.p5 > 120) tips.push('tipBright');
  if (s.p95 - s.p5 < 80) tips.push('tipFlat');
  if (cropLongPx / Math.max(1, pictureLongMm) < MIN_PX_PER_MM) tips.push('tipSmall');
  return tips;
}
