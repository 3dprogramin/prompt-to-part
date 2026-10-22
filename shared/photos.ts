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
  { id: 'wall', label: 'Living-room wall', icon: 'frame', wall: true, scene: 'hanging in the middle of a wide, plain stretch of light painted wall in a calm, modern living room, mounted flat against the wall at eye level, with a plant, a lamp or a picture frame softly blurred nearby, soft daylight' },
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
  { id: 'xmas-wall', label: 'Christmas wall', icon: 'star', wall: true, scene: 'hanging in the middle of a wide stretch of light wall decorated for Christmas, mounted flat at eye level well above a sideboard or mantel with a fresh pine garland, warm fairy lights and a few candles softly blurred below it, cosy warm evening light' },
  // Shown after "More scenes".
  { id: 'fridge', label: 'On the fridge', icon: 'fridge', wall: true, scene: 'stuck in the middle of the wide, flat door of a white or brushed-steel fridge in a bright home kitchen, flat against the door at eye level, with a child\'s drawing or a photo held by another magnet softly blurred nearby, soft daylight' },
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

// Sub-scenes: each preset in 4 looks. 1 is the preset's own scene; 2 and 3 the same kind of place in
// another style; 'random' a fresh one of that kind, written by Claude for each new photo (or, when
// Jig can't reach Claude, invented by the image model). A wall scene still gives a wide free stretch
// of wall, a hanging one branches, a studio a clean backdrop, the others a flat surface.
export const SCENE_VARIANTS = [1, 2, 3, 'random'] as const;
export type SceneVariant = (typeof SCENE_VARIANTS)[number];
export interface SubScene { name: string; scene: string }
interface SceneLooks {
  /** Sub-scene 1's name (its scene is the preset's). */
  look: string;
  /** Sub-scenes 2 and 3. */
  variants: [SubScene, SubScene];
  /** For a random sub-scene: the kind of place, with what it must keep. */
  kind: string;
}

