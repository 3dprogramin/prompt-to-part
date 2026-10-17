// OpenSCAD files attached in the chat: Claude gets their source, their Customizer parameters and
// pictures of what OpenSCAD makes of them (server/openscad.ts), and rebuilds them as a Jig script.
import type { Box3, PartMesh, ParamValues, Vec3 } from './types';
import { cross, sub } from './vec3';

export interface ScadFile { name: string; source: string }

/** At most this many .scad files per message, each at most this long. */
export const MAX_SCAD_FILES = 4;
export const MAX_SCAD_CHARS = 300_000;

/** A file name safe to save in the design's workspace (always ending in .scad). */
export function scadFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop()!.replace(/\.scad$/i, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 80);
  return `${base || 'model'}.scad`;
}

/** Checked .scad attachments from a request (null: not valid). */
export function parseScadFiles(raw: unknown): ScadFile[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SCAD_FILES) return null;
  const out: ScadFile[] = [];
  for (const f of raw as ScadFile[]) {
    if (!f || typeof f.name !== 'string' || typeof f.source !== 'string' || f.source.length > MAX_SCAD_CHARS) return null;
    out.push({ name: scadFileName(f.name), source: f.source });
  }
  return out;
}

/** One Customizer parameter, as `openscad --export-format=param` describes it. */
export interface ScadParam {
  name: string;
  type: 'number' | 'boolean' | 'string';
  initial: number | boolean | string | number[];
  caption?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { name: string; value: number | string }[];
}

/** `-D name=value` options for the given values (names checked, strings quoted). */
export function scadDefines(values: ParamValues | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(values ?? {})) {
    if (!/^[A-Za-z_$][\w$]*$/.test(k)) continue;
    let expr: string | null = null;
    if (typeof v === 'number' && Number.isFinite(v)) expr = String(v);
    else if (typeof v === 'boolean') expr = String(v);
    else if (typeof v === 'string') expr = JSON.stringify(v);
    if (expr != null) out.push('-D', `${k}=${expr}`);
  }
  return out;
}

/** The parameters as a short list for Claude. */
export function describeScadParams(params: ScadParam[]): string {
  if (!params.length) return 'none (no Customizer parameters)';
  return params.map((p) => {
    const range = p.options?.length ? ` options ${p.options.map((o) => JSON.stringify(o.value)).join('|')}`
      : p.min != null || p.max != null ? ` range ${p.min ?? ''}..${p.max ?? ''}${p.step != null ? ` step ${p.step}` : ''}` : '';
    return `  - ${p.name} (${p.type}${p.group ? `, group "${p.group}"` : ''}) = ${JSON.stringify(p.initial)}${range}${p.caption ? ` – ${p.caption}` : ''}`;
  }).join('\n');
}

/**
 * OpenSCAD's OFF output as parts, one per colour (`color()` in the script), so a multi-colour
 * model shows as the parts it would be printed in. Faces are triangulated as fans.
 */
export function parseOff(text: string): PartMesh[] {
  const lines = text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  let at = 0;
  let head = lines[at++] ?? '';
  if (!/^C?OFF/.test(head)) throw new Error('not an OFF file');
  head = head.replace(/^C?OFF/, '').trim() || lines[at++] || '';
  const [nv, nf] = head.split(/\s+/).map(Number);
  if (!(nv >= 0 && nf >= 0) || at + nv + nf > lines.length) throw new Error('truncated OFF file');
  const verts: Vec3[] = [];
  for (let i = 0; i < nv; i++) {
    const p = lines[at++].split(/\s+/).map(Number);
    verts.push([p[0], p[1], p[2]]);
  }
  const groups = new Map<string, number[]>();
  for (let i = 0; i < nf; i++) {
    const tokens = lines[at++].split(/\s+/);
    const p = tokens.map(Number);
    const n = p[0];
    const color = faceColor(tokens.slice(1 + n, 4 + n));
    const tris = groups.get(color) ?? [];
    for (let k = 2; k < n; k++) tris.push(p[1], p[k], p[k + 1]);
    groups.set(color, tris);
  }
  const parts: PartMesh[] = [];
  for (const [color, tris] of groups) {
    // Each part gets only its own vertices.
    const map = new Map<number, number>();
    const positions: number[] = [];
    const indices = new Uint32Array(tris.length);
    tris.forEach((v, i) => {
      let j = map.get(v);
      if (j == null) { j = map.size; map.set(v, j); positions.push(...verts[v]); }
      indices[i] = j;
    });
    const pos = new Float32Array(positions);
    const { volume, area } = measure(pos, indices);
    parts.push({ name: '', color, positions: pos, indices, bbox: bboxOf(pos), volume, surfaceArea: area, triCount: indices.length / 3, genus: 0, components: 1 });
  }
  parts.sort((a, b) => b.volume - a.volume);
  parts.forEach((p, i) => { p.name = parts.length === 1 ? 'Model' : `Part ${i + 1} (${p.color})`; });
  return parts;
}

/** Face colour as #rrggbb; OpenSCAD writes 0–255 integers (or 0–1 decimals); none means its default. */
function faceColor(tokens: string[]): string {
  const c = tokens.map(Number);
  if (c.length < 3 || c.some((x) => !Number.isFinite(x))) return '#f9d72c';
  const unit = tokens.some((t) => t.includes('.'));
  return '#' + c.slice(0, 3).map((x) => Math.round(Math.min(255, Math.max(0, unit ? x * 255 : x))).toString(16).padStart(2, '0')).join('');
}

function bboxOf(p: Float32Array): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
  return p.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

function measure(p: Float32Array, idx: Uint32Array) {
  let volume = 0, area = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a: Vec3 = [p[idx[i] * 3], p[idx[i] * 3 + 1], p[idx[i] * 3 + 2]];
    const b: Vec3 = [p[idx[i + 1] * 3], p[idx[i + 1] * 3 + 1], p[idx[i + 1] * 3 + 2]];
    const c: Vec3 = [p[idx[i + 2] * 3], p[idx[i + 2] * 3 + 1], p[idx[i + 2] * 3 + 2]];
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const n = cross(sub(b, a), sub(c, a));
    area += Math.hypot(n[0], n[1], n[2]) / 2;
  }
  return { volume: Math.abs(volume), area };
}
