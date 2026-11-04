// The scenes Claude writes: a random sub-scene of a preset, or the user's idea written out; and the
// scene suggested for a design.
import type { Vec3 } from '../types';
import { familiar, mm } from './scale';
import { BACKLIT_SCENE, MAX_SCENE_CHARS, sceneById } from './scenes';
import { sceneKind, subScenes } from './subScenes';

// A random sub-scene written by Claude: a hint picked at random keeps it from writing the same one each time.
const STYLES = ['Japandi', 'Mediterranean', 'mid-century modern', 'rustic farmhouse', 'coastal', 'art deco', 'minimalist', 'bohemian', 'industrial', 'alpine chalet', 'French country', 'tropical', 'classic English', 'wabi-sabi', 'Nordic cabin', 'urban loft', 'Moroccan', 'retro 70s', 'Tuscan', 'contemporary Romanian'];
const LIGHTS = ['soft morning light', 'golden-hour sun', 'bright overcast daylight', 'warm evening lamp light', 'crisp winter daylight', 'dappled sunlight'];
const BACKDROPS = ['warm sand', 'soft terracotta', 'pale sage', 'dusty blue', 'light stone grey', 'blush pink', 'charcoal', 'cream', 'muted olive', 'deep navy'];
export const SCENE_WRITER_PROMPT = `You write the setting for a product photo of a 3D-printed object: one phrase in the style of the examples given, saying where the product is (the surface or wall it is on), a few things softly blurred around it, and the light. Photorealistic and plausible, calm and uncluttered, nothing that competes with the product or hides it, no people other than a hand if the kind asks for one, and no text, signs, logos or screens anywhere.
Answer with ONLY the setting phrase, no quotes and no other text, at most 400 characters.`;

/** What Claude is asked for a random sub-scene of a preset. */
export function sceneWriterPrompt(id: string, pick: () => number = Math.random, size?: Vec3): string {
  const preset = sceneById(id);
  const any = <T>(list: T[]) => list[Math.floor(pick() * list.length) % list.length];
  const studio = !!preset?.studio || id === 'studio';
  return [
    `The kind of place: ${sceneKind(id)}.`,
    'Write a fresh setting of this kind, clearly different from these three (they show the style and the level of detail):',
    ...subScenes(id).map((s, i) => `${i + 1}. ${s.scene}`),
    studio ? `For variety, if it fits: a ${any(BACKDROPS)} tone.` : `For variety, if it fits the place: a ${any(STYLES)} look, ${any(LIGHTS)}.`,
    smallLine(size, !!preset?.wall),
  ].filter((l) => l !== null).join('\n');
}

/** A small piece in a setting written for a room comes out room-sized: the setting must suit its size. */
const smallLine = (size: Vec3 | undefined, wall: boolean) => (size && Math.max(...size) < 350
  ? `The product is small: ${mm(size[0])} × ${mm(size[1])} × ${mm(size[2])} mm (${familiar(size, size[2] < 0.25 * Math.min(size[0], size[1]))}). The photo is taken close to it, so write a setting for something this size: only what is right next to it shows, partly and softly blurred at the edges; no whole room, sofa or big furniture in full view${wall ? ', mostly plain wall around it' : ''}.`
  : null);

// The user's idea written out by Claude: a few words ("cosy cabin, snowy evening") made one setting in
// the presets' style and detail; a wall piece on a wide plain wall, anything else on a surface, or
// in a hand (or on a wall) when the idea clearly asks for it. How the setting begins tells which.
export const IDEA_WRITER_PROMPT = `You write the setting for a product photo of a 3D-printed object from the user's short idea: one phrase in the style of the examples given, saying where the product is (the surface or wall it is on), a few things softly blurred around it, and the light. Photorealistic and plausible, calm and uncluttered, nothing that competes with the product or hides it, no people other than a hand if the idea asks for one, and no text, signs, logos or screens anywhere.
Answer with ONLY the setting phrase, no quotes and no other text, at most 400 characters.`;

/** The idea to write out, with the scene suggested for the product (a wall piece is suggested a wall) and its name. */
export interface SceneIdea { idea: string; suggested?: string; product?: string }

