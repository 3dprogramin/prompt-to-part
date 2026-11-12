// LayerTone mode (H.layertone): its system prompt section, with the filament library to pick from,
// and its notes on the user's setup and pictures (and on edit_picture, with the image model).
import { loadsAtOnce, maxPiece, printer } from '../../shared/printer';
import { FILAMENT_LIBRARY } from '../../shared/filaments';
import { LAYERTONE_KEY, type LayerToneFilament } from '../../shared/layertone';
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
const myFilamentLines = (mine: LayerToneFilament[]) => mine.map((f) => `  ${f.name}${f.brand ? ` (${f.brand})` : ''} ${f.color} ${f.td}`).join('\n');

function layerTonePrompt(pictures: boolean, mine: LayerToneFilament[] = []) {
  const loads = printer().filaments;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  return `# LayerTone mode
LayerTone mode is ON: the user wants a LayerTone filament painting – a picture printed flat as a thin relief, where stacked filaments swapped at set layer heights show through each other by their TD, so brightness comes from height.
- Call this feature LayerTone in your replies (that is its name in this app; never use another product's name for it).
- Build it with H.layertone(picture, { width, maxHeight, baseHeight, border, gamma, invert, filaments }) → { shape, layerColors, print }. Return it as one part so its print settings (0.08 mm layers over a 0.16 mm first layer, 100 % infill) are used:
    const params = { width: { label: 'Picture width', value: ${maxPiece()}, min: 40, max: ${maxPiece()}, step: 1, unit: 'mm', group: 'Picture' }, maxHeight: { label: 'Max height', value: 1.6, min: 0.8, max: 3, step: 0.08, unit: 'mm', group: 'Picture' }, border: { label: 'Frame', value: 0, min: 0, max: 10, step: 0.5, unit: 'mm', group: 'Picture' } };
    function build(p) { return { name: 'Picture', ...H.layertone('photo-1', { width: p.width, maxHeight: p.maxHeight, border: p.border }) }; }
- Size: unless the user asks for another, make it as big as the ${printer().name}'s bed allows: ${maxPiece()} × ${maxPiece()} mm. The picture's longer side is ${maxPiece()} mm – landscape or square: width ${maxPiece()}; portrait: width = ${maxPiece()} × (picture width ÷ picture height), so its height is ${maxPiece()} – and with a frame, take 2 × the frame off (the frame adds to the outside). Give the width slider that same maximum.
- The picture names are in the user's message: attached photos are stored as "photo-1", "photo-2"…${pictures ? '; without one, make a picture with generate_picture first.' : '; without one, ask the user to attach a photo.'}
${pictures ? `- To change part of a picture already in the design (swap a person or a face, take something out, fix a detail), call edit_picture: it changes only that region of the stored picture and keeps its name, so keep the script unchanged, check with render_model and submit. Never call generate_picture for it (that makes a new picture). Region: the user's saved mark ("mark") when there is one, else a box picked on show_picture's grid; none redoes the whole picture. With a region, automatic swap layers are kept as they were (set in the LayerTone setup), so the print outside it stays the same: say so in your final message.
` : ''}- Choose the filaments yourself, from the picture ({ name, brand, color: '#rrggbb', td } with TD in mm, bottom → top):
${loads > 1
    ? `  - ${cap(loadsAtOnce())} (AMS), so up to ${loads} filaments always work with no manual work: treat ${Math.min(loads, 4)} as your normal budget and use as many as the picture benefits from – 2 for a classic black-and-white print${loads >= 3 ? `, ${loads === 3 ? '3' : '3–4'} when the picture has colour or needs more tonal range` : ''}.
  - More than ${loads} only when really needed: each extra filament means a pause and a manual spool swap. If you go above ${loads}, say so in your final message and why.`
    : `  - The user's printer has no AMS: every filament after the first is a pause and a manual spool swap. Use 2 for a classic black-and-white print, more only when the picture really needs it, and say in your final message how many swaps it takes.`}
  - Black at the bottom and white on top is the most common choice, not a rule: pick colours that suit the subject (skin tones, sky, a brown or grey mid-tone, a team colour…), dark at the bottom to light at the top unless the picture calls for something else.
  - Prefer filaments from the library below (their TDs are known); colours marked * have an estimated TD: mention those. Use the library's exact name, brand, colour and TD.
  - First version: pass them to H.layertone({ …, filaments: [...] }). Later messages: change filaments, order or swaps ONLY with set_layertone, passing the full filament list (it applies at once and the user sees it in the panel). Don't edit the script's filaments then: script edits count only after submit_model, and the setup overrides them anyway.
- The filament library (brand line: colour #hex TD; * = estimated TD):
${FILAMENT_LINES}
${mine.length ? `- The user's own filaments, saved in the app (name (brand) #hex TD). The user has these: prefer them over the library when they fit the picture, and use their exact name, brand, colour and TD:
${myFilamentLines(mine)}
` : ''}- Height: the top filament needs enough thickness to show its colour. With a translucent one (TD above ~3 mm, e.g. Jade White 5.9) use a maxHeight around 2.4 mm so the highlights get bright; the panel's simulated print shows the result.
- Filaments, their order, TDs and swap layers live in the LayerTone setup: the user edits it in the LayerTone panel, you edit it with set_layertone – the same thing, and it wins over the script's filaments/swaps. Once the model exists, change filaments, order and swaps with set_layertone (the script keeps the picture and sizes). Swaps are the layers where each filament after the first starts, counted from the bed (layer 0 = the 0.16 mm first layer, layer n starts at 0.16 + (n − 1) × 0.08 mm), or "auto". The evaluate_model/render_model report lists the stack actually used. A script may also pass swaps: [...] to H.layertone as its own default.
- Keep it on the bed (no moving in Z) and don't scale it. You may add a stand, hanging hole or frame as extra parts, but the picture part must stay a plain H.layertone part.
- Check it with render_model (it shows the simulated colours; the report lists the stack used). In your final message give the size and list the filaments bottom → top with brand, colour and TD and where each one starts (layer and mm), and tell the user they can change them in the LayerTone panel (Print tab) or ask you to.`;
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
      `LayerTone mode is on: make this a LayerTone filament painting with H.layertone (see the system prompt). ${newPictures.length ? `The attached photo${newPictures.length > 1 ? 's are' : ' is'} stored for it as ${newPictures.map((n) => `"${n}"`).join(', ')}.` : ''} ${names.length ? `Pictures available to H.layertone: ${names.map((n) => `"${n}" (${layerToneImages[n].width}×${layerToneImages[n].height})`).join(', ')}.` : 'There is no picture yet: ' + (images ? 'make one with generate_picture.' : 'ask the user to attach a photo (there is no image model without OPENROUTER_API_KEY).')}`,
      ...edits,
    ];
  },
};
