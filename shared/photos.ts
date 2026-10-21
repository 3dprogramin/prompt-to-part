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
  /** Hanging scenes dangle it from a ribbon (an ornament on a tree): face-on too. */
  hang?: boolean;
  /** A studio shot: studio light and everything sharp, not a lifestyle photo with a blurred room. */
  studio?: boolean;
}

/** The scene for lithophanes: lit from behind, so the picture shows. */
export const BACKLIT_SCENE = 'backlit';
/** The scene of the shop set's studio photos: one light grey studio for every product, like one shoot. */
export const SHOP_SCENE = 'grey-studio';

export const PHOTO_SCENES: PhotoScene[] = [
  { id: 'table', label: 'Wooden table', icon: 'table', scene: 'on a warm oak wooden table in a bright, cosy home interior, softly blurred background, natural window light from the side' },
  { id: 'wall', label: 'Living-room wall', icon: 'frame', wall: true, scene: 'hanging on a light painted wall in a calm, modern living room, mounted flat against the wall at eye level, with a plant, a lamp or a picture frame softly blurred nearby, soft daylight' },
  { id: 'kitchen', label: 'Kitchen counter', icon: 'cup', scene: 'on a clean kitchen counter (light stone or wood) in a bright modern kitchen, with a few kitchen things softly blurred in the background, morning light' },
  { id: 'office', label: 'Office desk', icon: 'desk', scene: 'on a tidy modern office desk with a laptop, a notebook and a pen softly blurred around it, daylight from a window' },
  { id: 'shelf', label: 'Shelf with plants', icon: 'plant', scene: 'on a wooden wall shelf styled with small potted green plants and a couple of books, Scandinavian look, soft natural light' },
  { id: 'studio', label: 'Plain studio', icon: 'studio', scene: 'on a seamless pure white studio sweep, a clean e-commerce product shot with soft, even studio light and a soft natural shadow under it' },
  { id: SHOP_SCENE, label: 'Grey studio', icon: 'studio', studio: true, scene: 'on a seamless light grey (#F3F3F3) studio sweep that curves up behind it with no visible horizon, no props and nothing else in the picture; soft, even light from a large softbox to the upper left and a white fill card to the right, so its shape reads clearly with gentle shading and no harsh highlights; a soft, natural contact shadow right under it. The same backdrop, light and camera for every product of the shop, so all its photos look like one shoot' },
  { id: 'garden', label: 'Outdoor / garden', icon: 'tree', scene: 'outdoors in a garden, on a weathered wooden garden table or a flat stone, green plants and sunlight blurred behind it, late-afternoon light' },
  { id: BACKLIT_SCENE, label: 'Backlit at night', icon: 'lamp', scene: 'standing on a bedside table or a windowsill in a dim, cosy room in the evening, with a warm LED light right behind it so the panel glows; the rest of the room in soft darkness with a few warm, blurred highlights' },
  { id: 'hand', label: 'Hand holding it', icon: 'hand', scene: 'held in a person\'s hand (only the hand and wrist in view, natural skin, relaxed grip that does not cover the important details), so its real size is obvious, plain softly blurred indoor background' },
  // Christmas (seasonal, so in the main list).
  { id: 'xmas-tree', label: 'On the Christmas tree', icon: 'bauble', hang: true, scene: 'hanging from a branch of a real, decorated Christmas tree (fresh green fir needles), next to a couple of glass baubles, with warm fairy lights glowing as soft bokeh in the blurred background, cosy evening light' },
  { id: 'xmas-gifts', label: 'Under the tree', icon: 'gift', scene: 'on a wooden floor or low table under a Christmas tree, next to a few gifts wrapped in kraft paper with red and white ribbons, pine branches and pine cones around, warm fairy lights glowing as soft bokeh behind, cosy evening light' },
  { id: 'xmas-wall', label: 'Christmas wall', icon: 'star', wall: true, scene: 'hanging on a light wall decorated for Christmas, mounted flat at eye level above a sideboard or mantel with a fresh pine garland, warm fairy lights and a few candles softly blurred below it, cosy warm evening light' },
  // Shown after "More scenes".
  { id: 'fridge', label: 'On the fridge', icon: 'fridge', wall: true, scene: 'stuck on the door of a white or brushed-steel fridge in a bright home kitchen, flat against the door at eye level, with a child\'s drawing or a photo held by another magnet softly blurred nearby, soft daylight' },
  { id: 'restaurant', label: 'Restaurant table', icon: 'fork', scene: 'on a table in a stylish restaurant or café, with a plate, a glass and cutlery softly blurred around it, warm ambient light and bokeh from the room behind' },
  { id: 'bedroom', label: 'Bedside table', icon: 'bed', scene: 'on a bedside table next to a book and a small lamp in a calm, softly lit bedroom, linen bedding softly blurred behind, warm morning light' },
  { id: 'bathroom', label: 'Bathroom shelf', icon: 'drop', scene: 'on a clean bathroom shelf or sink edge with white tiles, a folded towel and a small plant softly blurred nearby, bright, fresh daylight' },
  { id: 'workshop', label: 'Workshop bench', icon: 'wrench', scene: 'on a sturdy wooden workbench in a tidy maker workshop, with hand tools and a pegboard softly blurred behind, warm practical light' },
  { id: 'gaming', label: 'Gaming setup', icon: 'gamepad', scene: 'on a dark gaming desk next to a keyboard and a controller, with soft RGB accent light in purple and blue glowing in the blurred background' },
  { id: 'kids', label: 'Kids\' room', icon: 'blocks', scene: 'in a bright, playful kids\' room on a low white shelf or play table, with colourful toys and books softly blurred behind, cheerful daylight' },
  { id: 'car', label: 'In the car', icon: 'car', scene: 'inside a modern car, placed or mounted on the dashboard or centre console, with the windscreen and a softly blurred road view behind, natural daylight' },
  { id: 'flatlay', label: 'Flat lay', icon: 'grid', scene: 'a top-down flat lay on a light linen or concrete surface, neatly styled with a few small related props around it (leaves, a notebook, a coffee cup), soft even daylight' },
];
/** How many scenes show before "More scenes". */
export const MAIN_SCENES = 13;
export const CUSTOM_SCENE = 'custom';
export const MAX_SCENE_CHARS = 600;
export const MAX_NOTES_CHARS = 600;

