// LayerTone mode (H.layertone): its system prompt section, with the filament library to pick from,
// and its notes on the user's setup and pictures (and on edit_picture, with the image model).
import { loadsAtOnce, maxPiece, printer } from '../../shared/printer';
import { FILAMENT_LIBRARY } from '../../shared/filaments';
import { LAYERTONE_KEY, parseLayerToneSetup, stackSwapsAt, type LayerToneFilament, type LayerToneImage } from '../../shared/layertone';
import type { ParamValues } from '../../shared/types';
import { photoFingerprint } from '../../shared/pictureEdit/photo';
import { pictureEditNotes, type PictureWords } from './pictureEdits';
import type { PromptMode } from './types';

/** The filament library, one line per brand and line, for Claude to pick LayerTone filaments from. */
const FILAMENT_LINES = (() => {
  const groups = new Map<string, string[]>();
  for (const f of FILAMENT_LIBRARY) {
    const key = `${f.brand} ${f.line ?? ''}`.trim();
    const colour = f.line && f.name.startsWith(f.line) ? f.name.slice(f.line.length).trim() : f.name;
    groups.set(key, [...(groups.get(key) ?? []), `${colour} ${f.color} ${f.td}${f.unverified ? '*' : ''}`]);
  }
  return [...groups].map(([k, v]) => `  ${k}: ${v.join(', ')}`).join('\n');
})();

/** The user's own filaments (saved in the LayerTone panel), one per line. */
export const myFilamentLines = (mine: LayerToneFilament[]) => mine.map((f) => `  ${f.name}${f.brand ? ` (${f.brand})` : ''} ${f.color} ${f.td}`).join('\n');

/** The same list without the TD, for sections where the TD doesn't matter. */
export const myFilamentNames = (mine: LayerToneFilament[]) => mine.map((f) => `  ${f.name}${f.brand ? ` (${f.brand})` : ''} ${f.color}`).join('\n');

