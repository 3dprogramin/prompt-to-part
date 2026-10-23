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
  /** A close-up: the camera right by the product, its surface and detail filling the photo. */
  closeup?: boolean;
}

/** The scene for lithophanes: lit from behind, so the picture shows. */
export const BACKLIT_SCENE = 'backlit';
/** The scene of the shop set's studio photos: one light grey studio for every product, like one shoot. */
export const SHOP_SCENE = 'grey-studio';
/** The close-up scene: its render is cropped in on the product (PhotoCamera 'detail'). */
export const CLOSEUP_SCENE = 'closeup';

export const PHOTO_SCENES: PhotoScene[] = [
  { id: 'table', label: 'Wooden table', icon: 'table', scene: 'on a warm oak wooden table in a bright, cosy home interior, softly blurred background, natural window light from the side' },
  { id: 'wall', label: 'Living-room wall', icon: 'frame', wall: true, scene: 'hanging in the middle of a wide, plain stretch of light painted wall in a calm, modern living room, mounted flat against the wall at eye level, with a plant, a lamp or a picture frame softly blurred nearby, soft daylight' },
  { id: 'bedroom-wall', label: 'Bedroom wall', icon: 'bed', wall: true, scene: 'hanging in the middle of a wide, plain stretch of soft white-greige painted wall above the headboard in a calm, modern bedroom, mounted flat against the wall at eye level, with a bed with pillows, linen bedding and a folded throw softly blurred below it and a small bedside lamp to the side, soft morning light' },
  { id: 'kitchen', label: 'Kitchen counter', icon: 'cup', scene: 'on a clean kitchen counter (light stone or wood) in a bright modern kitchen, with a few kitchen things softly blurred in the background, morning light' },
  { id: 'office', label: 'Office desk', icon: 'desk', scene: 'on a tidy modern office desk with a laptop, a notebook and a pen softly blurred around it, daylight from a window' },
  { id: 'shelf', label: 'Shelf with plants', icon: 'plant', scene: 'on a wooden wall shelf styled with small potted green plants and a couple of books, Scandinavian look, soft natural light' },
  { id: 'studio', label: 'Plain studio', icon: 'studio', scene: 'on a seamless pure white studio sweep, a clean e-commerce product shot with soft, even studio light and a soft natural shadow under it' },
  { id: SHOP_SCENE, label: 'Grey studio', icon: 'studio', studio: true, scene: 'on a seamless light grey (#F3F3F3) studio sweep that curves up behind it with no visible horizon, no props and nothing else in the picture; soft, even light from a large softbox to the upper left and a white fill card to the right, so its shape reads clearly with gentle shading and no harsh highlights; a soft, natural contact shadow right under it. The same backdrop, light and camera for every product of the shop, so all its photos look like one shoot' },
  { id: 'garden', label: 'Outdoor / garden', icon: 'tree', scene: 'outdoors in a garden, on a weathered wooden garden table or a flat stone, green plants and sunlight blurred behind it, late-afternoon light' },
  { id: BACKLIT_SCENE, label: 'Backlit at night', icon: 'lamp', scene: 'standing on a bedside table or a windowsill in a dim, cosy room in the evening, with a warm LED light right behind it so the panel glows; the rest of the room in soft darkness with a few warm, blurred highlights' },
  { id: 'hand', label: 'Hand holding it', icon: 'hand', scene: 'held in a person\'s hand (only the hand and wrist in view, natural skin, relaxed grip that does not cover the important details), so its real size is obvious, plain softly blurred indoor background' },
  { id: CLOSEUP_SCENE, label: 'Close-up', icon: 'search', closeup: true, scene: 'a close-up on a light natural oak surface, the camera right next to it, only a little of the wood grain around it in view, everything beyond melting into a soft, creamy blur, soft directional daylight from the side that brings out its edges, relief and texture' },
  // Christmas (seasonal, so in the main list).
  { id: 'xmas-tree', label: 'On the Christmas tree', icon: 'bauble', hang: true, scene: 'hanging from a branch of a real, decorated Christmas tree (fresh green fir needles), next to a couple of glass baubles, with warm fairy lights glowing as soft bokeh in the blurred background, cosy evening light' },
  { id: 'xmas-gifts', label: 'Under the tree', icon: 'gift', scene: 'on a wooden floor or low table under a Christmas tree, next to a few gifts wrapped in kraft paper with red and white ribbons, pine branches and pine cones around, warm fairy lights glowing as soft bokeh behind, cosy evening light' },
  { id: 'xmas-wall', label: 'Christmas wall', icon: 'star', wall: true, scene: 'hanging in the middle of a wide stretch of light wall decorated for Christmas, mounted flat at eye level well above a sideboard or mantel with a fresh pine garland, warm fairy lights and a few candles softly blurred below it, cosy warm evening light' },
  { id: 'fridge', label: 'On the fridge', icon: 'fridge', wall: true, scene: 'stuck in the middle of the wide, flat door of a white or brushed-steel fridge in a bright home kitchen, flat against the door at eye level, with a child\'s drawing or a photo held by another magnet softly blurred nearby, soft daylight' },
  // Shown after "More scenes".
  { id: 'restaurant', label: 'Restaurant table', icon: 'fork', scene: 'on a table in a stylish restaurant or café, with a plate, a glass and cutlery softly blurred around it, warm ambient light and bokeh from the room behind' },
  { id: 'bedroom', label: 'Bedside table', icon: 'bed', scene: 'on a bedside table next to a book and a small lamp in a calm, softly lit bedroom, linen bedding softly blurred behind, warm morning light' },
  { id: 'bathroom', label: 'Bathroom shelf', icon: 'drop', scene: 'on a clean bathroom shelf or sink edge with white tiles, a folded towel and a small plant softly blurred nearby, bright, fresh daylight' },
  { id: 'workshop', label: 'Workshop bench', icon: 'wrench', scene: 'on a sturdy wooden workbench in a tidy maker workshop, with hand tools and a pegboard softly blurred behind, warm practical light' },
  { id: 'gaming', label: 'Gaming setup', icon: 'gamepad', scene: 'on a dark gaming desk next to a keyboard and a controller, with soft RGB accent light in purple and blue glowing in the blurred background' },
  { id: 'kids', label: 'Kids\' room', icon: 'blocks', scene: 'in a bright, playful kids\' room on a low white shelf or play table, with colourful toys and books softly blurred behind, cheerful daylight' },
  { id: 'car', label: 'In the car', icon: 'car', scene: 'inside a modern car, placed or mounted on the dashboard or centre console, with the windscreen and a softly blurred road view behind, natural daylight' },
  { id: 'flatlay', label: 'Flat lay', icon: 'grid', scene: 'a top-down flat lay on a light linen or concrete surface, neatly styled with a few small related props around it (leaves, a notebook, a coffee cup), soft even daylight' },
];
export const CUSTOM_SCENE = 'custom';
/** The user's short idea (in `notes`), written out by Claude into a detailed scene (`sceneText`) before the photo is asked for. */
export const IDEA_SCENE = 'idea';
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
  'bedroom-wall': {
    look: 'Calm modern, white-greige wall',
    variants: [
      { name: 'Japandi, light wood headboard', scene: 'hanging in the middle of a wide, plain stretch of warm off-white plastered wall above a light oak headboard in a calm Japandi bedroom, mounted flat against the wall at eye level, with a bed with natural linen bedding and a wool throw softly blurred below it and a paper lantern lamp on a low wooden nightstand to the side, soft diffused daylight' },
      { name: 'Deep green wall, warm lamp', scene: 'hanging in the middle of a wide, plain stretch of deep green matte painted wall above a bed in a moody, cosy bedroom, mounted flat against the wall at eye level, with velvet cushions and dark linen bedding softly blurred below it and a brass bedside lamp glowing to the side, warm low evening light' },
    ],
    kind: 'a bedroom wall: it hangs flat at eye level in the middle of a wide, plain, flat stretch of painted wall above the bed (no panelling, wallpaper pattern, shelves or frames behind it), the bed and a bedside lamp only below it or to the side, softly blurred',
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
  [CLOSEUP_SCENE]: {
    look: 'Light oak, soft side light',
    variants: [
      { name: 'Dark slate, warm raking light', scene: 'a close-up on a dark matte slate surface, the camera right next to it, only a little of the stone around it in view, the background falling off into a soft, dark blur, a warm low light from the side that rakes across it and picks out every edge, relief and layer line' },
      { name: 'White linen, bright and airy', scene: 'a close-up on a crisp white linen cloth with a fine, soft weave, the camera right next to it, only a little of the cloth around it in view, a bright, airy blur behind, soft diffused daylight from a window' },
    ],
    kind: 'a close-up: the camera right next to it on a plain surface (wood, stone, fabric, paper or similar), only a little of that surface in view, everything beyond softly blurred, light from the side that brings out its texture; no room, furniture or props in view',
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

/**
 * Something of known size the render shows beside the product at its true size (a size photo): a
 * light switch on the wall, a mug on the table. Image models copy the render's layout far better
 * than they follow numbers, so the photo keeps the scale.
 */
export const SCALE_REFS = ['switch', 'mug', 'wall'] as const;
export type ScaleRef = (typeof SCALE_REFS)[number];

export interface ShopPlanItem { shot: ShopShot; camera: PhotoCamera; scene: string; faceOn: boolean; scaleRef?: ScaleRef }

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
    // (On a wall, face-on: at true scale in its frame, so the room around it is to scale too.)
    { shot: 'lifestyle', camera: lifeFaceOn ? 'face' : 'angle', scene: lifestyle, faceOn: lifeFaceOn, ...(lifeFaceOn && sceneById(lifestyle)?.wall && lifestyle !== 'fridge' ? { scaleRef: 'wall' as const } : {}) },
    { shot: 'size', camera: wallPiece ? 'face' : 'angle', scene: size, faceOn: wallPiece, ...(size === 'hand' ? {} : { scaleRef: wallPiece ? 'switch' : 'mug' }) },
  ];
}

