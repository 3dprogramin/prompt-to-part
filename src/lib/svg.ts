// Reading an SVG file for the SVG tool: its filled shapes (paths, rectangles, circles, ellipses,
// polygons, <use> copies) with their transforms and fill rules, flattened to polygons. Strokes,
// text and images are reported, not imported. Runs in the page, which has an XML parser.
import { cleanDrawing, MAX_SVG_POINTS, type SvgDrawing } from '../../shared/svgFeatures';
import type { Vec2 } from '../../shared/types';

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f */
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export interface SvgImport {
  drawing: SvgDrawing;
  /** What was left out, e.g. "3 strokes (not filled) were skipped". */
  notes: string[];
}

const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'linearGradient', 'radialGradient', 'style', 'title', 'desc', 'metadata', 'foreignObject', 'script']);

export function importSvg(source: string, name: string): SvgImport {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') throw new Error('This is not a valid SVG file.');

  // Curves are flattened to within 1/2000 of the drawing's size.
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const extent = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? Math.hypot(vb[2], vb[3]) : Math.hypot(length(root.getAttribute('width'), 100), length(root.getAttribute('height'), 100));
  const tolerance = extent / 2000;

  const shapes: { rule: 'NonZero' | 'EvenOdd'; contours: Vec2[][] }[] = [];
  const skipped = { strokes: 0, text: 0, images: 0 };
  const walk = (el: Element, m: Matrix, inherited: { fill: string; rule: string }, depth: number) => {
    if (depth > 64 || SKIP.has(el.localName)) return;
    if (style(el, 'display') === 'none' || style(el, 'visibility') === 'hidden') return;
    const own = el.getAttribute('transform');
    const mm = own ? multiply(m, parseTransform(own)) : m;
    const fill = style(el, 'fill') ?? inherited.fill;
    const rule = style(el, 'fill-rule') ?? inherited.rule;
    const tag = el.localName;
    if (tag === 'text' || tag === 'tspan') { skipped.text++; return; }
    if (tag === 'image') { skipped.images++; return; }
    if (tag === 'use') {
      const id = (el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '').replace(/^#/, '');
      const target = id ? doc.getElementById(id) : null;
      const at = multiply(mm, [1, 0, 0, 1, num(el, 'x'), num(el, 'y')]);
      // The referenced element is drawn as if it were here (inside <defs> or <symbol> too).
      if (target) target.localName === 'symbol' ? [...target.children].forEach((c) => walk(c, at, { fill, rule }, depth + 1)) : walk(target, at, { fill, rule }, depth + 1);
      return;
    }
    const outline = geometry(el, tolerance / Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]) || 1));
    // A line is only ever a stroke.
    if (tag === 'line' && (style(el, 'stroke') ?? 'none') !== 'none') skipped.strokes++;
    if (outline) {
      if (fill === 'none' || fill === 'transparent' || Number(style(el, 'fill-opacity') ?? 1) === 0) {
        if ((style(el, 'stroke') ?? 'none') !== 'none') skipped.strokes++;
      } else {
        const contours = outline.map((c) => c.map(([x, y]) => [mm[0] * x + mm[2] * y + mm[4], -(mm[1] * x + mm[3] * y + mm[5])] as Vec2)).filter((c) => c.length >= 3);
        if (contours.length) shapes.push({ rule: rule === 'evenodd' ? 'EvenOdd' : 'NonZero', contours });
      }
    }
    for (const child of el.children) walk(child, mm, { fill, rule }, depth + 1);
  };
  walk(root, IDENTITY, { fill: '#000', rule: 'nonzero' }, 0);

  const notes: string[] = [];
  if (skipped.strokes) notes.push(`${skipped.strokes} outline${skipped.strokes > 1 ? 's' : ''} with only a stroke (no fill) ${skipped.strokes > 1 ? 'were' : 'was'} skipped – in Inkscape, Path → Stroke to Path turns strokes into shapes.`);
  if (skipped.text) notes.push('Text in the SVG was skipped – convert it to paths first (Inkscape: Path → Object to Path), or use the Text tab.');
  if (skipped.images) notes.push('Embedded pictures were skipped: only vector shapes can be printed.');
  if (doc.querySelector('style')) notes.push('Styles from <style> blocks are ignored; shapes are filled unless they say fill="none" themselves.');
  if (!shapes.length) throw new Error(`No filled shapes found in this SVG.${notes.length ? ` ${notes.join(' ')}` : ''}`);

  // Centre, scale to a height of 1 and keep within the point budget.
  const all = shapes.flatMap((s) => s.contours.flat());
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const height = y1 - y0 || x1 - x0 || 1;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let simplify = 0;
  let out = shapes;
  for (let pass = 0; pass < 12; pass++) {
    out = shapes.map((s) => ({
      rule: s.rule,
      contours: s.contours
        .map((c) => (simplify ? rdp(c, simplify * height) : c).map(([x, y]) => [round((x - cx) / height), round((y - cy) / height)] as Vec2))
        .filter((c) => c.length >= 3),
    })).filter((s) => s.contours.length);
    if (out.reduce((n, s) => n + s.contours.reduce((m, c) => m + c.length, 0), 0) <= MAX_SVG_POINTS) break;
    simplify = simplify ? simplify * 2 : 0.0005;
  }
  if (simplify) notes.push('The drawing was simplified slightly to keep the design file small.');
  const drawing = cleanDrawing({ name, aspect: (x1 - x0) / height || 1, shapes: out });
  if (!drawing) throw new Error('This SVG is too detailed to import, even simplified.');
  return { drawing, notes };
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;

