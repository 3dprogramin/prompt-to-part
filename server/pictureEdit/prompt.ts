// The image model's prompt for a picture edit: the mode's own rules (artwork: the design's filament
// colours and flat areas, as artworkPrompt asks for them) around "change only this", with what each
// attached picture is.
import type { PictureMode } from '../../shared/api';

/**
 * The prompt for changing part of a picture. `masked`: the attached pictures are the crop to edit,
 * the same crop with the area outlined in magenta and the whole picture; otherwise the whole picture
 * alone. `photos` of the real subject come after them. `colours`: the drawing's own (artwork).
 */
export function pictureEditPrompt(r: { mode: PictureMode; change: string; masked: boolean; colours?: string[]; photos: number }): string {
  if (r.mode !== 'artwork') throw new Error(`Picture edits for ${r.mode} are not written yet`);
  const colours = r.colours ?? [];
  const where = r.masked ? ' inside the outlined area' : '';
  const photos = r.photos === 1 ? 'The attached photo shows' : `The ${r.photos} attached photos show`;
  return [
    r.masked
      ? 'Edit the first attached picture: it is part of flat-colour artwork for a multi-colour 3D print (a wall relief, sign or plaque), where every colour is printed as its own flat layer of filament. The second attached picture is the same part with the area to change outlined in magenta; the third is the whole artwork, for context only.'
      : 'Edit the attached picture: it is flat-colour artwork for a multi-colour 3D print (a wall relief, sign or plaque), where every colour is printed as its own flat layer of filament.',
    `Change only this${where}: ${r.change.trim()}`,
    r.photos ? `${photos} the real person or subject for the part you change: keep their likeness.` : '',
    r.masked
      ? 'Keep everything else exactly as it is: the same picture size and framing, and every shape, edge and colour outside the outlined area where it is; copy them, don\'t redraw them. Answer with the first picture changed, without the magenta outline.'
      : 'Keep everything else exactly as it is: the same picture size and framing, the same subjects in the same places and poses, and every shape, edge and colour you are not asked to change; copy them, don\'t redraw them.',
    `Colours: only these ${colours.length} flat colours, the design's filaments, and no others: ${colours.join(', ')}.`,
    'Rules for what you change:',
    '- the same style as the rest of the picture: flat colour areas with hard, clean edges; no gradients, soft shading, textures, noise, halftone dots or hatching',
    '- every colour area large enough to print with a 0.4 mm nozzle: no specks, no hair-thin strands or lines',
    '- no text, signature or watermark',
  ].filter(Boolean).join('\n');
}