function layerTonePrompt(pictures: boolean, mine: LayerToneFilament[] = []) {
  const loads = printer().filaments;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  // With the image model the picture is drawn for a fixed height, so the example has no Max height slider.
  const exampleParams = pictures
    ? `const params = { width: { label: 'Picture width', value: ${maxPiece()}, min: 40, max: ${maxPiece()}, step: 1, unit: 'mm', group: 'Picture' }, border: { label: 'Frame', value: 0, min: 0, max: 10, step: 0.5, unit: 'mm', group: 'Picture' } };`
    : `const params = { width: { label: 'Picture width', value: ${maxPiece()}, min: 40, max: ${maxPiece()}, step: 1, unit: 'mm', group: 'Picture' }, maxHeight: { label: 'Max height', value: 1.6, min: 0.8, max: 3, step: 0.08, unit: 'mm', group: 'Picture' }, border: { label: 'Frame', value: 0, min: 0, max: 10, step: 0.5, unit: 'mm', group: 'Picture' } };`;
  const exampleBuild = `function build(p) { return { name: 'Picture', ...H.layertone('photo-1', { width: p.width, maxHeight: ${pictures ? '1.6' : 'p.maxHeight'}, border: p.border }) }; }`;
  // Picture tools are named only with the image model; without it the picture is the user's photo.
  const bandFix = pictures
    ? 'thin its band with set_layertone (swaps) or move it in the stack and repaint the picture for the new stack (part of your own check before you submit, so no need to ask); this is the one reason to change the swap layers that came with the picture.'
    : 'thin its band with set_layertone (swaps) or move it in the stack.';
  const detailInPicture = pictures ? 'paint it into the picture, with edit_picture once the picture exists' : 'it has to be in the photo';
  return `# LayerTone mode
LayerTone mode is ON: the user wants a LayerTone filament painting – a picture printed flat as a thin relief, where stacked filaments swapped at set layer heights show through each other by their TD, so brightness comes from height.
- Call this feature LayerTone in your replies (that is its name in this app; never use another product's name for it).
- Build it with H.layertone(picture, { width, maxHeight, baseHeight, border, gamma, invert, filaments }) → { shape, layerColors, print }. Return it as one part so its print settings (0.08 mm layers over a 0.16 mm first layer, 100 % infill) are used:
    ${exampleParams}
    ${exampleBuild}
- Size: unless the user asks for another, make it as big as the ${printer().name}'s bed allows: ${maxPiece()} × ${maxPiece()} mm. The picture's longer side is ${maxPiece()} mm – landscape or square: width ${maxPiece()}; portrait: width = ${maxPiece()} × (picture width ÷ picture height), so its height is ${maxPiece()} – and with a frame, take 2 × the frame off (the frame adds to the outside). Give the width slider that same maximum.
- The picture names are in the user's message: attached photos are stored as "photo-1", "photo-2"…${pictures ? '; without one, make a picture with generate_picture.' : '; without one, ask the user to attach a photo.'}
${pictures ? `- Filaments first, then the picture (the image model draws it in the colours they print):
  1. The stack: when the user's message names the filaments (colours, brands or how many), use those, matched to their own saved filaments or the library below (exact name, brand, colour and TD). A colour the user names ("red", "brown") means their own filament of that colour: use it, and take one from the library only when they own none of that colour, saying in your final message that it is not one of theirs. When the message names none and the design has no stack yet, ask once with ask_questions, even when Ask first is off (this one question only): how many filaments (usually 3 to 5) and which ones, with your suggested stack for this subject preselected (their own filaments first); then end your reply. Never ask about filaments again in a follow-up.
  2. The picture: generate_picture with filaments (bottom to top), max_height (2.4 when the top filament's TD is above ~3 mm, else 1.6) and, for a photo the user attached, use_attached_photos: true and a name like "photo-1-toned": the photo is repainted for the stack, and the toned one is what you build with.
  3. Build H.layertone with that picture, the same filaments and the max_height you drew it for as a fixed number (no Max height slider: the picture matches only at that height, and the app hides one anyway), and baseHeight only if you passed base_height; check render_model against the picture; submit. The swap layers come fixed in the LayerTone setup: leave them (one exception: a colour that shows where it should not, see "Choose the filaments").
  A picture drawn for a stack goes stale when the filaments or the max height change: say so and offer to repaint it (generate_picture again, or edit_picture with no region); don't repaint unasked.
- To change part of a picture already in the design (swap a person or a face, take something out, fix a detail), call edit_picture: it changes only that region of the stored picture and keeps its name, so keep the script unchanged, check with render_model and submit. Never call generate_picture for it (that makes a new picture). Region: the user's saved mark ("mark") when there is one, else a box picked on show_picture's grid; none redoes the whole picture. With a region, automatic swap layers are kept as they were (set in the LayerTone setup), so the print outside it stays the same: say so in your final message.
` : ''}- Choose the filaments ${pictures ? 'for your suggestion or when the user leaves them to you' : 'yourself, from the picture'} ({ name, brand, color: '#rrggbb', td } with TD in mm, bottom → top):
${loads > 1
    ? `  - ${cap(loadsAtOnce())} (AMS), so up to ${loads} filaments always work with no manual work: treat ${Math.min(loads, 4)} as your normal budget and use as many as the picture benefits from – 2 for a classic black-and-white print${loads >= 3 ? `, ${loads === 3 ? '3' : '3–4'} when the picture has colour or needs more tonal range` : ''}.
  - One more than that (${loads + 1}) is worth it when the picture clearly looks better with it than with ${loads}: a colour the subject needs (skin, sky, grass, a team colour) or a mid-tone that stops two areas from merging. Then suggest ${loads + 1}, and say in your final message which filament is the extra one and why. Never more than ${loads + 1} unless the user asks for more: every filament above ${loads} is a manual spool swap. A filament that is finished before another one starts can share its AMS slot: the user swaps the spool any time between those two layers, with no pause. When that works for the stack, say which two filaments share a slot and between which layers to swap.`
    : `  - The user's printer has no AMS: every filament after the first is a pause and a manual spool swap. Use 2 for a classic black-and-white print, more only when the picture really needs it, and say in your final message how many swaps it takes.`}
  - Black at the bottom and white on top is the most common choice, not a rule: pick colours that suit the subject (skin tones, sky, a brown or grey mid-tone, a team colour…), dark at the bottom to light at the top unless the picture calls for something else.
  - Where a filament shows is set by brightness, not by subject: it colours every spot whose brightness falls in its band. A colour meant for one area only (a blue sky, a red rose, green grass) therefore goes at the bottom when that area is the darkest or the background (everything else is painted over it), or in a band only 1 to 2 layers thick so it does not tint the mid-tones. Check render_model: if the colour shows where it should not, ${bandFix} Never promise that a thin layer "will not show".
  - A filament that is not one of the user's own comes from the library below (their TDs are known); colours marked * have an estimated TD: mention those. Use the library's exact name, brand, colour and TD.
  - First version: pass them to H.layertone({ …, filaments: [...] }). Later messages: change filaments, order or swaps ONLY with set_layertone, passing the full filament list (it applies at once and the user sees it in the panel). Don't edit the script's filaments then: script edits count only after submit_model, and the setup overrides them anyway.
- The filament library (brand line: colour #hex TD; * = estimated TD):
${FILAMENT_LINES}
${mine.length ? `- The user's own filaments, saved in the app (name (brand) #hex TD). The user has these: build the stack from these, and add a library filament only for a colour the picture needs and they don't own (say which); use their exact name, brand, colour and TD:
${myFilamentLines(mine)}
` : ''}- First filament: the user's First filament slider (LayerTone panel; set_layertone base_height) sets how thick the bottom filament is (the script's baseHeight until the user moves it; leave baseHeight out of the script, so it is 0.48 mm). It raises everything above it by the same amount, so the look stays the same: treat maxHeight as the height without that raise (the report gives the real total).
${pictures ? '' : `- Height: the top filament needs enough thickness to show its colour. With a translucent one (TD above ~3 mm, e.g. Jade White 5.9) use a maxHeight around 2.4 mm so the highlights get bright; the panel's simulated print shows the result.
`}- Filaments, their order, TDs and swap layers live in the LayerTone setup: the user edits it in the LayerTone panel, you edit it with set_layertone – the same thing, and it wins over the script's filaments/swaps. Swaps are the layers where each filament after the first starts, counted from the bed (layer 0 = the 0.16 mm first layer, layer n starts at 0.16 + (n − 1) × 0.08 mm), or "auto". The evaluate_model/render_model report lists the stack actually used. A script may also pass swaps: [...] to H.layertone as its own default.
- Back text: every LayerTone print can carry a short mirrored line on its back (the first layers, in a contrasting filament), on by default when the app has a default text. set_layertone back_text changes it (a string), returns to the default ("") or removes it (false).
- Keep it on the bed (no moving in Z) and don't scale it. Every colour in the picture is printed by the filament stack, never a separate coloured part on top (a red rose, a logo, a detail: ${detailInPicture}). Only a stand, a hanging hole or a frame may be extra parts, and the picture part stays a plain H.layertone part.
- Check it with render_model (it shows the simulated colours; the report lists the stack used). In your final message give the size and list the filaments bottom → top with brand, colour and TD and where each one starts (layer and mm), and tell the user they can change them in the LayerTone panel (Print tab) or ask you to. Add one line that Bambu Studio's preview paints each area in the solid colour of its top filament, while the LayerTone panel simulates the filaments showing through each other; neither is exact, so a small test print settles a doubt.`;
}

/** For edit_picture's notes: LayerTone's pictures, selected in the picture editor. */
const PICTURE_WORDS: PictureWords = { noun: 'picture', nouns: 'pictures', instead: 'generate_picture', editor: 'picture editor' };

export const layerTone: PromptMode = {
  id: 'layerTone',
  picture: true,
  active: (m) => m.layerTone,
  system: (o) => (o.layerTone ? layerTonePrompt(o.layerTone.pictures, o.layerTone.mine) : ''),
  turnNotes: ({ isFollowUp, pictureValues, layerToneImages, newPictures, images, req }) => {
    const names = Object.keys(layerToneImages);
    const setup = typeof pictureValues[LAYERTONE_KEY] === 'string' ? pictureValues[LAYERTONE_KEY] : null;
    // edit_picture's notes (the tool is there with the image model).
    const edits = images ? pictureEditNotes(Object.fromEntries(names.map((n) => [n, photoFingerprint(layerToneImages[n])])), pictureValues, req.pictureEdits, PICTURE_WORDS) : [];
    return [
      ...(isFollowUp ? [setup ? `The LayerTone setup (the user's panel; set_layertone changes it, and it wins over the script): ${setup}` : 'The LayerTone setup is empty: the script\'s filaments and automatic swaps apply (set_layertone changes that).'] : []),
      `LayerTone mode is on: make this a LayerTone filament painting with H.layertone (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}${images ? `: once the filament stack is settled, repaint ${newPictures.length > 1 ? 'the one to print' : 'it'} for the stack with generate_picture (use_attached_photos) and build with the toned picture` : ''}.` : ''} ${names.length ? `Pictures available to H.layertone: ${names.map((n) => `"${n}" (${layerToneImages[n].width}×${layerToneImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (images ? (isFollowUp ? 'draw it with generate_picture for the filament stack the user chose (don\'t ask about filaments again).' : 'settle the filament stack first (when the message names none, ask with ask_questions: Ask first being off does not cover this one question), then draw it with generate_picture for that stack.') : 'ask the user to attach a photo (there is no image model without OPENROUTER_API_KEY).')}`,
      ...staleStripNotes(layerToneImages, pictureValues, req.renderValues ?? {}),
      ...edits,
    ];
  },
};

/**
 * Notes on pictures drawn for a filament stack that no longer match the design: the setup's
 * filaments or swaps changed, or the max height in `values` differs from the one it was drawn for.
 */
export function staleStripNotes(images: Record<string, LayerToneImage>, pictureValues: ParamValues, values: ParamValues): string[] {
  const setup = parseLayerToneSetup(pictureValues[LAYERTONE_KEY]);
  const same = (a: LayerToneFilament[] | undefined, b: LayerToneFilament[]) => !!a && a.length === b.length && a.every((f, i) => f.color.toLowerCase() === b[i].color.toLowerCase() && f.td === b[i].td);
  const max = Number(values.maxHeight);
  return Object.entries(images).flatMap(([name, img]) => {
    if (!img.positions || !img.stack) return [];
    const why = [
      setup.filaments && !same(setup.filaments, img.stack.filaments) ? 'the filaments' : '',
      setup.swaps && setup.swaps.join() !== stackSwapsAt(img.stack, setup.baseHeight).join() ? 'the swap layers' : '',
      Number.isFinite(max) && Math.abs(max - img.stack.maxHeight) > 0.01 ? `the max height (${max} mm, drawn for ${img.stack.maxHeight} mm)` : '',
    ].filter(Boolean);
    return why.length ? [`Picture "${name}" was drawn for another filament stack (${why.join(', ')} changed since), so the print no longer matches it: say so and offer to repaint it for the current stack; don't repaint unasked.`] : [];
  });
}
