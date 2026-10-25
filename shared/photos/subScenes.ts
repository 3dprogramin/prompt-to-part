// Each preset scene's sub-scenes: its own look, two more of the same kind, or a random one.
import { BACKLIT_SCENE, CLOSEUP_SCENE, sceneById, SHOP_SCENE } from './scenes';

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
