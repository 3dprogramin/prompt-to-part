// Printability / mesh validation, run in the geometry worker on the exact mesh being exported.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { fitProblem, PRINTER } from '../../shared/printer';
import { overlapVolume } from '../../shared/runtime';
import type { EvalResult, PartMesh, Vec3 } from '../../shared/types';

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: Severity;
  title: string;
  detail: string;
  part?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  stats: {
    parts: number;
    triangles: number;
    volume: number; // mm³
    overhangArea: number; // mm²
    overhangPct: number;
    minWall: number | null; // mm
    bedContact: number; // mm² (all parts)
  };
  /** Triangles (xyz × 3) facing down steeper than 45°, and points where walls are too thin. */
  overlay: { overhang: Float32Array; thin: Float32Array };
  timeMs: number;
}

const OVERHANG_NZ = -Math.SQRT1_2; // normal pointing down more than 45° from vertical
const MIN_WALL_WARN = 2 * PRINTER.nozzle; // two perimeters
const MIN_WALL_ERROR = PRINTER.nozzle; // one extrusion line
const BED_EPS = 0.05;

interface PartAnalysis {
  part: PartMesh;
  openEdges: number;
  nonManifoldEdges: number;
  flippedEdges: number;
  degenerate: number;
  signedVolume: number;
  area: number;
  bedContact: number;
  overhangArea: number;
  overhangTris: number[];
  pieces: { minZ: number; volume: number }[];
  minWall: number | null;
  thinArea: number;
  thinPoints: number[];
}

