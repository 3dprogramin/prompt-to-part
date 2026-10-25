// The image model's prompts for a photo: a new one from the render, or an earlier photo with a change.
import type { Vec3 } from '../types';
import { aspectOf, familiar, isThin, MUG, mm, SWITCH, thinLine, times, vsHand, vsMug, vsSwitch, wallFrame } from './scale';
import { IDEA_SCENE, sceneById, type PhotoScene } from './scenes';
import { writtenPlace } from './sceneWriter';
import { SCALE_REFS, SHOP_SHOTS, type ScaleRef, type ShopShot } from './shop';
import { sceneKind, subScenes } from './subScenes';
import { MUG_SIZE, scaleRefLayout } from './trueScale';
import type { PhotoRequest } from './request';

/** The scene a request asks for: its sub-scene of the preset, the random scene written for it, or (none written) the image model told to invent one. */
function sceneText(b: PhotoRequest, preset: PhotoScene): string {
  const v = b.variant ?? 1;
  if (v !== 'random') return subScenes(preset.id)[v - 1]?.scene ?? preset.scene;
  if (b.sceneText?.trim()) return b.sceneText.trim();
  // A change or another size of a photo keeps its scene (the earlier photo shows it).
  if (b.from) return `the same setting as in the earlier photo (${sceneKind(preset.id)})`;
  return `invent a fresh setting of this kind: ${sceneKind(preset.id)}; clearly different from all of these: ${subScenes(preset.id).map((s, i) => `(${i + 1}) ${s.name}`).join(', ')}`;
}

/** The render shows the product beside a light switch or a mug at its true size (scaleRefLayout): keep it as it is. */
function trueScaleLine(ref: ScaleRef, size: Vec3, faceOn: boolean, sizeShot: boolean, aspect: number): string {
  // How much wall or table the render frames, so the room is built to that scale too (left alone,
  // the model put a doll-sized armchair and lamp beside a true-sized switch).
  const f = scaleRefLayout(ref, { min: [0, 0, 0], max: size }, aspect).frame, across = f.max[0] - f.min[0];
  const room = `everything else in it is to that same scale: nothing bigger than a small plant, a vase or the corner of a picture frame fits in full view. Furniture, a floor lamp or a window the scene names are far bigger than the whole picture (an armchair alone is about ${times(800, across)} times as tall as all of it): show at most a softly blurred sliver of one at the very edge, never one whole`;
  if (ref === 'wall') return `${sizeShot ? 'A SIZE PHOTO FOR THE LISTING: t' : 'T'}he render already shows it at its true size on the wall, in the frame of the photo: keep it exactly where it is and exactly as large as in the render (the same framing: it neither grows, shrinks nor moves); only make it and the wall photorealistic and add the room around it. The picture shows only about ${mm(across)} mm of wall across (a light switch, ${SWITCH} mm, would be about ${times(SWITCH, across / 100)} % of its width), and ${room}.`;
  const [noun, beside, surface, vs] = ref === 'switch'
    ? ['switch', `on the wall beside a standard white light switch (${SWITCH} mm square)`, 'wall', vsSwitch(size, faceOn)]
    : ['mug', `on the surface beside a plain white coffee mug (${MUG_SIZE.diameter} mm across, ${MUG} mm tall)`, 'surface', vsMug(size)];
  return `${sizeShot ? 'A SIZE PHOTO FOR THE LISTING: t' : 'T'}he render already shows it at its true size, ${beside}. Keep the product and the ${noun} exactly where they are and exactly as large as in the render, with the free ${surface} between them (the same framing: neither grows, shrinks or moves, and the ${noun} stays a ${noun} of that size); only make them and the ${surface} photorealistic and add the room around them, both fully in view and in focus; ${vs}, so its real size is obvious at a glance. The picture shows only about ${mm(across)} mm of ${surface} across (about ${times(across, ref === 'switch' ? SWITCH : MUG_SIZE.diameter)} ${noun} widths), and ${room}.`;
}