export const sceneById = (id: string) => PHOTO_SCENES.find((s) => s.id === id);

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

/** The camera of the render a photo is made from (Viewer.photo): Jig's own angles; 'current' is the view's. */
export type PhotoCamera = 'angle' | 'face' | 'front' | 'top' | 'detail';

// Shop photos: one click makes a set of listing photos for one product, all square at 2K (Shopify
// zooms a picture of 2048 × 2048), the studio ones in the same grey studio so a shop's products look
// like one shoot.
export const SHOP_SHOTS = ['main', 'angle', 'top', 'detail', 'lifestyle', 'size'] as const;
export type ShopShot = (typeof SHOP_SHOTS)[number];
export const SHOP_SHOT_LABELS: Record<ShopShot, string> = { main: 'Main', angle: '3/4 view', top: 'Top view', detail: 'Detail', lifestyle: 'Lifestyle', size: 'Size' };
/** The image model's size for shop photos (OpenRouter's image_config.image_size). */
export const SHOP_IMAGE_SIZE = '2K';
/** Longer than this (mm), a product is too big to hold up in one hand: its size photo puts a mug beside it. */
const HANDHELD = 300;

export interface ShopPlanItem { shot: ShopShot; camera: PhotoCamera; scene: string; faceOn: boolean }

/**
 * The shop set for a product: what each photo shows, from which angle its render is taken and in
 * which scene. The image model keeps the render's angle (it never invents an unseen side), so each
 * angle needs its own render. A flat print (wall art, a sign, a coaster) is shown face-on, at an
 * angle that shows its thickness and as a close-up of its face; anything else from the front, at
 * 3/4 and from high above. Then the scene `suggested` for the design, and its size: in a hand, on
 * the wall beside a light switch for a wall piece, next to a mug for a big thing.
 */
