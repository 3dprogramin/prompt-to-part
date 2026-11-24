import { bambuProjectSupported } from '../../shared/printer';
import { buildProject } from './projects';
import type { Box3, DimensionAnnotation, EvalResult, PartMesh, Vec3 } from '../../shared/types';
import { toBinaryStl } from './files';
import type { PrintProfile } from '../../shared/print';
import type { BambuTemplate, BlendRequest } from '../../shared/api';
import { api, request } from './api';
import { boxDimensions } from './dimensions';
import { isFlat, toGlb, type GlbOptions } from './glb';

export type ExportFormat = 'stl' | '3mf' | 'blend' | 'glb';


export { to3mf } from './threeMf';

const b64 = (arr: Float32Array | Uint32Array) => {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

function boundsOf(parts: PartMesh[]): Box3 {
  const min = [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.bbox.min[k]))) as Vec3;
  const max = [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.bbox.max[k]))) as Vec3;
  return { min, max };
}

/** .blend via the server's headless Blender: one object per part + a Dimensions collection. */
export async function toBlend(result: EvalResult, parts: PartMesh[], title: string, code: string): Promise<Blob> {
  const b = boundsOf(parts);
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const dims: NonNullable<BlendRequest['dimensions']> = [
    ...boxDimensions(b, size).map(({ label, from, to, offset, color }) => ({ label, from, to, offset, color })),
    ...result.dimensions.map((d: DimensionAnnotation) => ({
      label: `${d.label ? d.label + ': ' : ''}${Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]).toFixed(2)} mm`,
      from: d.from, to: d.to, offset: d.offset,
    })),
  ];
  const params = Object.fromEntries(Object.entries(result.values).filter(([k]) => !k.startsWith('$')));
  const body: BlendRequest = {
    name: title, code, params, size,
    parts: parts.map((p) => ({ name: p.name, color: p.color, positions: b64(p.positions), indices: b64(p.indices) })),
    dimensions: dims,
  };
  return (await request('/api/export/blend', { method: 'POST', body: JSON.stringify(body) })).blob();
}

export interface ThreeMfOptions {
  /** Everything in this one filament colour (#RRGGBB, "Print in one colour"); null = one filament per colour (AMS). */
  oneColour: string | null;
  /** Print settings to embed (Bambu project format); null = plain 3MF. */
  print: { ai: PrintProfile; user: PrintProfile } | null;
  /** Gets the Bambu template the project was built on (it may have just been built). */
  onTemplate?: (tpl: BambuTemplate) => void;
  /** GLB only: upright or lying; unset = upright when the model is flat. */
  glb?: GlbOptions;
}

export async function exportParts(format: ExportFormat, result: EvalResult, parts: PartMesh[], title: string, code: string, threeMf: ThreeMfOptions = { oneColour: null, print: null }): Promise<Blob> {
  if (format === '3mf') {
    // A LayerTone print's filament changes and layer heights only exist in a Bambu project: without
    // print settings it still gets one with the script's (when Bambu Studio is there to build it).
    // So does a coloured mesh's painting (Bambu Studio's paint_color). In one colour there are neither.
    const layerTone = !threeMf.oneColour && parts.some((p) => p.layerColors?.length || p.paint);
    // A printer with no Bambu project yet (two nozzles): a plain 3MF, without print settings.
    const print = bambuProjectSupported() ? threeMf.print : null;
    if (!print && !layerTone) return buildProject({ kind: '3mf', parts, title, oneColour: threeMf.oneColour });
    const tpl = print ? await api.bambuTemplate() : await api.bambuTemplate().catch(() => null);
    if (!tpl) return buildProject({ kind: '3mf', parts, title, oneColour: threeMf.oneColour });
    threeMf.onTemplate?.(tpl);
    return buildProject({ kind: 'bambu', parts, title, tpl, opts: { oneColour: threeMf.oneColour, print: print ?? { ai: result.print, user: {} } } });
  }
  if (format === 'blend') return toBlend(result, parts, title, code);
  if (format === 'glb') return toGlb(parts, title, threeMf.glb ?? { upright: isFlat(parts) });
  return toBinaryStl(parts, title);
}
