// The design's text, SVG and QR code features in words, for Claude (the request's textNote).
import type { TextFeature } from '../../shared/textFeatures';
import type { SvgFeature } from '../../shared/svgFeatures';
import { qrPayload, type QrFeature } from '../../shared/qrFeatures';

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

/** The QR codes: what each holds (a Wi-Fi network by name only, never its password), size and place. */
export function describeQr(features: QrFeature[]): string | undefined {
  const on = features.filter((f) => f.enabled && qrPayload(f));
  if (!on.length) return undefined;
  return on.map((f) => {
    const what = f.kind === 'wifi' ? `Wi-Fi network "${f.wifi.ssid}"` : `${/^https?:\/\//i.test(f.text.trim()) ? 'link' : 'text'} "${f.text.trim().replace(/\n/g, ' / ').slice(0, 200)}"`;
    return `QR code "${f.name}" (${what}), ${f.size} × ${f.size} mm${f.tile ? ` on a white ${f.tileHeight} mm tile` : ''}, modules ${f.style} ${f.depth} mm, on the ${f.face === 'pick' ? 'picked surface' : f.face} of part "${f.part ?? 'first part'}"${f.curve === 'wrap' ? ', wrapped' : ''}`;
  }).join('; ');
}
