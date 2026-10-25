// What the photos panel shows and names: the formats, a photo's scene, shot and sub-scene in
// words, its file's place in a shop set, sizes and costs; and a random scene written by Claude.
import type { Vec3 } from '../../../shared/types';
import { CUSTOM_SCENE, IDEA_SCENE, SCENE_VARIANTS, SHOP_SHOT_LABELS, SHOP_SHOTS, sceneById, sceneKind, variantName, type PhotoAspect, type PhotoRequest, type SceneIdea, type SceneVariant, type ShopShot } from '../../../shared/photos';
import { api } from '../../lib/api';

export const ASPECT_RATIO: Record<PhotoAspect, number> = { '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 };
export const ASPECT_HINT: Record<PhotoAspect, string> = { '1:1': 'Square', '4:5': 'Portrait, for shop listings', '16:9': 'Wide, for banners' };
export const sceneLabel = (id: string) => sceneById(id)?.label ?? 'Your idea';
export const shopShot = (shot?: string) => (SHOP_SHOTS as readonly string[]).includes(shot ?? '') ? shot as ShopShot : undefined;
/** A photo's (or request's) sub-scene, as a request or a photo keeps it: sub-scene 1 is left out; an idea's scene as written. */
export const lookOf = (x: { scene: string; variant?: SceneVariant; sceneText?: string }): Pick<PhotoRequest, 'variant' | 'sceneText'> =>
  x.scene === IDEA_SCENE ? (x.sceneText ? { sceneText: x.sceneText } : {})
  : x.variant && x.variant !== 1 && SCENE_VARIANTS.includes(x.variant) ? { variant: x.variant, ...(x.variant === 'random' && x.sceneText ? { sceneText: x.sceneText } : {}) } : {};
/** A photo's sub-scene in words: "Sub-scene 2: Scandinavian, warm white", the random scene written for it, or the idea's. */
export const lookTitle = (ph: { scene: string; variant?: SceneVariant; sceneText?: string }) => {
  if (ph.scene === IDEA_SCENE) return ph.sceneText ? `Written out by Jig: ${ph.sceneText}` : 'Your idea as you wrote it (Jig couldn\'t write it out)';
  if (ph.scene === CUSTOM_SCENE) return 'Your idea as you wrote it (Improve your idea was off)';
  const v = lookOf(ph).variant;
  return !v ? undefined : v === 'random' ? `Random setting: ${ph.sceneText ?? `one the image model invented (${sceneKind(ph.scene)})`}` : `Sub-scene ${v}: ${variantName(ph.scene, v)}`;
};
/** A random sub-scene's setting or the idea written out, by Claude; none (the image model invents it, or gets the idea as written) when Jig can't reach Claude. */
export const writeScene = (scene: string, size?: Vec3, idea?: SceneIdea) => api.photoScene(scene, size, idea).catch(() => undefined);
/** A photo's name: its scene, or for a shop set's photo its shot; and the sale size it shows. */
export const photoLabel = (scene: string, shop?: string, size?: string) => { const s = shopShot(shop); return (s ? `Shop · ${SHOP_SHOT_LABELS[s]}` : sceneLabel(scene)) + (size ? ` · ${size}` : ''); };
/** The shop shots that are the same for every sale size (the shape is the same; the size doesn't show). */
export const STUDIO_SHOTS: readonly string[] = ['main', 'angle', 'top', 'detail'];
/** The design was changed since a photo was made from it: what a refresh asks for. */
export const UPDATED = 'The design was updated since the earlier photo: show the product exactly as in the new render';
export const mmText = (v: number) => (v >= 100 ? Math.round(v) : +v.toFixed(1)).toString();
/** A shop photo's place in the set, for its file name (the order a listing shows them in). */
export const SHOP_ORDER: Record<ShopShot, number> = { main: 1, angle: 2, top: 3, detail: 3, lifestyle: 4, size: 5 };
export const money = (usd: number | null) => (usd == null ? 'cost unknown' : `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`);