const SUB_SCENES: Record<string, SceneLooks> = {
  table: {
    look: 'Oak table, cosy home',
    variants: [
      { name: 'White marble, airy dining room', scene: 'on a round white marble table in a light, airy dining room with sheer linen curtains, a ceramic vase with a few green stems softly blurred in the background, soft diffused daylight' },
      { name: 'Dark walnut, warm evening', scene: 'on a dark walnut dining table in a warm, calm room, a lit candle and a folded linen napkin softly blurred nearby, warm low lamp light from the side in the evening' },
    ],
    kind: 'a table in a home: a flat table top (wood, stone or similar) it rests on, the room softly blurred behind',
  },
  wall: {
    look: 'Modern, light painted wall',
    variants: [
      { name: 'Scandinavian, warm white', scene: 'hanging in the middle of a wide, plain stretch of warm off-white wall in a bright Scandinavian living room, mounted flat against the wall at eye level, well above a low light-oak sideboard with a ceramic vase and a trailing plant softly blurred below it, a pale wooden floor and the arm of a linen sofa with a wool throw at the edge of the frame, soft Nordic daylight from a large window' },
      { name: 'Classic, sage green wall', scene: 'hanging in the middle of a wide, plain stretch of muted sage-green painted wall (a calm mid tone, smooth matte paint) in a classic, cosy living room, mounted flat against the wall at eye level, with a velvet armchair, a brass floor lamp and a tall potted plant softly blurred to the side and below, warm late-afternoon light from a window' },
    ],
    kind: 'a living-room wall: it hangs flat at eye level in the middle of a wide, plain, flat stretch of painted or plastered wall (no panelling, tiles, wallpaper pattern or shelves behind it), furniture and decor only well below it or to the side, softly blurred',
  },
  kitchen: {
    look: 'Bright modern kitchen',
    variants: [
      { name: 'Rustic farmhouse, butcher block', scene: 'on a thick butcher-block wooden counter in a rustic farmhouse kitchen, with white metro tiles, a linen tea towel and a bunch of fresh herbs in a jar softly blurred behind, warm morning sun from a window' },
      { name: 'Dark contemporary kitchen', scene: 'on a dark grey matte stone counter in a sleek contemporary kitchen with dark cabinets, a brushed brass tap and a bowl of lemons softly blurred behind, soft daylight from the side' },
    ],
    kind: 'a kitchen: a clean counter it rests on, the kitchen softly blurred behind',
  },
  office: {
    look: 'Modern desk, laptop',
    variants: [
      { name: 'Light oak home office', scene: 'on a light oak desk in a calm home office, with a monitor, a ceramic mug and a small potted plant softly blurred behind, a window with sheer curtains, soft morning light' },
      { name: 'Walnut desk, warm lamp', scene: 'on a dark walnut desk with a leather desk pad, a brass desk lamp glowing and a few hardback books softly blurred behind, warm evening light' },
    ],
    kind: 'a desk in an office or a home office: a tidy desk top it rests on, desk things softly blurred around it',
  },
  shelf: {
    look: 'Scandinavian shelf, plants',
    variants: [
      { name: 'Boho, rattan and ceramics', scene: 'on a light wooden floating shelf against a warm sand-beige wall, styled with a small rattan basket, handmade ceramic vases and a little dried pampas grass, boho look, warm afternoon light' },
      { name: 'Dark bookcase, cosy library', scene: 'on a shelf of a dark-painted built-in bookcase, between neat rows of hardback books and a small trailing plant, softly blurred, warm lamp light, a cosy library look' },
    ],
    kind: 'a shelf (a wall shelf or a bookcase): a flat shelf it stands on, styled with a few small things, softly blurred',
  },
  studio: {
    look: 'Pure white sweep',
    variants: [
      { name: 'Warm sand backdrop', scene: 'on a seamless warm sand-beige studio sweep, a clean e-commerce product shot with soft, even studio light, a gentle natural shadow under it and nothing else in the picture' },
      { name: 'Pale sage, white plinth', scene: 'standing on a simple matte white cylindrical plinth against a seamless pale sage-green studio backdrop, a clean e-commerce product shot with soft, even studio light and a soft natural shadow, no other props' },
    ],
    kind: 'a clean e-commerce studio shot: a seamless plain backdrop in one calm colour, or a simple plinth on it, soft even studio light, no room, no clutter, no props that compete with it',
  },
  [SHOP_SCENE]: {
    look: 'Light grey, like the shop set',
    variants: [
      { name: 'Charcoal sweep', scene: 'on a seamless charcoal grey (#3A3A3A) studio sweep that curves up behind it with no visible horizon, no props and nothing else in the picture; soft, even light from a large softbox to the upper left and a white fill card to the right, with a gentle rim light so its edges stand out from the dark backdrop; a soft, natural contact shadow right under it' },
      { name: 'Grey sweep, concrete block', scene: 'standing on a small, smooth block of light concrete on a seamless light grey (#E6E6E6) studio sweep that curves up behind it with no visible horizon, nothing else in the picture; soft, even light from a large softbox to the upper left and a white fill card to the right, so its shape reads clearly with gentle shading; soft, natural contact shadows' },
    ],
    kind: 'a clean e-commerce studio shot: a seamless studio sweep in a neutral tone with no visible horizon, soft even softbox light, no props (at most a simple plinth or block), no room',
  },
  garden: {
    look: 'Garden table, late sun',
    variants: [
      { name: 'Stone patio, lavender', scene: 'outdoors on a sunny stone patio, on a low, flat slab of pale natural stone, with potted lavender and a small olive tree softly blurred behind, warm, soft morning sun' },
      { name: 'City balcony, potted plants', scene: 'outdoors on a small city balcony, on a wooden bistro table, surrounded by potted herbs and green climbing plants, with rooftops softly blurred behind, bright overcast daylight' },
    ],
    kind: 'outdoors (a garden, patio, terrace, deck or balcony): a flat outdoor table, slab or wall top it rests on, greenery softly blurred behind',
  },
  [BACKLIT_SCENE]: {
    look: 'Bedside, warm evening',
    variants: [
      { name: 'Windowsill at dusk', scene: 'standing on a windowsill at dusk, the deep blue evening sky softly blurred through the glass beyond it, with a warm LED light right behind the panel so it glows; the room dim and calm around it' },
      { name: 'Living-room shelf at night', scene: 'standing on a dark wooden shelf in a dim living room at night, with a warm LED light right behind it so the panel glows; a small table lamp and a few books glowing softly in the blurred darkness around it' },
    ],
    kind: 'a dim room in the evening or at night: a flat surface (a shelf, sill or table) it stands on, a warm LED light right behind it so the panel glows, the rest of the room in soft darkness',
  },
  hand: {
    look: 'Indoors, plain background',
    variants: [
      { name: 'Outdoors, sunny greenery', scene: 'held in a person\'s hand outdoors (only the hand and wrist in view, natural skin, relaxed grip that does not cover the important details), so its real size is obvious, sunny green foliage softly blurred behind' },
      { name: 'Cosy café', scene: 'held in a person\'s hand in a cosy café (only the hand and wrist in view, natural skin, relaxed grip that does not cover the important details), so its real size is obvious, the warm café interior softly blurred behind' },
    ],
    kind: 'held in one person\'s hand (only the hand and wrist in view, natural skin, a relaxed grip that does not cover the important details), a softly blurred background',
  },
  'xmas-tree': {
    look: 'Fir tree, warm fairy lights',
    variants: [
      { name: 'Nordic, white and silver', scene: 'hanging from a branch of a real Christmas tree (fresh green fir needles) decorated in a Nordic style with white and silver baubles, small wooden stars and tiny white lights, a bright, airy Scandinavian room softly blurred behind, soft winter daylight' },
      { name: 'Flocked tree, red and gold', scene: 'hanging from a branch of a snow-flocked Christmas fir decorated with red and gold baubles and tartan bows, a fireplace glowing warm in the blurred background, cosy evening light' },
    ],
    kind: 'a decorated Christmas tree: it hangs from a fir branch, with a few baubles and lights softly blurred around it',
  },
  'xmas-gifts': {
    look: 'Kraft paper, fairy lights',
    variants: [
      { name: 'Red and green, by the fire', scene: 'on a soft knitted blanket on the floor by a fireplace under a Christmas tree, next to a few gifts wrapped in red and green paper with gold ribbons, a knitted stocking and pine branches around, warm firelight' },
      { name: 'White and gold, daylight', scene: 'on a light wooden floor under a Christmas tree decorated in white and gold, next to a few gifts wrapped in white paper with gold satin ribbons, pine cones and dried orange slices around, bright, soft winter daylight' },
    ],
    kind: 'under a Christmas tree: a floor or low table it rests on, next to wrapped gifts and a few seasonal decorations, softly blurred',
  },
  'xmas-wall': {
    look: 'Garland over the mantel',
    variants: [
      { name: 'Nordic, warm white wall', scene: 'hanging in the middle of a wide stretch of warm white wall in a Scandinavian room decorated for Christmas, mounted flat at eye level well above a low light-wood sideboard with a small potted fir, paper stars and white candles softly blurred below it, soft winter daylight' },
      { name: 'Deep green wall, candlelight', scene: 'hanging in the middle of a wide stretch of deep green painted wall decorated for Christmas, mounted flat at eye level well above a dark wooden console with brass candlesticks, red berries and a eucalyptus garland softly blurred below it, warm candle-lit evening light' },
    ],
    kind: 'a wall decorated for Christmas: it hangs flat at eye level in the middle of a wide, plain stretch of wall, the festive decorations only well below it (on a mantel, sideboard or console), softly blurred',
  },
  fridge: {
    look: 'White or steel, bright kitchen',
    variants: [
      { name: 'Pastel retro fridge', scene: 'stuck in the middle of the wide, flat door of a pastel mint retro-style fridge in a cheerful kitchen, flat against the door at eye level, with a postcard held by another magnet softly blurred nearby, warm morning light' },
      { name: 'Matte black fridge', scene: 'stuck in the middle of the wide, flat door of a matte black fridge in a modern kitchen with light wood cabinets, flat against the door at eye level, with a small photo held by another magnet softly blurred nearby, soft daylight' },
    ],
    kind: 'a fridge door in a home kitchen: it sticks flat at eye level in the middle of the wide, flat door, another magnet or a photo softly blurred nearby',
  },
  restaurant: {
    look: 'Stylish restaurant, bokeh',
    variants: [
      { name: 'Sunny café terrace', scene: 'on a small round bistro table on a sunny café terrace, with an espresso cup and a croissant softly blurred beside it, a street with green trees softly blurred behind, bright late-morning light' },
      { name: 'Fine dining, white linen', scene: 'on a white linen tablecloth in an elegant fine-dining restaurant, with a wine glass, polished cutlery and a small candle softly blurred around it, warm, dim ambient light with soft bokeh' },
    ],
    kind: 'a table in a restaurant, café or bar: a table top it rests on, tableware softly blurred around it',
  },
  bedroom: {
    look: 'Calm bedroom, morning',
    variants: [
      { name: 'Boho, rattan and linen', scene: 'on a rattan bedside table in a bright boho bedroom, with a ceramic lamp and a small plant, a textured cream throw on the bed softly blurred behind, soft afternoon sun' },
      { name: 'Deep blue walls, evening', scene: 'on a dark wooden bedside table in a calm bedroom with deep blue walls, next to a small warm lamp glowing and a glass of water, velvet bedding softly blurred behind, warm evening lamp light' },
    ],
    kind: 'a bedroom: a bedside table it rests on, the bed softly blurred behind',
  },
  bathroom: {
    look: 'White tiles, bright',
    variants: [
      { name: 'Spa, stone and teak', scene: 'on a teak shelf in a calm, spa-like bathroom with natural stone walls, a rolled linen towel, a eucalyptus sprig and a stone soap dish softly blurred nearby, soft warm daylight' },
      { name: 'Green tiles, marble', scene: 'on a white marble shelf in front of glossy deep green tiles, with a brass tap and a small fern softly blurred nearby, bright, soft daylight' },
    ],
    kind: 'a bathroom: a clean shelf or sink edge it rests on, the bathroom softly blurred behind',
  },
  workshop: {
    look: 'Wooden bench, tidy workshop',
    variants: [
      { name: '3D printing corner', scene: 'on a clean white desk in a tidy maker\'s corner, with a 3D printer and a few filament spools softly blurred behind, bright daylight' },
      { name: 'Garage, steel bench', scene: 'on a steel-topped workbench in a clean garage workshop, with a red tool chest and neatly hung tools softly blurred behind, bright practical overhead light' },
    ],
    kind: 'a workshop: a workbench or work desk it rests on, tools or machines softly blurred behind',
  },
  gaming: {
    look: 'Dark desk, purple and blue RGB',
    variants: [
      { name: 'White setup, pastel light', scene: 'on a white gaming desk in an all-white setup, next to a white keyboard and headphones, with soft pastel pink and cyan accent light glowing in the blurred background' },
      { name: 'Retro gaming corner', scene: 'on a wooden desk in a retro gaming corner, next to a vintage console and its controller, with a warm orange and red neon glow (no signs) and an old CRT television softly blurred in the background' },
    ],
    kind: 'a gaming setup: a desk it rests on, gaming gear and accent lights softly blurred around it',
  },
  kids: {
    look: 'Bright, playful room',
    variants: [
      { name: 'Calm Montessori, natural wood', scene: 'in a calm Montessori-style kids\' room on a low natural-wood shelf, with wooden toys, a small plush animal and picture books softly blurred behind, soft warm daylight' },
      { name: 'Pastel room, clouds', scene: 'in a pastel kids\' room on a white play table, with a soft pink and mint wall with painted clouds, a play tent and plush toys softly blurred behind, gentle morning light' },
    ],
    kind: 'a kids\' room: a low shelf or play table it rests on, toys softly blurred behind',
  },
  car: {
    look: 'Modern car, daytime road',
    variants: [
      { name: 'Classic car, golden hour', scene: 'inside a classic car with a cream leather and polished wood dashboard, placed or mounted on the dashboard or centre console, with a sunny country road softly blurred through the windscreen, warm golden-hour light' },
      { name: 'City at night', scene: 'inside a modern car at night, placed or mounted on the dashboard or centre console, lit softly but clearly by the car\'s warm ambient light, with city lights glowing as soft bokeh through the windscreen' },
    ],
    kind: 'inside a car: placed or mounted on the dashboard or centre console, the view through the windscreen softly blurred',
  },
  flatlay: {
    look: 'Linen or concrete, small props',
    variants: [
      { name: 'White marble, minimal', scene: 'a top-down flat lay on a white marble surface, minimally styled with a sprig of eucalyptus and a small ceramic dish beside it, soft even daylight' },
      { name: 'Dark wood, cosy', scene: 'a top-down flat lay on a dark wooden table top, styled with the edge of a knitted throw, a cup of tea and a few dried leaves around it, warm soft light from the side' },
    ],
    kind: 'a top-down flat lay on a flat surface, styled with a few small related props around it',
  },
};

