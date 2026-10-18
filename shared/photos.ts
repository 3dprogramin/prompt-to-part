// Product photos: the image model turns a clean render of the model into a realistic listing photo
// of the printed product in a scene (on a table, on a wall, in a hand…).
import type { ImageData } from './api';
import type { Vec3 } from './types';

export const PHOTO_ASPECTS = ['1:1', '4:5', '16:9'] as const;
export type PhotoAspect = (typeof PHOTO_ASPECTS)[number];

export interface PhotoScene {
  id: string;
  label: string;
  icon: string;
  /** Where the product is, for the prompt. */
  scene: string;
  /** Wall scenes hang the product: a flat print is shown face-on. */
  wall?: boolean;
}

/** The scene for lithophanes: lit from behind, so the picture shows. */
export const BACKLIT_SCENE = 'backlit';

export const PHOTO_SCENES: PhotoScene[] = [
  { id: 'table', label: 'Wooden table', icon: 'table', scene: 'on a warm oak wooden table in a bright, cosy home interior, softly blurred background, natural window light from the side' },
  { id: 'wall', label: 'Living-room wall', icon: 'frame', wall: true, scene: 'hanging on a light painted wall in a calm, modern living room, mounted flat against the wall at eye level, with a plant, a lamp or a picture frame softly blurred nearby, soft daylight' },
  { id: 'kitchen', label: 'Kitchen counter', icon: 'cup', scene: 'on a clean kitchen counter (light stone or wood) in a bright modern kitchen, with a few kitchen things softly blurred in the background, morning light' },
  { id: 'office', label: 'Office desk', icon: 'desk', scene: 'on a tidy modern office desk with a laptop, a notebook and a pen softly blurred around it, daylight from a window' },
  { id: 'shelf', label: 'Shelf with plants', icon: 'plant', scene: 'on a wooden wall shelf styled with small potted green plants and a couple of books, Scandinavian look, soft natural light' },
  { id: 'studio', label: 'Plain studio', icon: 'studio', scene: 'on a seamless pure white studio sweep, a clean e-commerce product shot with soft, even studio light and a soft natural shadow under it' },
  { id: 'garden', label: 'Outdoor / garden', icon: 'tree', scene: 'outdoors in a garden, on a weathered wooden garden table or a flat stone, green plants and sunlight blurred behind it, late-afternoon light' },
  { id: BACKLIT_SCENE, label: 'Backlit at night', icon: 'lamp', scene: 'standing on a bedside table or a windowsill in a dim, cosy room in the evening, with a warm LED light right behind it so the panel glows; the rest of the room in soft darkness with a few warm, blurred highlights' },
  { id: 'hand', label: 'Hand holding it', icon: 'hand', scene: 'held in a person\'s hand (only the hand and wrist in view, natural skin, relaxed grip that does not cover the important details), so its real size is obvious, plain softly blurred indoor background' },
];
export const CUSTOM_SCENE = 'custom';
export const MAX_SCENE_CHARS = 600;
export const MAX_NOTES_CHARS = 600;

export const sceneById = (id: string) => PHOTO_SCENES.find((s) => s.id === id);

/** The scene that suits the design best, from its name and Claude's description of it. */
export function suggestScene(text: string, size?: Vec3): string {
  const t = text.toLowerCase();
  const has = (...words: string[]) => words.some((w) => new RegExp(`\\b${w}(e?s)?\\b`).test(t));
  if (has('wall', 'plaque', 'frame', 'poster', 'painting', 'layertone', 'lithophane', 'portrait', 'sign', 'clock', 'hook', 'hanger', 'mount')) return 'wall';
  if (has('kitchen', 'spice', 'utensil', 'cutlery', 'egg', 'bottle', 'jar', 'lid', 'cookie', 'bag clip', 'sponge', 'knife')) return 'kitchen';
  if (has('desk', 'pen', 'pencil', 'organi[sz]er', 'cable', 'headphone', 'monitor', 'laptop', 'keyboard', 'phone stand', 'card holder', 'business card', 'office')) return 'office';
  if (has('plant', 'pot', 'planter', 'vase', 'succulent', 'book', 'figurine', 'statue', 'bust', 'ornament', 'sculpture')) return 'shelf';
  if (has('garden', 'bird', 'outdoor', 'feeder', 'hose', 'flower')) return 'garden';
  if (has('keychain', 'key chain', 'fidget', 'toy', 'whistle', 'dice', 'tag', 'pendant', 'charm', 'token', 'coin')) return 'hand';
  if (has('coaster', 'tray', 'bowl', 'dish', 'box', 'holder', 'stand', 'candle', 'lamp')) return 'table';
  // Small things read best in a hand; anything else on a table.
  if (size && Math.max(...size) < 45) return 'hand';
  return 'table';
}