// The references' sizes (mm): a standard EU switch plate with a rocker, a plain coffee mug.
export const SWITCH_PLATE = { side: 85, depth: 10 };
export const MUG_SIZE = { diameter: 82, height: 95 };
/** The share of the render's width or height the product and its reference fill together. */
const REF_FILL = 0.7;
/** The share a wall piece fills alone on its wall at true scale (`wall`: no reference, room to show around it). */
const WALL_FILL = 0.45;

/** A render at true scale: the reference beside the product, and for a resize the product's size in the earlier photo (scaleRefLayout's `base`). */
export interface TrueScale { ref: ScaleRef; base?: Vec3 }

type Box = { min: Vec3; max: Vec3 };
export interface ScaleRefLayout {
  /** The reference's box (mm, the model's coordinates; the wall or the table is the plane z = the product's min z). */
  ref: Box;
  /** The box the render's camera frames: the wall or table area the picture shows. */
  frame: Box;
}

/**
 * Where the reference goes beside the product (its box, mm): a light switch on the wall to its
 * right, its centre a third of the way up the piece, with free wall between them; a mug on the
 * table beside it, along `side` (the render's right on the table, a unit vector), so it is as far
 * from the camera as the product. The frame shows both with free wall or table around them, for a
 * picture of `aspect` (width / height). `base`: the product's size in the earlier photo of another
 * sale size; the reference keeps its spot from that photo and the frame its area (moved or grown
 * only when this size would not fit), so only the product's size changes.
 */