function analysePart(part: PartMesh, rand: () => number): PartAnalysis {
  const P = part.positions, I = part.indices;
  const nv = P.length / 3, nt = I.length / 3;
  const minZ = part.bbox.min[2];

  // --- topology: every edge must be shared by exactly two triangles in opposite directions
  const edges = new Map<number, number>(); // edge → number of triangles using it
  const balance = new Map<number, number>();
  const addEdge = (a: number, b: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * nv + hi;
    edges.set(key, (edges.get(key) ?? 0) + 1);
    balance.set(key, (balance.get(key) ?? 0) + (a < b ? 1 : -1));
  };
  // --- connected pieces (union-find over vertices)
  const parent = new Int32Array(nv).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  let degenerate = 0, signedVolume = 0, area = 0, bedContact = 0, overhangArea = 0;
  const overhangTris: number[] = [];
  const triArea = new Float64Array(nt);
  const normals = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
    unite(a, b); unite(b, c);
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const ar = len / 2;
    triArea[t] = ar;
    area += ar;
    signedVolume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    if (ar < 1e-9) { degenerate++; continue; }
    nx /= len; ny /= len; nz /= len;
    normals.set([nx, ny, nz], t * 3);
    const onBed = Math.max(az, bz, cz) - minZ < BED_EPS;
    if (onBed && nz < -0.999) bedContact += ar;
    else if (nz < OVERHANG_NZ) {
      overhangArea += ar;
      overhangTris.push(t);
    }
  }
  let openEdges = 0, nonManifoldEdges = 0, flippedEdges = 0;
  for (const [key, count] of edges) {
    if (count === 1) openEdges++;
    else if (count > 2) nonManifoldEdges++;
    else if (balance.get(key) !== 0) flippedEdges++;
  }

  // per-piece lowest point and volume
  const pieceIndex = new Map<number, number>();
  const pieces: { minZ: number; volume: number }[] = [];
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const root = find(a);
    let k = pieceIndex.get(root);
    if (k == null) { k = pieces.length; pieceIndex.set(root, k); pieces.push({ minZ: Infinity, volume: 0 }); }
    const pc = pieces[k];
    pc.minZ = Math.min(pc.minZ, P[a * 3 + 2], P[b * 3 + 2], P[c * 3 + 2]);
    pc.volume += (P[a * 3] * (P[b * 3 + 1] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3 + 1]) - P[a * 3 + 1] * (P[b * 3] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3]) + P[a * 3 + 2] * (P[b * 3] * P[c * 3 + 1] - P[b * 3 + 1] * P[c * 3])) / 6;
  }

  // --- wall thickness: shoot rays inward from sampled surface points
  let minWall: number | null = null, thinArea = 0;
  const thinPoints: number[] = [];
  if (nt > 0 && area > 0) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(P, 3));
    // MeshBVH reorders the index buffer in place – give it a copy so the part mesh and our
    // per-triangle normals stay in their original order.
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
    const bvh = new MeshBVH(geom);
    const cum = new Float64Array(nt);
    let acc = 0;
    for (let t = 0; t < nt; t++) { acc += triArea[t]; cum[t] = acc; }
    const samples = Math.min(3000, Math.max(200, nt));
    const ray = new THREE.Ray();
    let thinSamples = 0;
    for (let s = 0; s < samples; s++) {
      const r = rand() * acc;
      let lo = 0, hi = nt - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const t = lo;
      if (triArea[t] < 1e-9) continue;
      // a point well inside the triangle (avoids grazing hits at sharp edges)
      let u = 0.2 + rand() * 0.6, v = 0.2 + rand() * 0.6;
      if (u + v > 0.9) { u *= 0.5; v *= 0.5; }
      const w = 1 - u - v;
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      const px = P[a * 3] * w + P[b * 3] * u + P[c * 3] * v;
      const py = P[a * 3 + 1] * w + P[b * 3 + 1] * u + P[c * 3 + 1] * v;
      const pz = P[a * 3 + 2] * w + P[b * 3 + 2] * u + P[c * 3 + 2] * v;
      const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
      ray.origin.set(px - nx * 1e-3, py - ny * 1e-3, pz - nz * 1e-3);
      ray.direction.set(-nx, -ny, -nz);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!hit || !hit.face) continue;
      // A wall has two roughly opposite faces. Hitting a face at a shallow angle means a wedge
      // edge (e.g. a fillet meeting a flat face), which is not a thin wall.
      if (hit.face.normal.x * nx + hit.face.normal.y * ny + hit.face.normal.z * nz > -0.5) continue;
      const d = hit.distance + 1e-3;
      if (minWall == null || d < minWall) minWall = d;
      if (d < MIN_WALL_WARN) { thinSamples++; thinPoints.push(px, py, pz); }
    }
    thinArea = (thinSamples / samples) * area;
    bvh.geometry.dispose();
  }

  return { part, openEdges, nonManifoldEdges, flippedEdges, degenerate, signedVolume, area, bedContact, overhangArea, overhangTris, pieces, minWall, thinArea, thinPoints };
}

function boundsOf(parts: PartMesh[]): EvalResult['bbox'] {
  if (!parts.length) return null;
  const min = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.bbox.min[k]))) as Vec3;
  const max = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.bbox.max[k]))) as Vec3;
  return { min, max };
}

/** Deterministic RNG so the same mesh always gives the same report. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (n: number) => n.toFixed(1);

export interface ValidateOptions {
  layoutValue?: string;
  /** Check only these parts (the ones being exported); default: all. */
  parts?: string[];
  /** Parts that will print with supports / an explicit brim (from the print settings). */
  supportParts?: string[];
  brimParts?: string[];
}