/** A preset's sub-scenes 1 to 3 (1 is its own scene). */
export function subScenes(id: string): SubScene[] {
  const preset = sceneById(id), looks = SUB_SCENES[id];
  if (!preset || !looks) return [];
  return [{ name: looks.look, scene: preset.scene }, ...looks.variants];
}
/** What a random sub-scene of a preset is: the kind of place, with what it must keep. */
export const sceneKind = (id: string) => SUB_SCENES[id]?.kind ?? sceneById(id)?.label.toLowerCase() ?? '';
/** A sub-scene's name: "Scandinavian, warm white", "Random". */
export const variantName = (id: string, v: SceneVariant = 1) => (v === 'random' ? 'Random' : subScenes(id)[v - 1]?.name ?? '');

/** The scene a request asks for: its sub-scene of the preset, the random scene written for it, or (none written) the image model told to invent one. */
function sceneText(b: PhotoRequest, preset: PhotoScene): string {
  const v = b.variant ?? 1;
  if (v !== 'random') return subScenes(preset.id)[v - 1]?.scene ?? preset.scene;
  if (b.sceneText?.trim()) return b.sceneText.trim();
  // A change or another size of a photo keeps its scene (the earlier photo shows it).
  if (b.from) return `the same setting as in the earlier photo (${sceneKind(preset.id)})`;
  return `invent a fresh setting of this kind: ${sceneKind(preset.id)}; clearly different from all of these: ${subScenes(preset.id).map((s, i) => `(${i + 1}) ${s.name}`).join(', ')}`;
}

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
    // A small piece in a setting written for a room comes out room-sized: the setting must suit its size.
    size && Math.max(...size) < 350
      ? `The product is small: ${mm(size[0])} × ${mm(size[1])} × ${mm(size[2])} mm (${familiar(size, size[2] < 0.25 * Math.min(size[0], size[1]))}). The photo is taken close to it, so write a setting for something this size: only what is right next to it shows, partly and softly blurred at the edges; no whole room, sofa or big furniture in full view${preset?.wall ? ', mostly plain wall around it' : ''}.`
      : null,
  ].filter((l) => l !== null).join('\n');
}