function length(v: string | null, fallback: number): number {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const num = (el: Element, attr: string) => { const n = parseFloat(el.getAttribute(attr) ?? ''); return Number.isFinite(n) ? n : 0; };

/** A presentation attribute or inline style property (inline style wins), trimmed and lower-case. */
function style(el: Element, prop: string): string | undefined {
  const inline = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;!]+)`).exec(el.getAttribute('style') ?? '')?.[1];
  const v = (inline ?? el.getAttribute(prop))?.trim().toLowerCase();
  return v && v !== 'inherit' ? v : undefined;
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/** transform="translate(…) rotate(…) …" */
export function parseTransform(t: string): Matrix {
  let m = IDENTITY;
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Matrix | null = null;
    if (fn === 'matrix' && a.length === 6) n = a as Matrix;
    else if (fn === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), x = a[1] ?? 0, y = a[2] ?? 0;
      n = multiply(multiply([1, 0, 0, 1, x, y], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -x, -y]);
    } else if (fn === 'skewX') n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    if (n && n.every(Number.isFinite)) m = multiply(m, n);
  }
  return m;
}

/** The closed outlines of a shape element, in its own coordinates (null: not a shape). */
function geometry(el: Element, tol: number): Vec2[][] | null {
  switch (el.localName) {
    case 'path': return flattenPath(el.getAttribute('d') ?? '', tol);
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (!(w > 0 && h > 0)) return null;
      let rx = num(el, 'rx'), ry = num(el, 'ry');
      if (el.hasAttribute('rx') && !el.hasAttribute('ry')) ry = rx;
      if (el.hasAttribute('ry') && !el.hasAttribute('rx')) rx = ry;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!(rx > 0 && ry > 0)) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
      return flattenPath(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`, tol);
    }
    case 'circle': case 'ellipse': {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const rx = el.localName === 'circle' ? num(el, 'r') : num(el, 'rx'), ry = el.localName === 'circle' ? rx : num(el, 'ry');
      if (!(rx > 0 && ry > 0)) return null;
      const n = arcSegments(Math.max(rx, ry), 2 * Math.PI, tol);
      return [Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)] as Vec2)];
    }
    case 'polygon': case 'polyline': {
      const v = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      const pts: Vec2[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) pts.push([v[i], v[i + 1]]);
      return pts.length >= 3 ? [pts] : null;
    }
    default: return null;
  }
}

/** Segments for an arc of `sweep` radians on radius r, within `tol`. */
function arcSegments(r: number, sweep: number, tol: number): number {
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / Math.max(r, 1e-9))));
  return Math.max(8, Math.min(720, Math.ceil(Math.abs(sweep) / (step || 0.1))));
}