export function scaleRefLayout(kind: ScaleRef, box: Box, aspect: number, o: { side?: [number, number]; base?: Vec3 } = {}): ScaleRefLayout {
  const own = [0, 1, 2].map((k) => box.max[k] - box.min[k]) as Vec3;
  const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, z = box.min[2];
  // The product centred on the same spot, at a size.
  const at = (s: Vec3): Box => ({ min: [cx - s[0] / 2, cy - s[1] / 2, z], max: [cx + s[0] / 2, cy + s[1] / 2, z + s[2]] });
  const place = (s: Vec3, clear: Vec3): Box => {
    // (The wall alone: nothing beside the product.)
    if (kind === 'wall') return { min: [cx, cy, z], max: [cx, cy, z] };
    if (kind === 'switch') {
      const side = SWITCH_PLATE.side;
      // At least 30 mm of free wall, more beside a bigger piece; never closer to this size than that.
      const x = Math.max(cx + s[0] / 2 + Math.max(30, 0.6 * s[0]), cx + clear[0] / 2 + 30) + side / 2;
      const y = cy - s[1] / 2 + s[1] / 3;
      return { min: [x - side / 2, y - side / 2, z], max: [x + side / 2, y + side / 2, z + SWITCH_PLATE.depth] };
    }
    const [ux, uy] = o.side ?? [1, 0], r = MUG_SIZE.diameter / 2;
    // How far the product reaches along the side, then a gap.
    const reach = (v: Vec3) => (Math.abs(ux) * v[0] + Math.abs(uy) * v[1]) / 2;
    const d = Math.max(reach(s) + Math.max(25, 0.15 * Math.max(s[0], s[1])), reach(clear) + 20) + r;
    const mx = cx + ux * d, my = cy + uy * d;
    return { min: [mx - r, my - r, z], max: [mx + r, my + r, z + MUG_SIZE.height] };
  };
  const ref = place(o.base ?? own, own);
  const union = (a: Box, b: Box): Box => ({ min: a.min.map((v, k) => Math.min(v, b.min[k])) as Vec3, max: a.max.map((v, k) => Math.max(v, b.max[k])) as Vec3 });
  // The area around a product and its reference: on the wall a rectangle of the picture's shape,
  // on the table their box grown about its middle.
  const around = (b: Box): Box => {
    const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2), half = [0, 1, 2].map((k) => (b.max[k] - b.min[k]) / 2 / (kind === 'wall' ? WALL_FILL : REF_FILL));
    if (kind !== 'mug') {
      const w = Math.max(half[0], half[1] * aspect);
      half[0] = w; half[1] = w / aspect; half[2] = (b.max[2] - b.min[2]) / 2;
    }
    return { min: c.map((v, k) => v - half[k]) as Vec3, max: c.map((v, k) => v + half[k]) as Vec3 };
  };
  const frame = around(union(box, ref));
  // A resize: the earlier photo's area, grown only if this size needs more.
  return { ref, frame: o.base ? union(around(union(at(o.base), place(o.base, o.base))), frame) : frame };
}

