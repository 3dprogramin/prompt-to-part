// A real Jig run for each picture mode: the request that was typed, what came out, and the
// caption of its source picture. The pictures are in modeImages.ts (kept apart so tests can
// import this file without a bundler).
import type { ImageMode } from './PictureModeMenus';

export interface ModeText { request: string; facts: string[]; sourceCaption?: string }

export const MODE_TEXT: Record<ImageMode, ModeText> = {
  off: {
    request: 'desk stand for a phone, the phone cradle tilts from 0 to 60 degrees back',
    facts: [
      'Cradle locks at 0, 15, 30, 45 and 60 degrees with two printed pins',
      '107 × 140 mm base, sized for a phone in a case',
      'Tipping check passed at every angle with a 230 g phone',
      '4 parts, no supports',
    ],
  },
  artwork: {
    sourceCaption: 'The drawing the image model made',
    request: 'a fox sitting in a forest, wall art about 20 cm wide',
    facts: [
      '200 × 155 mm colour relief, 8.2 mm thick',
      '4 filaments, printed in one go with the AMS',
      'The image model draws the picture first, then Jig turns it into layers',
      'Keyhole slots on the back for hanging',
    ],
  },
  layertone: {
    request: 'a sleeping orange cat curled up on a blanket, about 15 cm wide',
    facts: [
      '150 × 112 mm, at most 2.4 mm thick',
      '4 filaments swapped at set layers (black, brown, orange, white)',
      'The light comes through the stacked colours, so brightness comes from height',
      '0.08 mm layers',
    ],
  },
  lithophane: {
    sourceCaption: 'The photo the image model made for it',
    request: 'a lighthouse on rocks at sunset, as a night light panel about 12 cm wide',
    facts: [
      '126 × 99.6 mm panel with a 3 mm frame and a foot to stand on a shelf',
      '0.8 mm where the picture is bright, 3 mm where it is dark',
      'White PLA, printed standing, 0.12 mm layers',
    ],
  },
  lineart: {
    request: 'a motorbike key holder for the hallway wall, with 4 hooks',
    facts: [
      '240 × 136 × 2 mm, one piece, fits the bed',
      '4 key pegs on the bar, lines at least 1.2 mm wide',
      'Black PLA, flat on the bed, no supports',
      'Hangs with picture-hanging strips',
    ],
  },
  figure: {
    sourceCaption: 'The model Meshy made',
    request: 'a small dragon figure sitting on a rock, about 8 cm tall',
    facts: [
      'Meshy sculpted the dragon from the description (25 credits)',
      "Jig cut off Meshy's round base and set the feet into a faceted rock",
      '80 mm tall, one solid piece',
      'Tree supports for the wings and chin',
    ],
  },
};