/** Path data → one closed outline per subpath (fill closes open subpaths). */
export function flattenPath(d: string, tol: number): Vec2[][] {
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? [];
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
  let lastCtrl: Vec2 | null = null, lastCmd = '';
  const isCmd = (t: string | undefined) => !!t && /[a-zA-Z]/.test(t);
  const n = () => Number(tokens[i++]);
  // Arc flags may be written without separators ("a5 5 0 01 10 0"): read them one digit at a time.
  const flag = () => {
    const t = tokens[i];
    if (t === undefined) return 0;
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) { tokens[i] = t.slice(1); return Number(t[0]); }
    i++;
    return Number(t);
  };
  const push = (px: number, py: number) => { if (Number.isFinite(px) && Number.isFinite(py)) cur.push([px, py]); };
  const finish = () => { if (cur.length >= 3) out.push(cur); cur = []; };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'Z') { finish(); x = sx; y = sy; lastCtrl = null; lastCmd = 'Z'; continue; }
    if (C === 'M') {
      finish();
      x = ox + n(); y = oy + n(); sx = x; sy = y; push(x, y);
      cmd = rel ? 'l' : 'L'; // further pairs are line-tos
    } else if (C === 'L') { x = ox + n(); y = oy + n(); push(x, y); }
    else if (C === 'H') { x = ox + n(); push(x, y); }
    else if (C === 'V') { y = oy + n(); push(x, y); }
    else if (C === 'C' || C === 'S') {
      let c1: Vec2;
      if (C === 'C') c1 = [ox + n(), oy + n()];
      else c1 = lastCtrl && (lastCmd === 'C' || lastCmd === 'S') ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
      const c2: Vec2 = [ox + n(), oy + n()], p: Vec2 = [ox + n(), oy + n()];
      cubic([x, y], c1, c2, p, tol, push);
      lastCtrl = c2; x = p[0]; y = p[1]; lastCmd = C;
      continue;
    } else if (C === 'Q' || C === 'T') {
      let q: Vec2;
      if (C === 'Q') q = [ox + n(), oy + n()];
      else q = lastCtrl && (lastCmd === 'Q' || lastCmd === 'T') ? [2 * x - lastCtrl[0], 2 * y - lastCtrl[1]] : [x, y];
      const p: Vec2 = [ox + n(), oy + n()];
      cubic([x, y], [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p, tol, push);
      lastCtrl = q; x = p[0]; y = p[1]; lastCmd = C;
      continue;
    } else if (C === 'A') {
      const rx = Math.abs(n()), ry = Math.abs(n()), rot = n(), large = flag(), sweep = flag();
      const p: Vec2 = [ox + n(), oy + n()];
      arc([x, y], rx, ry, rot, !!large, !!sweep, p, tol, push);
      x = p[0]; y = p[1];
    } else { i++; continue; } // unknown command: skip a number
    lastCtrl = null; lastCmd = C;
  }
  finish();
  return out;
}

function cubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number, push: (x: number, y: number) => void, depth = 0) {
  // Flat enough (control points within tol of the chord) → a straight segment.
  const dx = p3[0] - p0[0], dy = p3[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1e-12;
  const d1 = Math.abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / len;
  const d2 = Math.abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / len;
  if (depth >= 12 || Math.max(d1, d2) <= tol) { push(p3[0], p3[1]); return; }
  const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = mid(p0, p1), b = mid(p1, p2), c = mid(p2, p3), ab = mid(a, b), bc = mid(b, c), m = mid(ab, bc);
  cubic(p0, a, ab, m, tol, push, depth + 1);
  cubic(m, bc, c, p3, tol, push, depth + 1);
}

/** SVG elliptical arc (endpoint form, as in the SVG spec's implementation notes). */
function arc(p0: Vec2, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, p1: Vec2, tol: number, push: (x: number, y: number) => void) {
  if (!(rx > 0 && ry > 0) || (p0[0] === p1[0] && p0[1] === p1[1])) { push(p1[0], p1[1]); return; }
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2, cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = arcSegments(Math.max(rx, ry), dt, tol);
  for (let s = 1; s <= steps; s++) {
    const t = t1 + (dt * s) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    push(cos * ex - sin * ey + cx, sin * ex + cos * ey + cy);
  }
}

/** Ramer–Douglas–Peucker simplification of a closed outline. */
function rdp(points: Vec2[], eps: number): Vec2[] {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * (by - ay) - (points[i][1] - ay) * (bx - ax)) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > eps) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