/** POST /api/designs/:id/photos */
export interface PhotoRequest {
  /** The clean render of the model (PNG or JPEG); with `from`, optional: a new angle for the product (else the photo's own render). */
  render?: ImageData;
  /** Change an existing photo instead of making a new one: its stored photo and render (/api/designs/:id/images/…), and what to change. */
  from?: { photo: string; render?: string };
  change?: string;
  /** A preset's id, 'custom' with the scene in `notes`, or 'idea' with the user's idea in `notes`. */
  scene: string;
  aspect: PhotoAspect;
  /** The custom scene, the idea, or extra wishes for a preset (light, mood, props). */
  notes?: string;
  /** A preset's sub-scene (1, its own scene, if left out). */
  variant?: SceneVariant;
  /**
   * A random sub-scene's scene, or the idea written out, as written for its first photo: a change or
   * another size keeps it. An idea without it (Jig couldn't write it out) goes in as written.
   */
  sceneText?: string;
  /** One of the shop set's photos (Shop photos): made at 2K, with what the shot shows in the prompt. */
  shop?: ShopShot;
  /** The render shows a light switch or a mug beside the product at its true size (scaleRefLayout), to keep as it is. */
  scaleRef?: ScaleRef;
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
    /** An open cut-out (line art): only its lines are material, the areas between them empty. */
    open?: boolean;
  };
}