/** Claude's random scene, cleaned up: one phrase, no quotes or final full stop. */
export function parseWrittenScene(text: string): string {
  const s = text.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
  if (!s) throw new Error('Jig did not write a scene');
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
  /** A preset's sub-scene (1, its own scene, if left out). */
  variant?: SceneVariant;
  /** A random sub-scene's scene, as written for its first photo: a change or another size keeps it. */
  sceneText?: string;
  /** One of the shop set's photos (Shop photos): made at 2K, with what the shot shows in the prompt. */
  shop?: ShopShot;
  /** The sale size the photo shows (Design.sizes), kept with the photo. */
  saleSize?: { id: string; label: string; mm?: number };
  /**
   * With `from`: the same photo for another sale size. The photo to change is the scene to keep, of
   * the product at `base` size; the render (sent, or `from.render`) is the product at this size.
   */
  resize?: { base: { label?: string; size: Vec3 } };
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

/** POST /api/photo-scene { scene }: a random sub-scene of the preset, written by Claude. */
export interface PhotoSceneResponse { scene: string }

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
    if ((b.resize == null || b.change != null) && (typeof b.change !== 'string' || !b.change.trim() || b.change.length > MAX_NOTES_CHARS)) return `change: what to change in the photo, up to ${MAX_NOTES_CHARS} characters`;
  } else if (b.render == null) return 'render must be a PNG or JPEG image';
  if (typeof b.scene !== 'string' || (b.scene !== CUSTOM_SCENE && !sceneById(b.scene))) return `scene must be one of ${[...PHOTO_SCENES.map((s) => s.id), CUSTOM_SCENE].join(', ')}`;
  if (!PHOTO_ASPECTS.includes(b.aspect)) return `aspect must be one of ${PHOTO_ASPECTS.join(', ')}`;
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES_CHARS)) return `notes: text up to ${MAX_NOTES_CHARS} characters`;
  if (b.scene === CUSTOM_SCENE && !b.notes?.trim()) return 'Describe the custom scene';
  if (b.variant != null && (!SCENE_VARIANTS.includes(b.variant) || b.scene === CUSTOM_SCENE)) return `variant: a preset's sub-scene, one of ${SCENE_VARIANTS.join(', ')}`;
  if (b.sceneText != null && (b.variant !== 'random' || typeof b.sceneText !== 'string' || !b.sceneText.trim() || b.sceneText.length > MAX_SCENE_CHARS)) return `sceneText: the random sub-scene (variant 'random'), up to ${MAX_SCENE_CHARS} characters`;
  if (b.shop != null && !SHOP_SHOTS.includes(b.shop)) return `shop must be one of ${SHOP_SHOTS.join(', ')}`;
  const p = b.product;
  if (!p || typeof p.name !== 'string' || p.name.length > 200) return 'product.name: text up to 200 characters';
  if (p.description != null && (typeof p.description !== 'string' || p.description.length > 2000)) return 'product.description: text up to 2,000 characters';
  if (!Array.isArray(p.size) || p.size.length !== 3 || !p.size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000)) return 'product.size: [x, y, z] in mm';
  if (p.lithophane != null && typeof p.lithophane !== 'boolean') return 'product.lithophane: true or false';
  if (p.colors != null && (!Array.isArray(p.colors) || p.colors.length > 16 || !p.colors.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)))) return 'product.colors: up to 16 #rrggbb colours';
  return saleSizeProblem(b);
}

