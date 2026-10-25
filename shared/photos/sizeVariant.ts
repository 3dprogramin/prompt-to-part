// Sale sizes (shared/sizes.ts): the prompt for a photo of another size, in the scene of the earlier one.
import type { Vec3 } from '../types';
import { photoPrompt, wishesApart, writtenIdea } from './prompt';
import type { PhotoRequest } from './request';
import { mm } from './scale';
import { sceneById } from './scenes';

/** "1.5x", "0.67x" */
const timesX = (r: number) => `${r >= 10 ? Math.round(r) : +r.toFixed(2)}x`;

/** A size as the photo prompt says it: a flat print face-on by its face and thickness. */
const sizeWords = (s: Vec3, faceOn: boolean) => (faceOn
  ? `${mm(s[0])} mm wide, ${mm(s[1])} mm tall and ${mm(s[2])} mm thick`
  : `${mm(s[0])} × ${mm(s[1])} mm footprint and ${mm(s[2])} mm high`);

/** How much bigger or smaller the product is than in the earlier photo, axis by axis. */
function ratioWords(now: Vec3, was: Vec3, faceOn: boolean): string {
  const parts: [string, number][] = faceOn
    ? [['wide', now[0] / was[0]], ['tall', now[1] / was[1]], ['thick', now[2] / was[2]]]
    : [['wide', now[0] / was[0]], ['deep', now[1] / was[1]], ['high', now[2] / was[2]]];
  const same = parts.filter(([, r]) => Math.abs(r - 1) < 0.02).map(([w]) => w);
  const changed = parts.filter(([, r]) => Math.abs(r - 1) >= 0.02);
  if (!changed.length) return 'the same size as in the earlier photo';
  // "1.5x as wide and as tall" when the axes change alike.
  const groups = new Map<string, string[]>();
  for (const [w, r] of changed) groups.set(timesX(r), [...(groups.get(timesX(r)) ?? []), w]);
  const said = [...groups].map(([t, ws]) => `${t} as ${ws.join(' and as ')}`).join(', and ');
  return `${said} as in the earlier photo${same.length ? ` (just as ${same.join(' and ')} as before)` : ''}`;
}

/**
 * Something of known size in the scene to measure the product against. Certain in a shop size photo
 * (shopLine puts a light switch, a hand or a mug in it) and in a hand; on another wall, a light
 * switch if the earlier photo has one.
 */
function sizeReference(b: PhotoRequest): { what: string; dim: string; mm: number; measure: (s: Vec3) => number; sure: boolean } | null {
  const preset = sceneById(b.scene);
  const faceOn = !!b.product.faceOn;
  const longest = (s: Vec3) => Math.max(s[0], s[1], faceOn ? 0 : s[2]);
  const idea = writtenIdea(b);
  if (b.scene === 'hand' || idea?.place === 'hand') return { what: 'the hand (about 190 mm long)', dim: 'long', mm: 190, measure: longest, sure: true };
  if (preset?.wall || idea?.place === 'wall') return { what: 'the light switch (about 85 mm wide)', dim: 'wide', mm: 85, measure: (s) => s[0], sure: b.shop === 'size' || b.scaleRef === 'switch' };
  if (b.shop === 'size') {
    // A flat thing lying on the table is measured by its longest side, anything else by its height.
    const flatLying = !faceOn && b.product.size[2] < 0.25 * Math.min(b.product.size[0], b.product.size[1]);
    return { what: 'the coffee mug (about 95 mm tall)', dim: flatLying ? 'long' : 'tall', mm: 95, measure: faceOn ? (s) => s[1] : flatLying ? longest : (s) => s[2], sure: true };
  }
  return null;
}

/**
 * The prompt for a sale size's photo made from the same photo of another size: a new photo from
 * the render at this size (the first picture, as photoPrompt), in exactly the scene of the earlier
 * photo (the second picture), with the camera and everything around the product kept and only the
 * product's size changed, by the given ratios.
 */
export function sizeVariantPrompt(b: PhotoRequest): string {
  const base = b.resize!.base;
  const now = b.product.size;
  const faceOn = !!b.product.faceOn;
  const label = b.saleSize?.label?.trim();
  const ref = sizeReference(b);
  const area = (s: Vec3) => s[0] * s[1] * (faceOn ? 1 : s[2]);
  const bigger = area(now) >= area(base.size);
  const refLine = ref && `${ref.sure ? 'In' : 'If the earlier photo shows a light switch: in'} the earlier photo the product was ${timesX(ref.measure(base.size) / ref.mm)} as ${ref.dim} as ${ref.what}; now it is ${timesX(ref.measure(now) / ref.mm)} as ${ref.dim} as it. The ${ref.what.split(' (')[0].replace('the ', '')} stays exactly the same size in the picture.`;
  return [
    photoPrompt(wishesApart(b)),
    '',
    `THIS PHOTO SHOWS ${label ? `THE ${label.toUpperCase()} SIZE` : 'ANOTHER SIZE'} OF THE PRODUCT: ${sizeWords(now, faceOn)}. The second attached picture is a photo of ${base.label ? `the ${base.label} size` : 'it in another size'}: ${sizeWords(base.size, faceOn)}.`,
    `So the product is ${ratioWords(now, base.size, faceOn)}.`,
    refLine,
    b.scaleRef === 'wall' ? 'Its render at this size (the first attached picture) shows it at its true size in the same framing as the earlier photo, the wall as large: keep that size.'
      : b.scaleRef ? `Its render at this size (the first attached picture) shows it beside the same ${b.scaleRef === 'switch' ? 'light switch' : 'mug'}, on the same spot and in the same framing as the earlier photo, both at their true size: keep those sizes.` : null,
    'THE SCENE TO KEEP EXACTLY: make the second attached picture again, as the same shot: the same place, wall, furniture, props, surface, colours and light, and the same camera position, angle, lens and framing. Nothing in the scene moves, grows, shrinks, appears or disappears; only the size of the product changes. Where the instructions above say how to frame the photo, keep the framing of the earlier photo instead.',
    `The product stays on the same spot (centred where it was, at the same height on the wall or in the same place on the surface) and ${bigger ? 'grows' : 'shrinks'} around it; the room and everything in it keep their real size, so the product takes up ${bigger ? 'more' : 'less'} of the picture than before.`,
    'The product itself (its shape, proportions, colours and details) is as in the first attached picture, its render at this size, not as in the earlier photo.',
    b.change?.trim() ? `Also: ${b.change.trim()}.` : null,
    sceneById(b.scene) && b.notes?.trim() ? `Earlier wishes that still apply: ${b.notes.trim()}.` : null,
  ].filter((l) => l !== null).join('\n');
}
