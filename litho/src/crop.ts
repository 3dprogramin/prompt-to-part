// Framing: which part of the photo fills the lithophane's picture. The photo always covers the
// frame (no empty edges); zoom 1 is the largest crop of the frame's proportions, centred on
// (cx, cy). Pure arithmetic, shared by the widget's editor and the production page.

/** Where the photo sits in the frame: zoom ≥ 1, and the crop's centre as a fraction of the photo (0–1). */
export interface Crop {
  zoom: number;
  cx: number;
  cy: number;
}

/** A rectangle in photo pixels (or, normalised, in fractions of the photo). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ZOOM = 5;
export const CENTRED: Crop = { zoom: 1, cx: 0.5, cy: 0.5 };

/** The part of a photoW × photoH photo shown in a frame of proportions `aspect` (width / height). */
export function cropRect(photoW: number, photoH: number, aspect: number, crop: Crop): Rect {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom || 1));
  // The largest rectangle of the frame's proportions that fits the photo, shrunk by the zoom.
  let w = photoW, h = photoW / aspect;
  if (h > photoH) { h = photoH; w = photoH * aspect; }
  w /= zoom; h /= zoom;
  const x = Math.min(photoW - w, Math.max(0, crop.cx * photoW - w / 2));
  const y = Math.min(photoH - h, Math.max(0, crop.cy * photoH - h / 2));
  return { x, y, w, h };
}

/** The crop with its zoom in range and its centre moved so the frame stays inside the photo. */
export function clampCrop(photoW: number, photoH: number, aspect: number, crop: Crop): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom || 1));
  const r = cropRect(photoW, photoH, aspect, { ...crop, zoom });
  return { zoom, cx: (r.x + r.w / 2) / photoW, cy: (r.y + r.h / 2) / photoH };
}

/** The crop after dragging the photo by (dx, dy) screen pixels, where the frame is `frameW` pixels wide on screen. */
export function panCrop(photoW: number, photoH: number, aspect: number, crop: Crop, dx: number, dy: number, frameW: number): Crop {
  const r = cropRect(photoW, photoH, aspect, crop);
  const s = r.w / frameW; // photo pixels per screen pixel
  return clampCrop(photoW, photoH, aspect, { ...crop, cx: crop.cx - (dx * s) / photoW, cy: crop.cy - (dy * s) / photoH });
}

/**
 * The crop after zooming by `factor` around a point of the frame (fx, fy as fractions of the frame,
 * 0.5 = its centre): that point of the photo stays under the finger or cursor.
 */
export function zoomCrop(photoW: number, photoH: number, aspect: number, crop: Crop, factor: number, fx = 0.5, fy = 0.5): Crop {
  const r = cropRect(photoW, photoH, aspect, crop);
  const px = r.x + fx * r.w, py = r.y + fy * r.h; // the photo point under (fx, fy)
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom * factor));
  const w = r.w * (crop.zoom / zoom), h = r.h * (crop.zoom / zoom);
  return clampCrop(photoW, photoH, aspect, { zoom, cx: (px - fx * w + w / 2) / photoW, cy: (py - fy * h + h / 2) / photoH });
}

/** A rectangle as fractions of the photo, rounded to 5 decimals (saved with the order). */
export function normaliseRect(r: Rect, photoW: number, photoH: number): Rect {
  const f = (v: number) => Math.round(v * 1e5) / 1e5;
  return { x: f(r.x / photoW), y: f(r.y / photoH), w: f(r.w / photoW), h: f(r.h / photoH) };
}

/** A crop that shows the normalised rectangle `n` (from a saved order) in a frame of proportions `aspect`. */
export function cropFromRect(n: Rect, photoW: number, photoH: number, aspect: number): Crop {
  const full = cropRect(photoW, photoH, aspect, CENTRED);
  return clampCrop(photoW, photoH, aspect, { zoom: full.w / Math.max(1e-6, n.w * photoW), cx: n.x + n.w / 2, cy: n.y + n.h / 2 });
}