/** What a shop photo must show, beyond its scene. */
function shopLine(shot: ShopShot, scene: string, size: Vec3, faceOn: boolean, ref: ScaleRef | null, aspect: number): string | null {
  const thin = isThin(size);
  const whole = 'the whole product centred, filling about three quarters of the square frame, nothing cut off';
  switch (shot) {
    case 'main': return `THE MAIN LISTING PHOTO: ${whole}.`;
    case 'angle': return ref === 'wall'
      ? `A 3/4 VIEW FOR THE LISTING: it hangs flat on the plain light studio wall of the render, upright, seen from the side as in the render, so ${thin ? 'its edge is a thin line just off the wall' : 'its depth shows'}: ${whole}.`
      : `A 3/4 VIEW FOR THE LISTING, showing ${thin ? 'how thin it is (its edge a thin line)' : 'its depth and thickness'}: ${whole}.`;
    case 'top': return `A HIGH VIEW FROM ABOVE FOR THE LISTING, showing its top: ${whole}.`;
    case 'detail': return 'A CLOSE-UP DETAIL PHOTO FOR THE LISTING: the render is cropped to part of the product, which goes on past the edges of the picture. Keep this close crop (do not show the whole product or shrink it to fit), so the surface, the edges and the fine detail of the print fill the photo, with a gentle depth of field.';
    case 'lifestyle': return null;
    case 'size': return ref ? trueScaleLine(ref, size, faceOn, true, aspect)
      : scene === 'wall'
      ? `A SIZE PHOTO FOR THE LISTING: a standard white light switch (about ${SWITCH} mm square) beside it on the same wall, with free wall between them (never touching or overlapping it), both fully in view and in focus; ${vsSwitch(size, faceOn)}, so its real size is obvious at a glance.`
      : scene === 'hand'
      ? `A SIZE PHOTO FOR THE LISTING: the hand shows how big it is: ${vsHand(size)}; the product and the hand fully in view.`
      : `A SIZE PHOTO FOR THE LISTING: a plain coffee mug (about ${MUG} mm tall) beside it, both fully in view; ${vsMug(size)}, so its real size is obvious at a glance.`;
  }
}

/** The idea's scene as Jig wrote it out, and where it puts the product; none for any other scene (or an idea that went in as written). */
export function writtenIdea(b: PhotoRequest): { scene: string; place: ReturnType<typeof writtenPlace> } | null {
  const scene = b.scene === IDEA_SCENE ? b.sceneText?.trim() : undefined;
  return scene ? { scene, place: writtenPlace(scene) } : null;
}

