// Shop photos: the set of listing photos made for one product, the render angle of each and the
// reference of known size its size photo shows.
import type { Vec3 } from '../types';
import { sceneById, SHOP_SCENE } from './scenes';

/** The camera of the render a photo is made from (Viewer.photo): the app's own angles; 'current' is the view's. */
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
    // (A wall piece from the side on a plain wall: floating, it came out standing on its edge, leaning.)
    { shot: 'angle', camera: 'angle', scene: SHOP_SCENE, faceOn: false, ...(wallPiece ? { scaleRef: 'wall' as const } : {}) },
    flat ? { shot: 'detail', camera: 'detail', scene: SHOP_SCENE, faceOn: true } : { shot: 'top', camera: 'top', scene: SHOP_SCENE, faceOn: false },
    // (On a wall, face-on: at true scale in its frame, so the room around it is to scale too.)
    { shot: 'lifestyle', camera: lifeFaceOn ? 'face' : 'angle', scene: lifestyle, faceOn: lifeFaceOn, ...(lifeFaceOn && sceneById(lifestyle)?.wall && lifestyle !== 'fridge' ? { scaleRef: 'wall' as const } : {}) },
    { shot: 'size', camera: wallPiece ? 'face' : 'angle', scene: size, faceOn: wallPiece, ...(size === 'hand' ? {} : { scaleRef: wallPiece ? 'switch' : 'mug' }) },
  ];
}
