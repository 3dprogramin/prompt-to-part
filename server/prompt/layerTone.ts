// The system prompt's section for LayerTone mode (H.layertone), with the filament library to pick from.
import { maxPiece, printer } from '../../shared/printer';
import { FILAMENT_LIBRARY } from '../../shared/filaments';
import type { LayerToneFilament } from '../../shared/layertone';

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

export function layerTonePrompt(pictures: boolean, mine: LayerToneFilament[] = []) {
  return `LayerTone mode is ON: the user wants a LayerTone filament painting – a picture printed flat as a thin relief, where stacked filaments swapped at set layer heights show through each other by their TD, so brightness comes from height.
- Call this feature LayerTone in your replies (that is its name in Jig; never use another product's name for it).
- Build it with H.layertone(picture, { width, maxHeight, baseHeight, border, gamma, invert, filaments }) → { shape, layerColors, print }. Return it as one part so its print settings (0.08 mm layers over a 0.16 mm first layer, 100 % infill) are used:
    const params = { width: { label: 'Picture width', value: ${maxPiece()}, min: 40, max: ${maxPiece()}, step: 1, unit: 'mm', group: 'Picture' }, maxHeight: { label: 'Max height', value: 1.6, min: 0.8, max: 3, step: 0.08, unit: 'mm', group: 'Picture' }, border: { label: 'Frame', value: 0, min: 0, max: 10, step: 0.5, unit: 'mm', group: 'Picture' } };
    function build(p) { return { name: 'Picture', ...H.layertone('photo-1', { width: p.width, maxHeight: p.maxHeight, border: p.border }) }; }
- Size: unless the user asks for another, make it as big as the ${printer().name}'s bed allows: ${maxPiece()} × ${maxPiece()} mm. The picture's longer side is ${maxPiece()} mm – landscape or square: width ${maxPiece()}; portrait: width = ${maxPiece()} × (picture width ÷ picture height), so its height is ${maxPiece()} – and with a frame, take 2 × the frame off (the frame adds to the outside). Give the width slider that same maximum.
- The picture names are in the user's message: attached photos are stored as "photo-1", "photo-2"…${pictures ? '; without one, make a picture with generate_picture first.' : '; without one, ask the user to attach a photo.'}
- Choose the filaments yourself, from the picture ({ name, brand, color: '#rrggbb', td } with TD in mm, bottom → top):
  - The printer is a Bambu Lab A1 with an AMS lite, so up to 4 filaments always work with no manual work: treat 4 as your normal budget and use as many as the picture benefits from – 2 for a classic black-and-white print, 3–4 when the picture has colour or needs more tonal range.
  - More than 4 only when really needed: each extra filament means a pause and a manual spool swap. If you go above 4, say so in your final message and why.
  - Black at the bottom and white on top is the most common choice, not a rule: pick colours that suit the subject (skin tones, sky, a brown or grey mid-tone, a team colour…), dark at the bottom to light at the top unless the picture calls for something else.
  - Prefer filaments from Jig's library below (their TDs are known); colours marked * have an estimated TD – mention those. Use the library's exact name, brand, colour and TD.
  - First version: pass them to H.layertone({ …, filaments: [...] }). Later messages: change filaments, order or swaps ONLY with set_layertone, passing the full filament list (it applies at once and the user sees it in the panel). Don't edit the script's filaments then: script edits count only after submit_model, and the setup overrides them anyway.
- Jig's filament library (brand line: colour #hex TD; * = estimated TD):
${FILAMENT_LINES}
${mine.length ? `- The user's own filaments, saved in Jig (name (brand) #hex TD). The user has these: prefer them over the library when they fit the picture, and use their exact name, brand, colour and TD:
${myFilamentLines(mine)}
` : ''}- Height: the top filament needs enough thickness to show its colour. With a translucent one (TD above ~3 mm, e.g. Jade White 5.9) use a maxHeight around 2.4 mm so the highlights get bright; the panel's simulated print shows the result.
- Filaments, their order, TDs and swap layers live in the LayerTone setup: the user edits it in the LayerTone panel, you edit it with set_layertone – the same thing, and it wins over the script's filaments/swaps. Once the model exists, change filaments, order and swaps with set_layertone (the script keeps the picture and sizes). Swaps are the layers where each filament after the first starts, counted from the bed (layer 0 = the 0.16 mm first layer, layer n starts at 0.16 + (n − 1) × 0.08 mm), or "auto". The evaluate_model/render_model report lists the stack actually used. A script may also pass swaps: [...] to H.layertone as its own default.
- Keep it on the bed (no moving in Z) and don't scale it. You may add a stand, hanging hole or frame as extra parts, but the picture part must stay a plain H.layertone part.
- Check it with render_model (it shows the simulated colours; the report lists the stack used). In your final message give the size and list the filaments bottom → top with brand, colour and TD and where each one starts (layer and mm), and tell the user they can change them in the LayerTone panel (Print tab) or ask you to.`;
}
