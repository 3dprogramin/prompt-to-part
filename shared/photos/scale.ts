// The product's size in words: against familiar things, and against things of known size in a scene.
import type { Vec3 } from '../types';
import { MUG_SIZE, SWITCH_PLATE } from './trueScale';

export const mm = (v: number) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toString();

// Familiar things of a known size (mm): flat ones by their face (long × short side), any by its longest side.
const FACES: [string, number[]][] = [
  ['a coin', [24, 24]], ['a matchbox', [53, 36]], ['a credit card', [86, 54]], ['a drinks coaster', [100, 100]],
  ['a CD case', [142, 125]], ['an A6 postcard', [148, 105]], ['a paperback book', [178, 111]], ['a sheet of A5 paper', [210, 148]],
  ['a sheet of A4 paper', [297, 210]], ['a vinyl record sleeve', [315, 315]], ['a sheet of A3 paper', [420, 297]],
  ['an A2 poster', [594, 420]], ['an A1 poster', [841, 594]],
];
const LENGTHS: [string, number[]][] = [
  ['a coin', [24]], ['a golf ball', [43]], ['a matchbox', [53]], ['a credit card', [86]], ['a coffee mug', [95]],
  ['a smartphone', [150]], ['a paperback book', [178]], ['a dinner plate', [260]], ['a shoebox', [330]],
  ['a carry-on suitcase', [550]], ['an acoustic guitar', [1000]],
];

/** Something familiar of about the same size, so the model gets the scale right: a flat piece by its face, anything else by its longest side. */
export function familiar(size: Vec3, flat: boolean): string {
  const [x, y, z] = size;
  // The worst side's mismatch and the overall scale, in log terms (0: the same).
  const nearest = (list: [string, number[]][], dims: number[]) => list
    .map(([name, ref]) => {
      const logs = dims.map((v, i) => Math.log(v / ref[i]));
      return { name, off: Math.max(...logs.map(Math.abs)), scale: logs.reduce((a, l) => a + l, 0) / logs.length };
    })
    .sort((a, b) => a.off - b.off)[0];
  const longest = Math.max(x, y, flat ? 0 : z);
  let best = flat ? nearest(FACES, [Math.max(x, y), Math.min(x, y)]) : null;
  // A long, thin flat piece is like nothing flat: by its length then.
  const strip = !!best && best.off > 0.45;
  if (!best || strip) best = nearest(LENGTHS, [longest]);
  const hint = longest <= 30 ? ', tiny next to a hand' : longest <= 65 ? ', it fits easily in a palm' : '';
  const [same, more, less] = strip ? ['about as long as', 'longer', 'shorter'] : ['about the size of', 'larger', 'smaller'];
  const like = best.off <= 0.12 ? same
    : Math.abs(best.scale) < 0.06 ? `close in ${strip ? 'length' : 'size'} to`
    : `${Math.abs(best.scale) < 0.35 ? 'a bit ' : ''}${best.scale > 0 ? more : less} than`;
  return `${like} ${best.name}${hint}`;
}

// Things of a known size in some scenes (mm), and how many times as big the product is.
export const SWITCH = SWITCH_PLATE.side, HAND = 190, PALM = 85, MUG = MUG_SIZE.height;
/** A picture's width / height: '4:5' is 0.8. */
export const aspectOf = (a: string | undefined) => { const [w, h] = (a ?? '1:1').split(':').map(Number); return w > 0 && h > 0 ? w / h : 1; };
export const times = (v: number, ref: number) => { const r = v / ref; return (r >= 10 ? Math.round(r) : +r.toFixed(r < 0.1 ? 2 : 1)).toString(); };

/** The product beside a light switch (a standard EU plate, about 85 mm square). */
export function vsSwitch(size: Vec3, faceOn: boolean): string {
  const [x, y, z] = size;
  return faceOn
    ? `it is about ${times(x, SWITCH)} times as wide and ${times(y, SWITCH)} times as tall as the switch`
    : `its longest side is about ${times(Math.max(x, y, z), SWITCH)} times the width of the switch`;
}
export const vsHand = (size: Vec3) => {
  const longest = Math.max(...size);
  return `its longest side is about ${times(longest, HAND)} times the length of an adult hand (${HAND} mm) and ${times(longest, PALM)} times the width of its palm (${PALM} mm)`;
};
export const vsMug = ([x, y, z]: Vec3) => `its longest side is about ${times(Math.max(x, y, z), MUG)} times the mug's height${z >= MUG / 2 && z < Math.max(x, y) ? ` and it stands about ${times(z, MUG)} times as tall as the mug` : ''}`;
/** How much wall a close photo of a small wall piece shows (cm, side to side), and how much of that it fills: told in numbers, else the image model shows the room and blows the piece up. */
export const wallFrame = ([x, y]: Vec3, surface: string) => {
  const cm = Math.max(30, Math.round((Math.max(x, y) * 2.5) / 50) * 5);
  return `the picture shows only about ${cm} cm of ${surface} from side to side, so it fills about ${Math.round((Math.max(x, y) / (cm * 10)) * 100)}% of the width (never a whole room or a big piece of furniture in full view; anything below it shows only partly, at the bottom edge)`;
};

/** A thin, flat print (a LayerTone panel, a plaque, a coaster): the image model draws it as a thick slab unless told. */
export const isThin = ([x, y, z]: Vec3) => z <= 10 && z < 0.08 * Math.min(x, y);
export const thinLine = (z: number) => `It is a THIN, FLAT panel: only ${mm(z)} mm thick (${z <= 5 ? `about ${times(z, 2)} times as thick as a coin` : `about ${times(z, 8)} times as thick as a smartphone`}), so from any angle its edge is just a thin line. Never show it as a thick slab, block, box or canvas on a frame.`;