/** A stored image of a design (a photo or its render). */
export const PHOTO_URL = /^\/api\/designs\/[a-zA-Z0-9-]{8,64}\/images\/[0-9a-f]{32}\.(png|jpg|webp|gif)$/;

const mm = (v: number) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toString();

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
const SWITCH = 85, HAND = 190, PALM = 85, MUG = 95;
const times = (v: number, ref: number) => { const r = v / ref; return (r >= 10 ? Math.round(r) : +r.toFixed(r < 0.1 ? 2 : 1)).toString(); };

/** The product beside a light switch (a standard EU plate, about 85 mm square). */
export function vsSwitch(size: Vec3, faceOn: boolean): string {
  const [x, y, z] = size;
  return faceOn
    ? `it is about ${times(x, SWITCH)} times as wide and ${times(y, SWITCH)} times as tall as the switch`
    : `its longest side is about ${times(Math.max(x, y, z), SWITCH)} times the width of the switch`;
}
const vsHand = (size: Vec3) => {
  const longest = Math.max(...size);
  return `its longest side is about ${times(longest, HAND)} times the length of an adult hand (${HAND} mm) and ${times(longest, PALM)} times the width of its palm (${PALM} mm)`;
};
const vsMug = ([x, y, z]: Vec3) => `its longest side is about ${times(Math.max(x, y, z), MUG)} times the mug's height${z >= MUG / 2 && z < Math.max(x, y) ? ` and it stands about ${times(z, MUG)} times as tall as the mug` : ''}`;
/** How much wall a close photo of a small wall piece shows (cm, side to side), and how much of that it fills: told in numbers, else the image model shows the room and blows the piece up. */
const wallFrame = ([x, y]: Vec3, surface: string) => {
  const cm = Math.max(30, Math.round((Math.max(x, y) * 2.5) / 50) * 5);
  return `the picture shows only about ${cm} cm of ${surface} from side to side, so it fills about ${Math.round((Math.max(x, y) / (cm * 10)) * 100)}% of the width (never a whole room or a big piece of furniture in full view; anything below it shows only partly, at the bottom edge)`;
};