export function validateResult(all: EvalResult, opts: ValidateOptions = {}): ValidationReport {
  const t0 = performance.now();
  // Parts left out of the export (hidden, or another part exported alone) are not checked: the
  // size and overlap checks are about what is actually printed.
  const keep = opts.parts ? all.parts.filter((p) => opts.parts!.includes(p.name)) : all.parts;
  const result = { ...all, parts: keep, bbox: boundsOf(keep) };
  const issues: ValidationIssue[] = [];
  const add = (severity: Severity, title: string, detail: string, part?: string) => issues.push({ severity, title, detail, part });
  const rand = mulberry32(12345);
  const forPrinting = !opts.layoutValue || opts.layoutValue === 'print';

  if (!result.parts.length) {
    add('error', 'Nothing to print', 'The model has no geometry.');
  }
  if (!forPrinting) {
    add('warning', `Exporting the "${opts.layoutValue}" layout`, 'This layout shows the parts for display – they may float or overlap. Switch Layout to "print" before printing.');
  }

  const fit = fitProblem(result.bbox);
  if (fit) add('error', `Too big for the ${PRINTER.name}`, fit);

  const analyses = result.parts.map((p) => analysePart(p, rand));
  let overhangArea = 0, area = 0, bedContact = 0, volume = 0;
  let minWall: number | null = null;
  const overhangOverlay: number[] = [];
  const thinOverlay: number[] = [];

  for (const a of analyses) {
    const name = a.part.name;
    const label = result.parts.length > 1 ? `"${name}": ` : '';
    area += a.area; overhangArea += a.overhangArea; bedContact += a.bedContact; volume += Math.abs(a.signedVolume);
    if (a.minWall != null) minWall = minWall == null ? a.minWall : Math.min(minWall, a.minWall);

    // A sealed cavity (hollow float, closed magnet pocket) is a surface with negative volume: it
    // is inside another piece, not a separate one.
    const solids = a.pieces.filter((p) => p.volume > 0);

    // mesh integrity
    if (a.openEdges) add('error', `${label}Mesh has holes`, `${a.openEdges} open edges – the surface is not closed, slicers may fill it wrongly.`, name);
    if (a.nonManifoldEdges) add('error', `${label}Non-manifold edges`, `${a.nonManifoldEdges} edges are shared by more than two faces.`, name);
    if (a.flippedEdges) add('error', `${label}Flipped faces`, `${a.flippedEdges} edges join faces with inconsistent orientation.`, name);
    if (a.signedVolume < 0) add('error', `${label}Inside-out mesh`, 'The surface normals point inwards.', name);
    if (a.degenerate) add('info', `${label}Degenerate triangles`, `${a.degenerate} zero-area triangles (harmless, slicers remove them).`, name);

    if (forPrinting) {
      const minZ = a.part.bbox.min[2];
      if (minZ > BED_EPS) add('error', `${label}Floating above the plate`, `The part starts ${f1(minZ)} mm above the build plate.`, name);
      else if (a.bedContact < 1e-3) add('error', `${label}No flat face on the plate`, 'Nothing touches the build plate flat – it will not stick without supports or a raft.', name);
      else {
        const b = a.part.bbox;
        const w = b.max[0] - b.min[0], d = b.max[1] - b.min[1], h = b.max[2] - b.min[2];
        const brim = opts.brimParts?.includes(name);
        if (a.bedContact < 25 && Math.abs(a.signedVolume) > 1000) {
          if (brim) add('info', `${label}Small contact with the plate`, `Only ${f1(a.bedContact)} mm² touches the plate – covered by the brim in the print settings.`, name);
          else add('warning', `${label}Small contact with the plate`, `Only ${f1(a.bedContact)} mm² touches the plate – use a brim so it does not detach.`, name);
        }
        if (h > 40 && h / Math.max(1e-6, Math.min(w, d)) > 3.5) {
          if (brim) add('info', `${label}Tall and narrow`, `${f1(h)} mm tall on a ${f1(Math.min(w, d))} mm base – the brim in the print settings helps keep it steady.`, name);
          else add('warning', `${label}Tall and narrow`, `${f1(h)} mm tall on a ${f1(Math.min(w, d))} mm base – the ${PRINTER.name}'s moving bed can make it wobble. Use a brim, slow down, or print it lying down.`, name);
        }
      }
      const floating = solids.filter((p) => p.minZ > minZ + BED_EPS);
      if (floating.length) add('error', `${label}Pieces in mid-air`, `${floating.length} separate piece${floating.length > 1 ? 's start' : ' starts'} above the plate with nothing under ${floating.length > 1 ? 'them' : 'it'} (lowest at ${f1(Math.min(...floating.map((p) => p.minZ)))} mm).`, name);
    }
    if (solids.length > 1) add('info', `${label}${solids.length} separate pieces`, 'This part is made of pieces that do not touch – each prints as its own object.', name);
    const tiny = solids.filter((p) => p.volume < 2);
    if (tiny.length) add('warning', `${label}Tiny pieces`, `${tiny.length} piece${tiny.length > 1 ? 's are' : ' is'} smaller than 2 mm³ and may not print.`, name);

    // overhangs
    const pct = a.area ? (a.overhangArea / a.area) * 100 : 0;
    if (a.overhangArea > 20 && pct > 0.5) {
      if (opts.supportParts?.includes(name)) add('info', `${label}Overhangs – supports enabled`, `${f1(a.overhangArea)} mm² (${f1(pct)} % of the surface) faces down steeper than 45°; the print settings turn supports on.`, name);
      else add('warning', `${label}Overhangs need supports`, `${f1(a.overhangArea)} mm² (${f1(pct)} % of the surface) faces down steeper than 45°. Enable supports or reorient.`, name);
    }
    else if (a.overhangArea > 1) add('info', `${label}Small overhangs`, `${f1(a.overhangArea)} mm² faces down steeper than 45° – usually prints fine as bridges.`, name);

    // thin walls
    if (a.minWall != null && a.minWall < MIN_WALL_ERROR && a.thinArea > 0.5) {
      add('error', `${label}Walls too thin to print`, `Thinnest wall ≈ ${a.minWall.toFixed(2)} mm (a ${PRINTER.nozzle} mm nozzle cannot print below ~${MIN_WALL_ERROR} mm). About ${f1(a.thinArea)} mm² is affected.`, name);
    } else if (a.minWall != null && a.minWall < MIN_WALL_WARN && a.thinArea > 1) {
      add('warning', `${label}Thin walls`, `Thinnest wall ≈ ${a.minWall.toFixed(2)} mm – thinner than two perimeters (${MIN_WALL_WARN} mm), so it will be weak. About ${f1(a.thinArea)} mm² is affected.`, name);
    }

    for (const t of a.overhangTris) {
      for (const k of [0, 1, 2]) { const v = a.part.indices[t * 3 + k]; overhangOverlay.push(a.part.positions[v * 3], a.part.positions[v * 3 + 1], a.part.positions[v * 3 + 2]); }
    }
    thinOverlay.push(...a.thinPoints);
  }

  // parts overlapping each other on the plate
  if (forPrinting) {
    for (let i = 0; i < result.parts.length; i++) {
      for (let j = i + 1; j < result.parts.length; j++) {
        const A = result.parts[i].bbox, B = result.parts[j].bbox;
        if (![0, 1, 2].every((k) => A.min[k] < B.max[k] && A.max[k] > B.min[k])) continue;
        const v = overlapVolume(result.parts[i], result.parts[j]);
        if (v > 0.5) add('warning', `"${result.parts[i].name}" and "${result.parts[j].name}" overlap`, `They intersect by ${f1(v)} mm³ – the slicer will merge them into one object.`);
      }
    }
  }

  const triangles = result.parts.reduce((s, p) => s + p.triCount, 0);
  if (triangles > 2_000_000) add('info', 'Very detailed mesh', `${triangles.toLocaleString()} triangles – slicing may be slow.`);

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    issues,
    stats: { parts: result.parts.length, triangles, volume, overhangArea, overhangPct: area ? (overhangArea / area) * 100 : 0, minWall, bedContact },
    overlay: { overhang: new Float32Array(overhangOverlay), thin: new Float32Array(thinOverlay) },
    timeMs: performance.now() - t0,
  };
}
