// Product photos: the image model turns a clean render of the model into a realistic listing photo
// of the printed product in a scene (on a table, on a wall, in a hand…).
export { BACKLIT_SCENE, CLOSEUP_SCENE, CUSTOM_SCENE, IDEA_SCENE, MAX_NOTES_CHARS, MAX_SCENE_CHARS, PHOTO_ASPECTS, PHOTO_SCENES, sceneById, SHOP_SCENE } from './photos/scenes';
export type { PhotoAspect, PhotoScene } from './photos/scenes';
export { SCENE_VARIANTS, sceneKind, subScenes, variantName } from './photos/subScenes';
export type { SceneVariant, SubScene } from './photos/subScenes';
export { IDEA_WRITER_PROMPT, ideaWriterPrompt, parseWrittenScene, SCENE_WRITER_PROMPT, sceneWriterPrompt, suggestScene, writtenPlace } from './photos/sceneWriter';
export type { SceneIdea } from './photos/sceneWriter';
export { SCALE_REFS, SHOP_IMAGE_SIZE, SHOP_SHOT_LABELS, SHOP_SHOTS, shopPlan } from './photos/shop';
export type { PhotoCamera, ScaleRef, ShopPlanItem, ShopShot } from './photos/shop';
export { MUG_SIZE, scaleRefLayout, SWITCH_PLATE } from './photos/trueScale';
export type { ScaleRefLayout, TrueScale } from './photos/trueScale';
export { PHOTO_URL, photoProblem } from './photos/request';
export type { PhotoRequest, PhotoResponse, PhotoSceneRequest, PhotoSceneResponse } from './photos/request';
export { familiar, vsSwitch } from './photos/scale';
export { photoEditPrompt, photoPrompt } from './photos/prompt';
export { sizeVariantPrompt } from './photos/sizeVariant';
