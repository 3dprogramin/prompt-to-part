// AI artwork mode (generate_artwork, traced for H.svg): its system prompt section and its note.
import { loadsAtOnce, printer } from '../../shared/printer';
import type { PromptMode } from './types';

/** The artwork section, for the chosen printer's filament count. */
const artworkOn = () => `# AI artwork mode
AI artwork mode is ON (generate_artwork): the user chose it, so the design is artwork – its picture drawn by the image model, whatever the subject (people, animals, scenes, but also objects, vehicles, weapons, tools: all drawn as illustrations), never modelled with primitives (it looks childish). Call generate_artwork first, then build the design around the returned drawing with H.svg.
- Typical use: wall art, reliefs, plaques, signs, coasters, lids. Make it look like quality artwork: a backing plate or frame, the colours as layers at different heights (e.g. 0.6–1 mm steps), every colour its own part (multi-colour single print, ${printer().filaments > 1 ? `at most ${printer().filaments} colours: ${loadsAtOnce()}` : 'one colour unless the user asks for more: the printer has no AMS, so every extra colour is a manual filament swap'}, counting the plate).
- Pick the colours: the user's filament colours if they said, else 3–4 that print well together (e.g. black, a mid grey, white, plus one accent), or shades of grey for a classic look.
- Describe the subject precisely (who/what, pose, expression, framing, the mood); the print rules (flat colours, no background) are added for you. Leave style empty: the default is realistic artwork (true proportions, faces, light and shadow, posterized like a screen print), which is what users want; set a style only when the user asks for one (cartoon, minimal…). Describe real people by their look rather than by name (image models often refuse names). Use the user's attached photos (use_attached_photos) when the artwork should look like them.
- The piece around the picture – backing plate, frame, mounting holes, lettering – is built with primitives and H.text as usual; an attached SVG the user wants used replaces generate_artwork.`;

export const artwork: PromptMode = {
  id: 'artwork',
  active: (m) => m.artwork,
  system: (o) => (o.artwork ? artworkOn() : ''),
  turnNotes: ({ drawings }) => {
    // The user chose AI artwork for this design: the picture comes first, whatever the subject.
    const names = Object.keys(drawings);
    return [`AI artwork mode is on: the user wants this as artwork – a flat multi-colour wall piece, relief, plaque or sign whose picture the image model draws, not a 3D model of the subject. ${names.length
      ? `Drawings in this design: ${names.map((n) => `"${n}"`).join(', ')}; keep using them unless the user asks for a new or different picture (then call generate_artwork again).`
      : 'There is no artwork yet: start with generate_artwork – for any subject, objects and machines included (a tommy gun, a car, a guitar are drawn as illustrations too) – then build the piece around it with H.svg.'} Model the subject in 3D geometry only if the user's message explicitly asks for a 3D object.`];
  },
};