/** The prompt the image model gets with the render. */
export function photoPrompt(b: PhotoRequest): string {
  const preset = sceneById(b.scene);
  const notes = b.notes?.trim();
  const idea = writtenIdea(b);
  const [x, y, z] = b.product.size;
  const wall = !!preset?.wall || idea?.place === 'wall';
  const hang = !!preset?.hang;
  const closeup = !!preset?.closeup;
  const faceOn = !!b.product.faceOn;
  const shop = b.shop && SHOP_SHOTS.includes(b.shop) ? b.shop : null;
  const surface = b.scene === 'fridge' ? 'fridge door' : 'wall';
  // A light switch or mug in the render, at true size.
  const ref = b.scaleRef && SCALE_REFS.includes(b.scaleRef) ? b.scaleRef : null;
  // A flat print shown face-on: its face and thickness; otherwise the box as printed.
  const size = faceOn
    ? `${mm(x)} mm wide, ${mm(y)} mm tall and ${mm(z)} mm thick`
    : `${mm(x)} × ${mm(y)} mm footprint and ${mm(z)} mm high`;
  const what = [b.product.name.trim(), b.product.description?.trim()].filter(Boolean).join(' – ');
  return [
    'Turn the attached render into a photorealistic product photo of the real, 3D-printed object.',
    '',
    `THE PRODUCT${what ? `: ${what}` : ''}.`,
    `Real size: ${size} (${familiar(b.product.size, faceOn || z < 0.25 * Math.min(x, y))}). Show it at exactly this scale: everything around it in true proportion to it (a coffee mug is about 95 mm tall, a light switch about 85 mm wide, an adult hand about 190 mm long, a sofa about 2 m wide)${shop === 'detail' || closeup ? '' : ref ? ', framed as in the render' : ', and frame the photo around it so it is not lost in the room'}.`,
    !b.product.lithophane && isThin(b.product.size) ? thinLine(z) : null,
    b.product.lithophane
      ? 'It is a LITHOPHANE: one panel of white PLA whose thickness varies, so its picture appears only when light shines through it – thin areas glow bright warm white, thick areas stay dark. The render shows it lit from behind: in the photo it must glow from a warm light behind it, the picture showing through exactly as in the render, with the panel\'s frame and stand as they are.'
      : b.product.colors?.length
      ? `It is printed in matte PLA plastic, in the exact colours of the render: filament ${b.product.colors.length > 1 ? 'colours' : 'colour'} ${b.product.colors.join(', ')} (keep each as it is, light ones light, dark ones dark).`
      : 'It is printed in matte PLA plastic, in the exact colours of the render.',
    '',
    'KEEP THE OBJECT EXACTLY AS IN THE RENDER – it is the real product the customer receives:',
    '- the same shape, outline, proportions and thickness; every hole, edge, cut-out, relief and detail in the same place',
    '- the same colours on the same areas',
    // (Left alone, a close-up got a solid backing plate filling the figure.)
    b.product.open ? '- it is an OPEN CUT-OUT: only its lines are material; every area between them, inside its outline too, is empty, so the wall or background shows through there exactly as around it. Never fill those areas, and never add a backing panel, board or plate behind or under it' : null,
    '- any text, numbers, logos or patterns on it copied exactly from the render: the same typeface, letter shapes, stroke widths, spacing and position, letter for letter (never retyped in another font)',
    `- do not add, remove, move, mirror, bend or redesign any part; add nothing to it (no hardware, cords, stands, labels or decorations that are not in the render${hang ? ' – only the thin ribbon it hangs from' : ''})`,
    '- if the render shows several separate pieces (a set), they stay separate pieces, apart as in the render: never join, link, chain or tie them to each other',
    wall || hang
      ? `- ${faceOn ? 'the render shows its front face; ' : ''}it hangs ${wall ? 'flat on the wall ' : ''}with this face to the viewer, upright, photographed from almost straight in front, so the face reads exactly as in the render`
      : faceOn
      ? '- the render shows its front face from above: it lies flat on the surface, face up, photographed from almost straight above, so the face reads exactly as in the render'
      : '- keep it in the same orientation and seen from about the same angle as in the render, so no unseen side has to be invented',
    ref
      ? ref === 'wall' && shop === 'angle' ? '- the plain wall in the render is the studio wall it hangs on, not part of the product'
        : ref === 'wall' ? '- the plain wall in the render is not part of the product: it shows its true size in the frame (see below)'
        : `- the plain ${ref === 'switch' ? 'wall' : 'surface'} and the white ${ref} in the render are not part of the product: they show its true size (see below)`
      : '- the grey background of the render is not part of the product: replace it completely with the scene',
    '',
    'MAKE IT LOOK LIKE A REAL PRINT, NOT A 3D RENDER:',
    '- a matte to satin PLA surface with a soft, slightly diffuse sheen, realistic light falloff and subtle ambient occlusion in the corners',
    '- very fine, regular horizontal layer lines (0.2 mm) faintly visible on its side walls up close; crisp but not razor-sharp edges; flat top faces smooth',
    b.product.lithophane ? '- translucent white PLA lit from behind: a soft, even glow with the picture inside it, no printed or painted image on its surface' : '- solid, opaque filament colours (no gloss, glass, metal or painted look)',
    '',
    `SCENE: ${preset ? sceneText(b, preset) : idea ? idea.scene : notes}.`,
    // A small sign alone on a wall reads as a big one: give it something of known size beside it.
    ref && shop !== 'size' && shop !== 'angle' ? trueScaleLine(ref, b.product.size, faceOn, false, aspectOf(b.aspect))
      : wall && Math.max(x, y) < 350 && shop !== 'size'
      ? surface === 'wall'
        ? `It is a small piece for a wall: show a light switch (about ${SWITCH} mm square) or a small framed picture beside it on the same wall, with free wall between them, or a door frame further along, so its real size is obvious (${vsSwitch(b.product.size, faceOn)}), and photograph it from close by: ${wallFrame(b.product.size, surface)}.`
        : `It is a small piece: show the fridge's handle or another magnet beside it on the door, apart from it, so its real size is obvious, and photograph it from close by: ${wallFrame(b.product.size, surface)}.`
      : null,
    (b.scene === 'hand' || idea?.place === 'hand') && shop !== 'size' ? `Against the hand: ${vsHand(b.product.size)}.` : null,
    closeup && !shop ? 'A CLOSE-UP PHOTO: taken from close by, so the product fills most of the picture and its surface, edges, relief and the fine layer lines of the print read clearly. If the render is cropped to part of the product, keep that close crop (do not show the whole product or shrink it to fit).' : null,
    shop ? shopLine(shop, b.scene, b.product.size, faceOn, ref, aspectOf(b.aspect)) : null,
    preset && notes ? `Also: ${notes}.` : null,
    wall
      ? `It hangs flat against the ${surface}, its back touching it, with a soft contact shadow, in light that matches the surroundings. It is entirely on a wide, flat, continuous stretch of ${surface} with a wide margin of free ${surface} on every side: it never crosses or touches ${surface === 'wall' ? 'a corner, pillar, edge, door or window frame, shelf or furniture' : 'an edge of the door, its handle or another magnet'}, and nothing overlaps it.`
      : hang
      ? 'It hangs freely from the branch on a thin red ribbon threaded through its own hanging hole or loop (tied around its top if it has none), straight down under its own weight, turned to face the camera, in light that matches the surroundings. A set of separate pieces: each piece on its own ribbon from its own branch, apart from the others.'
      : 'It rests ON the surface, not above it: its underside in full contact with the table or shelf, seen in the same perspective as that surface (it lies in its plane, never tilted against it, floating or hovering), with real contact shadows right under it and light that matches the surroundings.',
    '',
    closeup
      ? 'PHOTO: a professional close-up product photo for an online shop listing, shot on a full-frame camera with a 100 mm macro lens at f/5.6, the nearest details of the product in crisp focus and the depth of field falling off gently behind, light from the side that shows its texture, the product as the clear hero of the picture.'
      : preset?.studio
      ? 'PHOTO: a professional e-commerce studio product photo for an online shop listing, shot on a full-frame camera with a 100 mm lens at f/8 so the product is in sharp focus, soft even studio light, a clean and evenly lit backdrop, the product as the clear hero of the picture.'
      : 'PHOTO: a professional lifestyle product photo for an online shop listing, shot on a full-frame camera with an 85 mm lens, natural light, shallow depth of field with the product in sharp focus and the background softly blurred, the product as the clear hero of the picture, well composed with some space around it.',
    'Only one of the product. No text, captions, logos, watermarks, price tags or borders anywhere in the picture.',
  ].filter((l) => l !== null).join('\n');
}