/** A thin, flat print (a LayerTone panel, a plaque, a coaster): the image model draws it as a thick slab unless told. */
const isThin = ([x, y, z]: Vec3) => z <= 10 && z < 0.08 * Math.min(x, y);
const thinLine = (z: number) => `It is a THIN, FLAT panel: only ${mm(z)} mm thick (${z <= 5 ? `about ${times(z, 2)} times as thick as a coin` : `about ${times(z, 8)} times as thick as a smartphone`}), so from any angle its edge is just a thin line. Never show it as a thick slab, block, box or canvas on a frame.`;

/** What a shop photo must show, beyond its scene. */
function shopLine(shot: ShopShot, scene: string, size: Vec3, faceOn: boolean): string | null {
  const thin = isThin(size);
  const whole = 'the whole product centred, filling about three quarters of the square frame, nothing cut off';
  switch (shot) {
    case 'main': return `THE MAIN LISTING PHOTO: ${whole}.`;
    case 'angle': return `A 3/4 VIEW FOR THE LISTING, showing ${thin ? 'how thin it is (its edge a thin line)' : 'its depth and thickness'}: ${whole}.`;
    case 'top': return `A HIGH VIEW FROM ABOVE FOR THE LISTING, showing its top: ${whole}.`;
    case 'detail': return 'A CLOSE-UP DETAIL PHOTO FOR THE LISTING: the render is cropped to part of the product, which goes on past the edges of the picture. Keep this close crop (do not show the whole product or shrink it to fit), so the surface, the edges and the fine detail of the print fill the photo, with a gentle depth of field.';
    case 'lifestyle': return null;
    case 'size': return scene === 'wall'
      ? `A SIZE PHOTO FOR THE LISTING: a standard white light switch (about ${SWITCH} mm square) beside it on the same wall, with free wall between them (never touching or overlapping it), both fully in view and in focus; ${vsSwitch(size, faceOn)}, so its real size is obvious at a glance.`
      : scene === 'hand'
      ? `A SIZE PHOTO FOR THE LISTING: the hand shows how big it is: ${vsHand(size)}; the product and the hand fully in view.`
      : `A SIZE PHOTO FOR THE LISTING: a plain coffee mug (about ${MUG} mm tall) beside it, both fully in view; ${vsMug(size)}, so its real size is obvious at a glance.`;
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
  const surface = b.scene === 'fridge' ? 'fridge door' : 'wall';
  // A flat print shown face-on: its face and thickness; otherwise the box as printed.
  const size = faceOn
    ? `${mm(x)} mm wide, ${mm(y)} mm tall and ${mm(z)} mm thick`
    : `${mm(x)} × ${mm(y)} mm footprint and ${mm(z)} mm high`;
  const what = [b.product.name.trim(), b.product.description?.trim()].filter(Boolean).join(' – ');
  return [
    'Turn the attached render into a photorealistic product photo of the real, 3D-printed object.',
    '',
    `THE PRODUCT${what ? `: ${what}` : ''}.`,
    `Real size: ${size} (${familiar(b.product.size, faceOn || z < 0.25 * Math.min(x, y))}). Show it at exactly this scale: everything around it in true proportion to it (a coffee mug is about 95 mm tall, a light switch about 85 mm wide, an adult hand about 190 mm long, a sofa about 2 m wide)${shop === 'detail' ? '' : ', and frame the photo around it so it is not lost in the room'}.`,
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
    '- any text, numbers, logos or patterns on it copied exactly from the render: the same typeface, letter shapes, stroke widths, spacing and position, letter for letter (never retyped in another font)',
    `- do not add, remove, move, mirror, bend or redesign any part; add nothing to it (no hardware, cords, stands, labels or decorations that are not in the render${hang ? ' – only the thin ribbon it hangs from' : ''})`,
    '- if the render shows several separate pieces (a set), they stay separate pieces, apart as in the render: never join, link, chain or tie them to each other',
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
    `SCENE: ${preset ? sceneText(b, preset) : notes}.`,
    // A small sign alone on a wall reads as a big one: give it something of known size beside it.
    wall && Math.max(x, y) < 350 && shop !== 'size'
      ? surface === 'wall'
        ? `It is a small piece for a wall: show a light switch (about ${SWITCH} mm square) or a small framed picture beside it on the same wall, with free wall between them, or a door frame further along, so its real size is obvious (${vsSwitch(b.product.size, faceOn)}), and photograph it from close by: ${wallFrame(b.product.size, surface)}.`
        : `It is a small piece: show the fridge's handle or another magnet beside it on the door, apart from it, so its real size is obvious, and photograph it from close by: ${wallFrame(b.product.size, surface)}.`
      : null,
    b.scene === 'hand' && shop !== 'size' ? `Against the hand: ${vsHand(b.product.size)}.` : null,
    shop ? shopLine(shop, b.scene, b.product.size, faceOn) : null,
    preset && notes ? `Also: ${notes}.` : null,
    wall
      ? `It hangs flat against the ${surface}, its back touching it, with a soft contact shadow, in light that matches the surroundings. It is entirely on a wide, flat, continuous stretch of ${surface} with a wide margin of free ${surface} on every side: it never crosses or touches ${surface === 'wall' ? 'a corner, pillar, edge, door or window frame, shelf or furniture' : 'an edge of the door, its handle or another magnet'}, and nothing overlaps it.`
      : hang
      ? 'It hangs freely from the branch on a thin red ribbon threaded through its own hanging hole or loop (tied around its top if it has none), straight down under its own weight, turned to face the camera, in light that matches the surroundings. A set of separate pieces: each piece on its own ribbon from its own branch, apart from the others.'
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
 * picture, as photoPrompt) that is the earlier photo (the second picture) with only the change
 * applied. Drawn again rather than patched, so the product follows its render; but everything the
 * change doesn't ask for stays as it was (told to compose afresh, the model redrew the whole scene
 * for a small fix). A new render (the design updated, or the view turned) changes only the product.
 */
export function photoEditPrompt(b: PhotoRequest): string {
  return [
    photoPrompt({ ...b, notes: undefined }),
    '',
    'THE PHOTO TO CHANGE: the second attached picture is an earlier photo of this product. Make it again with only THE CHANGE below: everything the change does not ask for stays exactly as in that photo (the composition and framing, where the product and each of its pieces are, their size and angle in the frame, the props, background, surface, colours and light). Where the instructions above say how to frame or set up the photo, keep the earlier photo instead.',
    'If the change asks to move, spread, turn or recompose things (e.g. "from above", "closer", "spread them out more"), do that, and keep the rest.',
    b.render
      ? 'The first attached picture is a new render of the product: show the product as in it (its design and the angle it is seen from), on the same spot in the scene, still matching the render exactly as said above.'
      : 'The product still matches the render (the first attached picture) exactly, as said above.',
    `THE CHANGE (the reason for the new photo – make it clearly): ${b.change!.trim()}.`,
    b.notes?.trim() ? `Earlier wishes that still apply: ${b.notes.trim()}.` : null,
  ].filter((l) => l !== null).join('\n');
}

// ---- Sale sizes (shared/sizes.ts): a scene photo for each size, all in the same scene.

/** What is wrong with a photo request's sale size fields, or null. */
function saleSizeProblem(b: PhotoRequest): string | null {
  const s = b.saleSize;
  if (s != null && (typeof s !== 'object' || typeof s.id !== 'string' || !s.id || s.id.length > 64 || typeof s.label !== 'string' || s.label.length > 24 || (s.mm != null && !(typeof s.mm === 'number' && s.mm > 0 && s.mm < 10000)))) return 'saleSize: { id, label } of one of the design\'s sizes';
  const r = b.resize;
  if (r == null) return null;
  if (!b.from) return 'resize: needs `from`, the photo of the other size whose scene is kept';
  if (!b.render && !b.from.render) return 'resize: needs the render of the product at this size';
  const base = typeof r === 'object' ? r.base : null;
  if (!base || typeof base !== 'object' || (base.label != null && (typeof base.label !== 'string' || base.label.length > 24))
    || !Array.isArray(base.size) || base.size.length !== 3 || !base.size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000)) return 'resize.base: { label, size: [x, y, z] in mm } of the photo whose scene is kept';
  return null;
}

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
  if (b.scene === 'hand') return { what: 'the hand (about 190 mm long)', dim: 'long', mm: 190, measure: longest, sure: true };
  if (preset?.wall) return { what: 'the light switch (about 85 mm wide)', dim: 'wide', mm: 85, measure: (s) => s[0], sure: b.shop === 'size' };
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
    photoPrompt({ ...b, notes: undefined }),
    '',
    `THIS PHOTO SHOWS ${label ? `THE ${label.toUpperCase()} SIZE` : 'ANOTHER SIZE'} OF THE PRODUCT: ${sizeWords(now, faceOn)}. The second attached picture is a photo of ${base.label ? `the ${base.label} size` : 'it in another size'}: ${sizeWords(base.size, faceOn)}.`,
    `So the product is ${ratioWords(now, base.size, faceOn)}.`,
    refLine,
    'THE SCENE TO KEEP EXACTLY: make the second attached picture again, as the same shot: the same place, wall, furniture, props, surface, colours and light, and the same camera position, angle, lens and framing. Nothing in the scene moves, grows, shrinks, appears or disappears; only the size of the product changes. Where the instructions above say how to frame the photo, keep the framing of the earlier photo instead.',
    `The product stays on the same spot (centred where it was, at the same height on the wall or in the same place on the surface) and ${bigger ? 'grows' : 'shrinks'} around it; the room and everything in it keep their real size, so the product takes up ${bigger ? 'more' : 'less'} of the picture than before.`,
    'The product itself (its shape, proportions, colours and details) is as in the first attached picture, its render at this size, not as in the earlier photo.',
    b.change?.trim() ? `Also: ${b.change.trim()}.` : null,
    b.notes?.trim() ? `Earlier wishes that still apply: ${b.notes.trim()}.` : null,
  ].filter((l) => l !== null).join('\n');
}