export function shopPlan(o: { size: Vec3; suggested: string }): ShopPlanItem[] {
  const [x, y, z] = o.size;
  const flat = z < 0.25 * Math.min(x, y);
  const look = sceneById(o.suggested);
  const wallPiece = flat && !!look?.wall;
  const size = wallPiece ? 'wall' : Math.max(x, y, z) > HANDHELD ? 'table' : 'hand';
  // A small thing suggested in a hand: its lifestyle photo on a table, not a second one in a hand.
  const lifestyle = o.suggested === 'hand' && size === 'hand' ? 'table' : o.suggested;
  const lifeFaceOn = flat && !!(sceneById(lifestyle)?.wall || sceneById(lifestyle)?.hang);
  return [
    { shot: 'main', camera: flat ? 'face' : 'front', scene: SHOP_SCENE, faceOn: flat },
    { shot: 'angle', camera: 'angle', scene: SHOP_SCENE, faceOn: false },
    flat ? { shot: 'detail', camera: 'detail', scene: SHOP_SCENE, faceOn: true } : { shot: 'top', camera: 'top', scene: SHOP_SCENE, faceOn: false },
    { shot: 'lifestyle', camera: lifeFaceOn ? 'face' : 'angle', scene: lifestyle, faceOn: lifeFaceOn },
    { shot: 'size', camera: wallPiece ? 'face' : 'angle', scene: size, faceOn: wallPiece },
  ];
}

/** POST /api/designs/:id/photos */
export interface PhotoRequest {
  /** The clean render of the model (PNG or JPEG); with `from`, optional: a new angle for the product (else the photo's own render). */
  render?: ImageData;
  /** Change an existing photo instead of making a new one: its stored photo and render (/api/designs/:id/images/…), and what to change. */
  from?: { photo: string; render?: string };
  change?: string;
  /** A preset's id, or 'custom' with the scene in `notes`. */
  scene: string;
  aspect: PhotoAspect;
  /** The custom scene, or extra wishes for a preset (light, mood, props). */
  notes?: string;
  /** One of the shop set's photos (Shop photos): made at 2K, with what the shot shows in the prompt. */
  shop?: ShopShot;
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
  /** The stored photo and render (/api/designs/:id/images/…; a changed photo keeps its original's render, if it had one). */
  photo: string;
  render?: string;
  prompt: string;
  model: string;
  /** USD (null if OpenRouter didn't say). */
  cost: number | null;
}