/** POST /api/photo-scene: a random sub-scene of the preset, or for 'idea' the user's idea written out; both by Claude. */
export interface PhotoSceneRequest extends Partial<SceneIdea> { scene: string; size?: Vec3 }
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
  if (typeof b.scene !== 'string' || (b.scene !== CUSTOM_SCENE && b.scene !== IDEA_SCENE && !sceneById(b.scene))) return `scene must be one of ${[...PHOTO_SCENES.map((s) => s.id), CUSTOM_SCENE, IDEA_SCENE].join(', ')}`;
  if (!PHOTO_ASPECTS.includes(b.aspect)) return `aspect must be one of ${PHOTO_ASPECTS.join(', ')}`;
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > MAX_NOTES_CHARS)) return `notes: text up to ${MAX_NOTES_CHARS} characters`;
  if (b.scene === CUSTOM_SCENE && !b.notes?.trim()) return 'Describe the custom scene';
  if (b.scene === IDEA_SCENE && !b.notes?.trim()) return 'Describe your idea for the scene';
  if (b.variant != null && (!SCENE_VARIANTS.includes(b.variant) || !sceneById(b.scene))) return `variant: a preset's sub-scene, one of ${SCENE_VARIANTS.join(', ')}`;
  if (b.sceneText != null && ((b.variant !== 'random' && b.scene !== IDEA_SCENE) || typeof b.sceneText !== 'string' || !b.sceneText.trim() || b.sceneText.length > MAX_SCENE_CHARS)) return `sceneText: the random sub-scene (variant 'random') or the idea written out, up to ${MAX_SCENE_CHARS} characters`;
  if (b.shop != null && !SHOP_SHOTS.includes(b.shop)) return `shop must be one of ${SHOP_SHOTS.join(', ')}`;
  if (b.scaleRef != null && !SCALE_REFS.includes(b.scaleRef)) return `scaleRef must be one of ${SCALE_REFS.join(', ')}`;
  const p = b.product;
  if (!p || typeof p.name !== 'string' || p.name.length > 200) return 'product.name: text up to 200 characters';
  if (p.description != null && (typeof p.description !== 'string' || p.description.length > 2000)) return 'product.description: text up to 2,000 characters';
  if (!Array.isArray(p.size) || p.size.length !== 3 || !p.size.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 10000)) return 'product.size: [x, y, z] in mm';
  if (p.lithophane != null && typeof p.lithophane !== 'boolean') return 'product.lithophane: true or false';
  if (p.open != null && typeof p.open !== 'boolean') return 'product.open: true or false';
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
const SWITCH = SWITCH_PLATE.side, HAND = 190, PALM = 85, MUG = MUG_SIZE.height;
/** A picture's width / height: '4:5' is 0.8. */
const aspectOf = (a: string | undefined) => { const [w, h] = (a ?? '1:1').split(':').map(Number); return w > 0 && h > 0 ? w / h : 1; };
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
    case 'angle': return `A 3/4 VIEW FOR THE LISTING, showing ${thin ? 'how thin it is (its edge a thin line)' : 'its depth and thickness'}: ${whole}.`;
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
function writtenIdea(b: PhotoRequest): { scene: string; place: ReturnType<typeof writtenPlace> } | null {
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
      ? ref === 'wall' ? '- the plain wall in the render is not part of the product: it shows its true size in the frame (see below)'
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
    ref && shop !== 'size' ? trueScaleLine(ref, b.product.size, faceOn, false, aspectOf(b.aspect))
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
const wishesApart = (b: PhotoRequest): PhotoRequest => (sceneById(b.scene) ? { ...b, notes: undefined } : b);

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
