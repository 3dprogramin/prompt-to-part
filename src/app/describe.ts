// The design's text and SVG features in words, for Claude (the request's textNote).
import type { TextFeature } from '../../shared/textFeatures';
import type { SvgFeature } from '../../shared/svgFeatures';

export function describeSvg(features: SvgFeature[]): string | undefined {
  const on = features.filter((f) => f.enabled);
  if (!on.length) return undefined;
  return on.map((f) => `SVG drawing "${f.drawing.name}" ${f.mode === 'emboss' ? 'raised' : 'engraved'} ${f.depth} mm, ${f.size} × ${(f.size * f.drawing.aspect).toFixed(1)} mm (height × width), on the ${f.face === 'pick' ? 'picked surface' : f.face} of part "${f.part ?? 'first part'}"${f.curve === 'wrap' ? ', wrapped' : ''}`).join('; ');
}

export function describeText(features: TextFeature[]): string | undefined {
  const on = features.filter((f) => f.enabled && f.text.trim());
  if (!on.length) return undefined;
  return on.map((f) => `"${f.text.replace(/\n/g, ' / ')}" ${f.mode === 'emboss' ? 'raised' : 'engraved'} ${f.depth} mm, ${f.size} mm letters, on the ${f.face === 'pick' ? 'picked surface' : f.face} of part "${f.part ?? 'first part'}"${f.curve !== 'none' ? `, ${f.curve}` : ''}`).join('; ');
}