/** What Claude is asked for to write the user's idea out into a scene. */
export function ideaWriterPrompt(o: SceneIdea, size?: Vec3): string {
  const like = sceneById(o.suggested ?? '');
  const wall = !!like?.wall;
  // The examples: the scene suggested for the product (when it is a place), then others it could be in.
  const own = like && !like.studio && !like.closeup && like.id !== 'studio' && like.id !== 'hand' ? [like.scene] : [];
  const more = wall
    ? [sceneById('wall')!.scene, sceneById('bedroom-wall')!.scene, subScenes('wall')[2].scene]
    : [sceneById('table')!.scene, subScenes('kitchen')[1].scene, sceneById('shelf')!.scene];
  const hand = 'Only if the idea clearly asks for it to be held: it is held in a person\'s hand (only the hand and wrist in view, a relaxed grip that does not cover it); begin with "held in a person\'s hand".';
  return [
    `The idea: "${o.idea.trim()}".`,
    o.product?.trim() ? `The product: ${o.product.trim()}.` : null,
    'Write it out as one setting, in the style and level of detail of these examples:',
    ...[...new Set([...own, ...more])].slice(0, 3).map((s, i) => `${i + 1}. ${s}`),
    'Keep everything the idea says (the place, the mood, the season, the colours, the things it names) and add nothing that contradicts it; fill in the rest so it suits the idea: the surface or wall it is on, a few things softly blurred around it, the light. Write it in English, whatever language the idea is in. Leave out anything the rules forbid (text, signs, logos, screens, people other than a hand), even if the idea names it.',
    wall
      ? `The product is a wall piece, shown face-on: it hangs flat against the wall at eye level, in the middle of a wide, plain, flat stretch of wall (no panelling, tiles, wallpaper pattern, shelves or frames behind it), furniture and decor only well below it or to the side, softly blurred; begin with "hanging". ${hand} Only if the idea clearly asks for a table, shelf or other surface: it rests on that; begin with "on".`
      : `The product rests on a surface (a table, shelf, counter or whatever suits the idea); begin with "on" or "standing on". ${hand} Only if the idea clearly asks for it to hang on a wall: it hangs flat against the wall at eye level, in the middle of a wide, plain, flat stretch of it; begin with "hanging".`,
    o.suggested === BACKLIT_SCENE ? 'It is a lithophane: keep a warm light right behind it, so its picture glows.' : null,
    smallLine(size, wall),
  ].filter((l) => l !== null).join('\n');
}

/** Where a scene written from an idea puts the product, by how it begins (ideaWriterPrompt): on a wall, in a hand or on a surface. */
export function writtenPlace(scene: string): 'wall' | 'hand' | 'surface' {
  const s = scene.trim().toLowerCase();
  return /^(hanging|hung|mounted|stuck)\b/.test(s) ? 'wall' : /^held\b/.test(s) ? 'hand' : 'surface';
}

/** Claude's random scene, cleaned up: one phrase, no quotes or final full stop. */
export function parseWrittenScene(text: string): string {
  const s = text.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
  if (!s) throw new Error('No scene came back');
  return s.slice(0, MAX_SCENE_CHARS);
}

/** The scene that suits the design best, from its name and Claude's description of it. */
export function suggestScene(text: string, size?: Vec3): string {
  const t = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => new RegExp(`\\b${w}(e?s)?\\b`).test(t));
  const onWall = has('wall', 'plaque', 'frame', 'poster', 'painting', 'layertone', 'lithophane', 'line ?art', 'key ?holder', 'portrait', 'sign', 'clock', 'hook', 'hanger', 'mount');
  if (has('christmas', 'xmas', 'cr[aă]ciun', 'santa', 'reindeer', 'snowman', 'snowflake', 'bauble', 'advent', 'nativity', 'gingerbread')) {
    if (has('ornament', 'bauble', 'snowflake', 'decoration')) return 'xmas-tree';
    return onWall ? 'xmas-wall' : 'xmas-gifts';
  }
  if (has('fridge', 'refrigerator', 'fridge magnet')) return 'fridge';
  if (onWall) return 'wall';
  if (has('kitchen', 'spice', 'utensil', 'cutlery', 'egg', 'bottle', 'jar', 'lid', 'cookie', 'bag clip', 'sponge', 'knife')) return 'kitchen';
  if (has('desk', 'pen', 'pencil', 'organi[sz]er', 'cable', 'headphone', 'monitor', 'laptop', 'keyboard', 'phone stand', 'card holder', 'business card', 'office')) return 'office';
  if (has('plant', 'pot', 'planter', 'vase', 'succulent', 'book', 'figurine', 'statue', 'bust', 'ornament', 'sculpture')) return 'shelf';
  if (has('garden', 'bird', 'outdoor', 'feeder', 'hose', 'flower')) return 'garden';
  if (has('restaurant', 'menu', 'napkin', 'table number')) return 'restaurant';
  if (has('bathroom', 'toothbrush', 'soap', 'razor', 'shower', 'toilet')) return 'bathroom';
  if (has('tool', 'workshop', 'drill', 'wrench', 'screwdriver', 'clamp', 'pegboard')) return 'workshop';
  if (has('controller', 'gamepad', 'joystick', 'headset', 'console', 'gaming')) return 'gaming';
  if (has('car', 'dashboard', 'vent', 'cup holder')) return 'car';
  if (has('bedside', 'night ?light', 'jewel(le)?ry', 'ring dish', 'earring', 'glasses')) return 'bedroom';
  if (has('kid', 'child', 'nursery', 'baby')) return 'kids';
  if (has('keychain', 'key chain', 'fidget', 'toy', 'whistle', 'dice', 'tag', 'pendant', 'charm', 'token', 'coin')) return 'hand';
  if (has('coaster', 'tray', 'bowl', 'dish', 'box', 'holder', 'stand', 'candle', 'lamp')) return 'table';
  // Small things read best in a hand; anything else on a table.
  if (size && Math.max(...size) < 45) return 'hand';
  return 'table';
}
