// Short texts of the chat: an attached mesh's import in one line, and text clipped to a length.
import type { MeshUpload } from '../../../shared/api';

/** The import of an attached mesh in one line (its chip's tooltip). */
export function meshSummary(u: MeshUpload) {
  const [x, y, z] = u.entry.size.map((v) => v.toFixed(0));
  return `${u.entry.original ?? u.name}: ${x} × ${y} × ${z} mm, ${u.entry.triangles.toLocaleString('en')} triangles. ${u.report.repairs.length ? `Repairs: ${u.report.repairs.join('; ')}.` : 'No repairs needed.'} A render and this report are sent with it.`;
}

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