/** What is wrong with a photo request, or null. */
export function photoProblem(b: PhotoRequest): string | null {
  if (!b || typeof b !== 'object') return 'Send the render, the scene and the aspect';
  if (b.render != null) {
    const r = b.render as Partial<ImageData>;
    if (typeof r.data !== 'string' || !r.data || (r.mediaType !== 'image/png' && r.mediaType !== 'image/jpeg')) return 'render must be a PNG or JPEG image';
  }
  if (b.from != null) {
    const ok = (u: unknown) => typeof u === 'string' && PHOTO_URL.test(u);
    if (typeof b.from !== 'object' || !ok(b.from.photo) || (b.from.render != null && !ok(b.from.render))) return 'from: the photo (and render) to change, as /api/designs/<id>/images/<name> URLs';
    if (typeof b.change !== 'string' || !b.change.trim() || b.change.length > MAX_NOTES_CHARS) return `change: what to change in the photo, up to ${MAX_NOTES_CHARS} characters`;
  } else if (b.render == null) return 'render must be a PNG or JPEG image';
  if (typeof b.scene !== 'string' || (b.scene !== CUSTOM_SCENE && !sceneById(b.scene))) return `scene must be one of ${[...PHOTO_SCENES.map((s) => s.id), CUSTOM_SCENE].join(', ')}`;
  if (!PHOTO_ASPECTS.includes(b.aspect)) return `aspect must be one of ${PHOTO_ASPECTS.join(', ')}`;
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES_CHARS)) return `notes: text up to ${MAX_NOTES_CHARS} characters`;
  if (b.scene === CUSTOM_SCENE && !b.notes?.trim()) return 'Describe the custom scene';
  if (b.shop != null && !SHOP_SHOTS.includes(b.shop)) return `shop must be one of ${SHOP_SHOTS.join(', ')}`;
  const p = b.product;
  if (!p || typeof p.name !== 'string' || p.name.length > 200) return 'product.name: text up to 200 characters';
  if (p.description != null && (typeof p.description !== 'string' || p.description.length > 2000)) return 'product.description: text up to 2,000 characters';
  if (!Array.isArray(p.size) || p.size.length !== 3 || !p.size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000)) return 'product.size: [x, y, z] in mm';
  if (p.lithophane != null && typeof p.lithophane !== 'boolean') return 'product.lithophane: true or false';
  if (p.colors != null && (!Array.isArray(p.colors) || p.colors.length > 16 || !p.colors.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)))) return 'product.colors: up to 16 #rrggbb colours';
  return null;
}

/** A stored image of a design (a photo or its render). */
export const PHOTO_URL = /^\/api\/designs\/[a-zA-Z0-9-]{8,64}\/images\/[0-9a-f]{32}\.(png|jpg|webp|gif)$/;

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

/** What a shop photo must show, beyond its scene. */
function shopLine(shot: ShopShot, scene: string): string | null {
  const whole = 'the whole product centred, filling about three quarters of the square frame, nothing cut off';
  switch (shot) {
    case 'main': return `THE MAIN LISTING PHOTO: ${whole}.`;
    case 'angle': return `A 3/4 VIEW FOR THE LISTING, showing its depth and thickness: ${whole}.`;
    case 'top': return `A HIGH VIEW FROM ABOVE FOR THE LISTING, showing its top: ${whole}.`;
    case 'detail': return 'A CLOSE-UP DETAIL PHOTO FOR THE LISTING: the render is cropped to part of the product, which goes on past the edges of the picture. Keep this close crop (do not show the whole product or shrink it to fit), so the surface, the edges and the fine detail of the print fill the photo, with a gentle depth of field.';
    case 'lifestyle': return null;
    case 'size': return scene === 'wall'
      ? 'A SIZE PHOTO FOR THE LISTING: a standard white light switch (about 85 mm wide) on the wall right beside it, both fully in view and in focus, so its real size is obvious at a glance.'
      : scene === 'hand'
      ? 'A SIZE PHOTO FOR THE LISTING: the hand shows how big it is; the product and the hand fully in view.'
      : 'A SIZE PHOTO FOR THE LISTING: a plain coffee mug (about 95 mm tall) beside it, both fully in view, so its real size is obvious at a glance.';
  }
}

