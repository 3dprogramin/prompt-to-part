// Pieces both 3MF writers (plain 3MF in export.ts, Bambu project in bambu3mf.ts) share.
import type { PartMesh } from '../../shared/types';

export const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
export const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : String(+n.toFixed(5)));

const FALLBACK_COLOUR = '#C9A26B';

/** One slot per distinct part colour: `colours` lists them (#RRGGBB), `slot[i]` is part i's index into it. */
export function colourSlots(parts: PartMesh[]): { colours: string[]; slot: number[] } {
  const colours: string[] = [];
  const slot = parts.map((p) => {
    const c = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toUpperCase() : FALLBACK_COLOUR;
    let i = colours.indexOf(c);
    if (i < 0) { colours.push(c); i = colours.length - 1; }
    return i;
  });
  return { colours, slot };
}

/** The index of `colour` in `colours` (#RRGGBB), added when it is new. */
export function colourIndex(colours: string[], colour: string): number {
  const c = /^#[0-9a-f]{6}$/i.test(colour) ? colour.toUpperCase() : FALLBACK_COLOUR;
  const i = colours.indexOf(c);
  return i < 0 ? colours.push(c) - 1 : i;
}

export const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/></Types>';