/** POST /api/designs/:id/photos */
export interface PhotoRequest {
  /** The clean render of the model (PNG or JPEG). */
  render: ImageData;
  /** A preset's id, or 'custom' with the scene in `notes`. */
  scene: string;
  aspect: PhotoAspect;
  /** The custom scene, or extra wishes for a preset (light, mood, props). */
  notes?: string;
  product: {
    name: string;
    /** Claude's summary of the design. */
    description?: string;
    /** Bounding box in mm as printed: X, Y, Z. */
    size: Vec3;
    /** The render shows a flat print face-on (it hangs on the wall). */
    faceOn?: boolean;
    /** A lithophane (H.lithophane): a white panel whose picture shows when light shines through it. */
    lithophane?: boolean;
    /** The filament colours of the parts shown (#rrggbb). */
    colors?: string[];
  };
}

export interface PhotoResponse {
  /** The stored photo and render (/api/designs/:id/images/…). */
  photo: string;
  render: string;
  prompt: string;
  model: string;
  /** USD (null if OpenRouter didn't say). */
  cost: number | null;
}

/** What is wrong with a photo request, or null. */
export function photoProblem(b: PhotoRequest): string | null {
  if (!b || typeof b !== 'object') return 'Send the render, the scene and the aspect';
  const r = b.render as Partial<ImageData> | undefined;
  if (!r || typeof r.data !== 'string' || !r.data || (r.mediaType !== 'image/png' && r.mediaType !== 'image/jpeg')) return 'render must be a PNG or JPEG image';
  if (typeof b.scene !== 'string' || (b.scene !== CUSTOM_SCENE && !sceneById(b.scene))) return `scene must be one of ${[...PHOTO_SCENES.map((s) => s.id), CUSTOM_SCENE].join(', ')}`;
  if (!PHOTO_ASPECTS.includes(b.aspect)) return `aspect must be one of ${PHOTO_ASPECTS.join(', ')}`;
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES_CHARS)) return `notes: text up to ${MAX_NOTES_CHARS} characters`;
  if (b.scene === CUSTOM_SCENE && !b.notes?.trim()) return 'Describe the custom scene';
  const p = b.product;
  if (!p || typeof p.name !== 'string' || p.name.length > 200) return 'product.name: text up to 200 characters';
  if (p.description != null && (typeof p.description !== 'string' || p.description.length > 2000)) return 'product.description: text up to 2,000 characters';
  if (!Array.isArray(p.size) || p.size.length !== 3 || !p.size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000)) return 'product.size: [x, y, z] in mm';
  if (p.lithophane != null && typeof p.lithophane !== 'boolean') return 'product.lithophane: true or false';
  if (p.colors != null && (!Array.isArray(p.colors) || p.colors.length > 16 || !p.colors.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)))) return 'product.colors: up to 16 #rrggbb colours';
  return null;
}

const mm = (v: number) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toString();

/** Something familiar of about the same size, so the model gets the scale right. */
function familiar(longest: number): string {
  if (longest <= 30) return 'about the size of a coin – tiny next to a hand';
  if (longest <= 65) return 'about the size of a matchbox – it fits easily in a palm';
  if (longest <= 120) return 'about the size of a drinks coaster or a palm';
  if (longest <= 200) return 'about the size of a paperback book';
  if (longest <= 320) return 'about the size of a sheet of A4 paper';
  return 'a large object, wider than a laptop';
}