/** The prompt the image model gets with the render. */
export function photoPrompt(b: PhotoRequest): string {
  const preset = sceneById(b.scene);
  const notes = b.notes?.trim();
  const [x, y, z] = b.product.size;
  const wall = !!preset?.wall;
  const hang = !!preset?.hang;
  const faceOn = !!b.product.faceOn;
  const shop = b.shop && SHOP_SHOTS.includes(b.shop) ? b.shop : null;
  // A flat print shown face-on: its face and thickness; otherwise the box as printed.
  const size = faceOn
    ? `${mm(x)} mm wide, ${mm(y)} mm tall and ${mm(z)} mm thick`
    : `${mm(x)} × ${mm(y)} mm footprint and ${mm(z)} mm high`;
  const what = [b.product.name.trim(), b.product.description?.trim()].filter(Boolean).join(' – ');
  return [
    'Turn the attached render into a photorealistic product photo of the real, 3D-printed object.',
    '',
    `THE PRODUCT${what ? `: ${what}` : ''}.`,
    `Real size: ${size} (${familiar(Math.max(x, y, faceOn ? 0 : z))}). Show it at exactly this scale: everything around it in true proportion to it (a coffee mug is about 95 mm tall, a light switch about 85 mm wide, an adult hand about 190 mm long, a sofa about 2 m wide)${shop === 'detail' ? '' : ', and frame the photo around it so it is not lost in the room'}.`,
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
    `- do not add, remove, move, mirror, bend or redesign any part; add nothing to it (no hardware, cords, stands, labels or decorations that are not in the render${hang ? ' – only the thin ribbon it hangs from' : ''})`,
    wall || hang
      ? `- ${faceOn ? 'the render shows its front face; ' : ''}it hangs ${wall ? 'flat on the wall ' : ''}with this face to the viewer, upright, photographed from almost straight in front, so the face reads exactly as in the render`
      : faceOn
      ? '- the render shows its front face from above: it lies flat on the surface, face up, photographed from almost straight above, so the face reads exactly as in the render'
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
    wall && Math.max(x, y) < 350 && shop !== 'size' ? 'It is a small piece for a wall: show a light switch, a door frame or a small framed picture near it so its real size is obvious, and photograph it from close by.' : null,
    shop ? shopLine(shop, b.scene) : null,
    preset && notes ? `Also: ${notes}.` : null,
    wall
      ? 'It hangs flat against the wall, its back touching it, with a soft contact shadow, in light that matches the surroundings.'
      : hang
      ? 'It hangs freely from the branch on a thin red ribbon threaded through its own hanging hole or loop (tied around its top if it has none), straight down under its own weight, turned to face the camera, in light that matches the surroundings.'
      : 'It rests ON the surface, not above it: its underside in full contact with the table or shelf, seen in the same perspective as that surface (it lies in its plane, never tilted against it, floating or hovering), with real contact shadows right under it and light that matches the surroundings.',
    '',
    preset?.studio
      ? 'PHOTO: a professional e-commerce studio product photo for an online shop listing, shot on a full-frame camera with a 100 mm lens at f/8 so the product is in sharp focus, soft even studio light, a clean and evenly lit backdrop, the product as the clear hero of the picture.'
      : 'PHOTO: a professional lifestyle product photo for an online shop listing, shot on a full-frame camera with an 85 mm lens, natural light, shallow depth of field with the product in sharp focus and the background softly blurred, the product as the clear hero of the picture, well composed with some space around it.',
    'Only one of the product. No text, captions, logos, watermarks, price tags or borders anywhere in the picture.',
  ].filter((l) => l !== null).join('\n');
}

/**
 * The prompt for making a photo again with a change: a new photo from the render (the first
 * picture, as photoPrompt), with the earlier photo (the second picture) as the scene to keep – its
 * setting, props and light – and the change applied. Composed afresh rather than patched, so the
 * product can sit differently (an edited picture keeps the product as it was drawn).
 */
export function photoEditPrompt(b: PhotoRequest): string {
  return [
    photoPrompt({ ...b, notes: undefined }),
    '',
    'THE SCENE TO KEEP: the second attached picture is an earlier photo of this product. Make the new photo in the same setting – the same place, surface, props, colours, light and mood – and compose it afresh around the product.',
    `THE CHANGE (the reason for the new photo – make it clearly): ${b.change!.trim()}.`,
    b.notes?.trim() ? `Earlier wishes that still apply: ${b.notes.trim()}.` : null,
  ].filter((l) => l !== null).join('\n');
}
