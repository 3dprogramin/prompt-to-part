// Product photo scenes: the aspects a photo can have and the preset places it can be in.

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
