// The image model's prompt for a picture edit: the mode's own rules (artwork: the design's filament
// colours and flat areas, as artworkPrompt asks for them; LayerTone: a realistic photo in grey
// tones; line art: lineArtEditPrompt's) around "change only this", with what each attached picture is.
import type { PictureMode } from '../../shared/api';
import type { LineArtStyle } from '../../shared/lineart';
import { LINE_ART_EDIT_RULES, LINE_ART_WIDTH, lineArtEditPrompt } from '../artwork';

/**
 * The prompt for changing part of a picture. `masked`: the attached pictures are the crop to edit,
 * the same crop with the area outlined in magenta and the whole picture; otherwise the whole picture
 * alone. `photos` of the real subject come after them. `colours`: the drawing's own (artwork).
 * `padded`: white bands were added to the picture to give it the aspect asked for.
 */
export function pictureEditPrompt(r: { mode: PictureMode; change: string; masked: boolean; colours?: string[]; photos: number; padded?: boolean; style?: LineArtStyle; width?: number }): string {
  if (r.mode === 'layertone' || r.mode === 'lithophane') return photoPrompt(r, r.mode === 'lithophane');
  if (r.mode === 'lineart') return lineArtPrompt(r);
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
    r.padded ? `The plain white bands along two opposite edges of the ${r.masked ? 'first two pictures' : 'picture'} are only padding: leave them plain white, with nothing drawn in them.` : '',
    `Colours: only these ${colours.length} flat colours, the design's filaments, and no others: ${colours.join(', ')}.`,
    'Rules for what you change:',
    '- the same style as the rest of the picture: flat colour areas with hard, clean edges; no gradients, soft shading, textures, noise, halftone dots or hatching',
    '- every colour area large enough to print with a 0.4 mm nozzle: no specks, no hair-thin strands or lines',
    '- no text, signature or watermark',
  ].filter(Boolean).join('\n');
}

/**
 * The prompt for changing part of a LayerTone photo: a greyscale photo printed as a LayerTone
 * filament painting (its brightness becomes the print's height), so the change is a realistic
 * photo edit in grey tones that blends in. The attached pictures as for artwork.
 */
function photoPrompt(r: { change: string; masked: boolean; photos: number; padded?: boolean }, lithophane = false): string {
  // What the print does with the picture, and what the change must keep for it.
  const print = lithophane
    ? 'a lithophane, a panel in white PLA that is thicker where the photo is dark and thinner where it is bright, so it shows the photo when lit from behind'
    : 'a LayerTone filament painting, where the brightness of every point becomes the print\'s height';
  const tones = lithophane
    ? 'so only its grey tones show: a full range of tones from deep shadow to bright highlight, with no flat or washed-out areas'
    : 'so only its grey tones print';
  const where = r.masked ? ' inside the outlined area' : '';
  const photos = r.photos === 1 ? 'The attached photo shows' : `The ${r.photos} attached photos show`;
  return [
    r.masked
      ? `Edit the first attached picture: it is part of a black-and-white photo that is 3D printed as ${print}, ${tones}. The second attached picture is the same part with the area to change outlined in magenta; the third is the whole photo, for context only.`
      : `Edit the attached picture: it is a black-and-white photo that is 3D printed as ${print}, ${tones}.`,
    `Change only this${where}: ${r.change.trim()}`,
    r.photos ? `${photos} the real person or subject for the part you change: keep their likeness.` : '',
    r.masked
      ? 'Keep everything else exactly as it is: the same picture size and framing, and every person, object, edge and tone outside the outlined area where it is; copy them, don\'t redraw them. Answer with the first picture changed, without the magenta outline.'
      : 'Keep everything else exactly as it is: the same picture size and framing, the same people and things in the same places and poses, and every tone you are not asked to change; copy them, don\'t redraw them.',
    r.padded ? `The plain white bands along two opposite edges of the ${r.masked ? 'first two pictures' : 'picture'} are only padding: leave them plain white, with nothing drawn in them.` : '',
    'Rules for what you change:',
    '- a realistic photo, like the rest of the picture: the same light, focus, grain, brightness and contrast, so that it blends in with no visible seam',
    lithophane ? '- a full tonal range in the change too (real shadows and highlights, not flat grey): the lit panel shows the tones' : '',
    '- in grey tones only, as the rest of the picture (the print has no colour)',
    '- no outline, border or frame around the change, and no text, signature or watermark',
  ].filter(Boolean).join('\n');
}

/**
 * The prompt for changing a line-art drawing (`style`: the piece it is drawn for; `width`: the
 * piece's width, mm). The whole drawing: lineArtEditPrompt, as generate_line_art's edit sends it.
 * Marked: the same print rules, the change inside the outlined area only, and the lines that cross
 * the area's edge carried on where they were, so the drawing stays one piece.
 */
function lineArtPrompt(r: { change: string; masked: boolean; photos: number; padded?: boolean; style?: LineArtStyle; width?: number }): string {
  const style = r.style ?? 'outline';
  if (!r.masked) return lineArtEditPrompt({ change: r.change, references: Array.from({ length: r.photos }, () => ''), width: r.width, style });
  const photos = r.photos === 1 ? 'The attached photo shows' : `The ${r.photos} attached photos show`;
  return [
    `Edit the first attached picture: it is part of black line art for a one-piece wall cut-out, about ${Math.round(r.width ?? LINE_ART_WIDTH[style])} mm wide, 3D-printed in black. The second attached picture is the same part with the area to change outlined in magenta; the third is the whole drawing, for context only.`,
    `Change only this inside the outlined area: ${r.change.trim()}`,
    r.photos ? `${photos} the real subject: use ${r.photos === 1 ? 'it' : 'them'} for the part you change.` : '',
    'Keep everything else exactly as it is: the same picture size and framing, and every line outside the outlined area where it is, at the same weight; copy them, don\'t redraw them. Answer with the first picture changed, without the magenta outline.',
    r.padded ? 'The plain white bands along two opposite edges of the first two pictures are only padding: leave them plain white, with nothing drawn in them.' : '',
    ...LINE_ART_EDIT_RULES,
    '- every line that crosses the edge of the outlined area carries on across it where it was, at the same weight',
  ].filter(Boolean).join('\n');
}
