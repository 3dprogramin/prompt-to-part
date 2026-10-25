// The photo API's requests and responses, and what is wrong with a request.
import type { ImageData } from '../api';
import type { Vec3 } from '../types';
import { CUSTOM_SCENE, IDEA_SCENE, MAX_NOTES_CHARS, MAX_SCENE_CHARS, PHOTO_ASPECTS, PHOTO_SCENES, sceneById, type PhotoAspect } from './scenes';
import type { SceneIdea } from './sceneWriter';
import { SCALE_REFS, SHOP_SHOTS, type ScaleRef, type ShopShot } from './shop';
import { SCENE_VARIANTS, type SceneVariant } from './subScenes';

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