/** A preset's extra wishes kept apart, to go last as earlier wishes; a custom scene or an idea is the scene itself, so it stays. */
export const wishesApart = (b: PhotoRequest): PhotoRequest => (sceneById(b.scene) ? { ...b, notes: undefined } : b);

/**
 * The prompt for making a photo again with a change: a new photo from the render (the first
 * picture, as photoPrompt) that is the earlier photo (the second picture) with only the change
 * applied. Drawn again rather than patched, so the product follows its render; but everything the
 * change doesn't ask for stays as it was (told to compose afresh, the model redrew the whole scene
 * for a small fix). A new render (the design updated, or the view turned) changes only the product.
 */
export function photoEditPrompt(b: PhotoRequest): string {
  return [
    photoPrompt(wishesApart(b)),
    '',
    'THE PHOTO TO CHANGE: the second attached picture is an earlier photo of this product. Make it again with only THE CHANGE below: everything the change does not ask for stays exactly as in that photo (the composition and framing, where the product and each of its pieces are, their size and angle in the frame, the props, background, surface, colours and light). Where the instructions above say how to frame or set up the photo, keep the earlier photo instead.',
    'If the change asks to move, spread, turn or recompose things (e.g. "from above", "closer", "spread them out more"), do that, and keep the rest.',
    b.render
      ? 'The first attached picture is a new render of the product: show the product as in it (its design and the angle it is seen from), on the same spot in the scene, still matching the render exactly as said above.'
      : 'The product still matches the render (the first attached picture) exactly, as said above.',
    `THE CHANGE (the reason for the new photo – make it clearly): ${b.change!.trim()}.`,
    sceneById(b.scene) && b.notes?.trim() ? `Earlier wishes that still apply: ${b.notes.trim()}.` : null,
  ].filter((l) => l !== null).join('\n');
}