/** The prompt the image model gets with the render. */
export function photoPrompt(b: PhotoRequest): string {
  const preset = sceneById(b.scene);
  const notes = b.notes?.trim();
  const [x, y, z] = b.product.size;
  const wall = !!preset?.wall;
  const faceOn = !!b.product.faceOn;
  // A flat print shown face-on: its face and thickness; otherwise the box as printed.
  const size = faceOn
    ? `${mm(x)} mm wide, ${mm(y)} mm tall and ${mm(z)} mm thick`
    : `${mm(x)} × ${mm(y)} mm footprint and ${mm(z)} mm high`;
  const what = [b.product.name.trim(), b.product.description?.trim()].filter(Boolean).join(' – ');
  return [
    'Turn the attached render into a photorealistic product photo of the real, 3D-printed object.',
    '',
    `THE PRODUCT${what ? `: ${what}` : ''}.`,
    `Real size: ${size} (${familiar(Math.max(x, y, faceOn ? 0 : z))}). Show it at exactly this scale: everything around it in true proportion to it (a coffee mug is about 95 mm tall, a light switch about 85 mm wide, an adult hand about 190 mm long, a sofa about 2 m wide), and frame the photo around it so it is not lost in the room.`,
    b.product.lithophane
      ? 'It is a LITHOPHANE: one panel of white PLA whose thickness varies, so its picture appears only when light shines through it – thin areas glow bright warm white, thick areas stay dark. The render shows it lit from behind: in the photo it must glow from a warm light behind it, the picture showing through exactly as in the render, with the panel\'s frame and stand as they are.'
      : b.product.colors?.length
      ? `It is printed in matte PLA plastic, in the exact colours of the render: filament ${b.product.colors.length > 1 ? 'colours' : 'colour'} ${b.product.colors.join(', ')} (keep each as it is, light ones light, dark ones dark).`
      : 'It is printed in matte PLA plastic, in the exact colours of the render.',
    '',
    'KEEP THE OBJECT EXACTLY AS IN THE RENDER – it is the real product the customer receives:',
    '- the same shape, outline, proportions and thickness; every hole, edge, cut-out, relief and detail in the same place',
    '- the same colours on the same areas',
    '- any text, numbers, logos or patterns on it copied exactly from the render: the same typeface, letter shapes, stroke widths, spacing and position, letter for letter (never retyped in another font)',
    '- do not add, remove, move, mirror, bend or redesign any part; add nothing to it (no hardware, cords, stands, labels or decorations that are not in the render)',
    wall
      ? `- ${faceOn ? 'the render shows its front face; ' : ''}it hangs flat on the wall with this face to the viewer, upright, photographed from almost straight in front, so the face reads exactly as in the render`
      : '- keep it in the same orientation and seen from about the same angle as in the render, so no unseen side has to be invented',
    '- the grey background of the render is not part of the product: replace it completely with the scene',
    '',
    'MAKE IT LOOK LIKE A REAL PRINT, NOT A 3D RENDER:',
    '- a matte to satin PLA surface with a soft, slightly diffuse sheen, realistic light falloff and subtle ambient occlusion in the corners',
    '- very fine, regular horizontal layer lines (0.2 mm) faintly visible on its side walls up close; crisp but not razor-sharp edges; flat top faces smooth',
    b.product.lithophane ? '- translucent white PLA lit from behind: a soft, even glow with the picture inside it, no printed or painted image on its surface' : '- solid, opaque filament colours (no gloss, glass, metal or painted look)',
    '',
    `SCENE: ${preset ? preset.scene : notes}.`,
    // A small sign alone on a wall reads as a big one: give it something of known size beside it.
    wall && Math.max(x, y) < 350 ? 'It is a small piece for a wall: show a light switch, a door frame or a small framed picture near it so its real size is obvious, and photograph it from close by.' : null,
    preset && notes ? `Also: ${notes}.` : null,
    'It rests naturally in the scene with real contact shadows and light that matches the surroundings.',
    '',
    'PHOTO: a professional lifestyle product photo for an online shop listing, shot on a full-frame camera with an 85 mm lens, natural light, shallow depth of field with the product in sharp focus and the background softly blurred, the product as the clear hero of the picture, well composed with some space around it.',
    'Only one of the product. No text, captions, logos, watermarks, price tags or borders anywhere in the picture.',
  ].filter((l) => l !== null).join('\n');
}
