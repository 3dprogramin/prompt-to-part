// AI artwork mode (generate_artwork, traced for H.svg; edit_picture): its system prompt section and its notes.
import { loadsAtOnce, printer } from '../../shared/printer';
import type { PromptMode } from './types';
import type { GenerateRequest } from '../../shared/api';
import type { ParamValues } from '../../shared/types';
import { drawingFingerprint } from '../../shared/lineart/strokes';
import { parsePictureMarks, PICTURE_MARKS_KEY } from '../../shared/pictureEdit/mark';
import type { SvgDrawing } from '../../shared/svgFeatures';

/** The artwork section, for the chosen printer's filament count. */
const artworkOn = () => `# AI artwork mode
AI artwork mode is ON (generate_artwork): the user chose it, so the design is artwork – its picture drawn by the image model, whatever the subject (people, animals, scenes, but also objects, vehicles, weapons, tools: all drawn as illustrations), never modelled with primitives (it looks childish). Call generate_artwork first, then build the design around the returned drawing with H.svg.
- Typical use: wall art, reliefs, plaques, signs, coasters, lids. Make it look like quality artwork: a backing plate or frame, the colours as layers at different heights (e.g. 0.6–1 mm steps), every colour its own part (multi-colour single print, ${printer().filaments > 1 ? `at most ${printer().filaments} colours: ${loadsAtOnce()}` : 'one colour unless the user asks for more: the printer has no AMS, so every extra colour is a manual filament swap'}, counting the plate).
- Pick the colours: the user's filament colours if they said, else 3–4 that print well together (e.g. black, a mid grey, white, plus one accent), or shades of grey for a classic look.
- Describe the subject precisely (who/what, pose, expression, framing, the mood); the print rules (flat colours, no background) are added for you. Leave style empty: the default is realistic artwork (true proportions, faces, light and shadow, posterized like a screen print), which is what users want; set a style only when the user asks for one (cartoon, minimal…). Describe real people by their look rather than by name (image models often refuse names). Use the user's attached photos (use_attached_photos) when the artwork should look like them.
- To change part of a picture already in the design (swap a person or a face, change an object, fix a detail), call edit_picture: it changes only that region and keeps the drawing's name, so keep the script unchanged, check with render_model and submit. Never call generate_artwork for it (it redraws the whole scene) and never cut or patch the drawing's shapes in the script. Region: the user's saved mark ("mark") when there is one, else a box picked on show_picture's grid; none redraws the whole picture. When the change needs a colour the design has no filament for (e.g. darker skin, a brown coat), tell the user before editing: it prints in the nearest filament colour.
- The piece around the picture – backing plate, frame, mounting holes, lettering – is built with primitives and H.text as usual; an attached SVG the user wants used replaces generate_artwork.`;

/**
 * For edit_picture: which drawings have a saved mark (made on the drawing as it is now), and the
 * picture edits the user kept in the brush editor since Claude's last version.
 */
function pictureEditNotes(drawings: Record<string, SvgDrawing>, values: ParamValues, kept: GenerateRequest['pictureEdits']): string[] {
  const names = Object.keys(drawings);
  if (!names.length) return [];
  const marks = parsePictureMarks(values[PICTURE_MARKS_KEY]);
  const marked = names.filter((n) => Object.hasOwn(marks, n) && marks[n].fp === drawingFingerprint(drawings[n]));
  const out = [`To change part of a drawing, use edit_picture (not generate_artwork). ${marked.length
    ? `The user saved a mark (an area selected in the brush editor) on ${marked.map((n) => `"${n}"`).join(', ')}: region "mark" uses it${marked.length < names.length ? `; ${names.filter((n) => !marked.includes(n)).map((n) => `"${n}"`).join(', ')} ${names.length - marked.length > 1 ? 'have' : 'has'} none` : ''}.`
    : 'No drawing has a saved mark: pick a box with show_picture, or ask the user to select the area in the brush editor.'}`];
  const edits = (Array.isArray(kept) ? kept : []).filter((e) => e && typeof e.picture === 'string' && typeof e.change === 'string' && Number.isInteger(e.version)).slice(-12);
  if (edits.length) {
    out.push(`Picture edits the user kept in the brush editor since your last version (the drawings in this design already have them): ${edits.map((e) => `v${e.version} "${e.picture.slice(0, 120)}": "${e.change.slice(0, 300)}" (${e.masked ? 'a marked area' : 'the whole picture'})`).join('; ')}.`);
  }
  return out;
}

export const artwork: PromptMode = {
  id: 'artwork',
  picture: true,
  active: (m) => m.artwork,
  system: (o) => (o.artwork ? artworkOn() : ''),
  turnNotes: ({ drawings, pictureValues, req }) => {
    // The user chose AI artwork for this design: the picture comes first, whatever the subject.
    const names = Object.keys(drawings);
    return [`AI artwork mode is on: the user wants this as artwork – a flat multi-colour wall piece, relief, plaque or sign whose picture the image model draws, not a 3D model of the subject. ${names.length
      ? `Drawings in this design: ${names.map((n) => `"${n}"`).join(', ')}; keep using them unless the user asks for a new or different picture (then call generate_artwork again).`
      : 'There is no artwork yet: start with generate_artwork – for any subject, objects and machines included (a tommy gun, a car, a guitar are drawn as illustrations too) – then build the piece around it with H.svg.'} Model the subject in 3D geometry only if the user's message explicitly asks for a 3D object.`,
    ...pictureEditNotes(drawings, pictureValues, req.pictureEdits)];
  },
};
