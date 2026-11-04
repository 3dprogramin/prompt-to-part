// The photos panel's scene: the scenes to pick from (searched on "More scenes"), Your idea, the
// scene's variant, the extra details or the idea written, and Improve your idea.
import type { Dispatch, SetStateAction } from 'react';
import { IDEA_SCENE, MAX_NOTES_CHARS, PHOTO_SCENES, SCENE_VARIANTS, variantName, type PhotoScene, type SceneVariant } from '../../../shared/photos';
import { Icon } from '../Icon';

type Choice = { scene: string; notes: string; variant: SceneVariant };

interface Props {
  /** The panel's id, for its labels. */
  id: string;
  allScenes: boolean; setAllScenes: Dispatch<SetStateAction<boolean>>;
  sceneQuery: string; setSceneQuery: Dispatch<SetStateAction<string>>;
  /** The search, folded (foldText). */
  q: string;
  shownScenes: PhotoScene[];
  pickScene: (scene: string) => void;
  choice: Choice; setChoice: (patch: Partial<Choice>) => void;
  suggested: string;
  preset: PhotoScene | undefined;
  /** Your idea is picked: written out in detail (`idea`) or as written (`custom`). */
  own: boolean; idea: boolean; custom: boolean;
  improve: boolean; setImprove: Dispatch<SetStateAction<boolean>>;
}

/** The scene a photo is made in (PhotosPanel). */
export function ScenePicker({ id, allScenes, setAllScenes, sceneQuery, setSceneQuery, q, shownScenes, pickScene, choice, setChoice, suggested, preset, own, idea, custom, improve, setImprove }: Props) {
  return (
    <>
      <div className="ph-label" id={`${id}-scene`}>Scene</div>
      {allScenes && (
        <div className="menu-search ph-scene-search">
          <Icon name="search" size={13} />
          <input autoFocus type="search" placeholder="Search scenes, e.g. wall, christmas, marble" aria-label="Search scenes" value={sceneQuery}
            onChange={(e) => setSceneQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q && shownScenes[0]) pickScene(shownScenes[0].id); }} />
          {sceneQuery && <button className="icon-btn" title="Clear the search" aria-label="Clear the search" onClick={() => setSceneQuery('')}><Icon name="x" size={12} /></button>}
        </div>
      )}
      <div className="ph-scenes" role="radiogroup" aria-labelledby={`${id}-scene`}>
        {[...shownScenes, { id: IDEA_SCENE, label: 'Your idea…', icon: 'spark', hint: 'Describe the scene yourself: a few words are written out in detail, or (Improve your idea off) it goes to the image model as you write it' }].map((s) => (
          <button key={s.id} role="radio" aria-checked={s.id === IDEA_SCENE ? own : choice.scene === s.id} className={(s.id === IDEA_SCENE ? own : choice.scene === s.id) ? 'on' : ''} onClick={() => pickScene(s.id)}
            title={'hint' in s ? s.hint : s.id === suggested ? `${s.label}: suggested for this design` : s.label}>
            <Icon name={s.icon} size={18} />
            <span>{s.label}</span>
            {s.id === suggested && <i className="ph-suggested" aria-label="suggested">★</i>}
          </button>
        ))}
      </div>
      {allScenes && q && !shownScenes.length && <div className="dim small">No scene matches "{sceneQuery.trim()}": Your idea… makes any scene you describe.</div>}
      <button className="ph-more" onClick={() => { setAllScenes(!allScenes); setSceneQuery(''); }}>
        {allScenes ? 'Fewer scenes' : `More scenes (${PHOTO_SCENES.length - shownScenes.length} more)`}
      </button>
      {preset && (
        <div className="ph-row">
          <span className="ph-label" id={`${id}-look`}>Variant</span>
          <div className="seg ph-variants" role="radiogroup" aria-labelledby={`${id}-look`}>
            {SCENE_VARIANTS.map((v) => (
              <button key={v} role="radio" aria-checked={choice.variant === v} className={choice.variant === v ? 'on' : ''} onClick={() => setChoice({ variant: v })}
                aria-label={v === 'random' ? 'Random' : `${v}: ${variantName(preset.id, v)}`}
                title={v === 'random' ? `Random: a fresh ${preset.label.toLowerCase()} setting, new for each photo` : `${v}: ${variantName(preset.id, v)}${v === 1 ? ' (the scene as it was)' : ''}`}>
                {v === 'random' ? <Icon name="dice" size={13} /> : v}
              </button>
            ))}
          </div>
          <span className="dim small ph-variant-name">{variantName(preset.id, choice.variant)}</span>
        </div>
      )}
      <textarea className="text-param ph-notes" rows={own ? 3 : 2} maxLength={MAX_NOTES_CHARS} value={choice.notes} onChange={(e) => setChoice({ notes: e.target.value })}
        aria-label={own ? 'Your idea for the scene' : 'Extra details (optional)'}
        placeholder={custom ? 'Describe the scene, e.g. "on a bedside table next to a book, warm evening lamp light"' : idea ? 'A few words, e.g. "cosy cabin, snowy evening"' : 'Extra details (optional), e.g. "autumn leaves around it", "evening light"'} />
      {own && (
        <label className="switch ph-improve" title="On: your few words are written out into a detailed scene (shown on the photo). Off: the image model gets your text exactly as you wrote it.">
          <input type="checkbox" checked={improve} onChange={(e) => setImprove(e.target.checked)} />
          <span className="track" />
          <span className="switch-label">Improve your idea</span>
        </label>
      )}
    </>
  );
}
