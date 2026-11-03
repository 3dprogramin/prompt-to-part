import { useEffect, useRef, useState } from 'react';
import { ideaModes, pickStarters, type Idea } from '../../../shared/ideas';
import { newIdeas } from '../../lib/api';
import { Icon } from '../Icon';
import { IMAGE_MODES, type ImageMode } from './PictureModeMenus';

/** The new-design screen's starter ideas, each marked with the picture mode it uses, and a link
 *  that asks Jig for four new ones. */
export function Starters(p: { artworkModel: string | null; meshy: boolean; claudeProblem: string | null; onPick: (mode: ImageMode, text: string, onScreen: string[]) => void }) {
  const artwork = !!p.artworkModel;
  const [ideas, setIdeas] = useState<Idea[]>(() => pickStarters(ideaModes({ artwork, meshy: p.meshy })));
  const [fetched, setFetched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // What this setup can do changed (a model or key arrived): new starters, unless Jig's own are shown.
  useEffect(() => {
    if (!fetched) setIdeas(pickStarters(ideaModes({ artwork, meshy: p.meshy })));
  }, [artwork, p.meshy]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await newIdeas(ideas.map((i) => i.text));
      if (!mounted.current) return;
      setIdeas(next);
      setFetched(true);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <>
      <div className="examples">
        {ideas.map((idea) => {
          const m = IMAGE_MODES.find((x) => x.mode === idea.mode);
          return (
            <button key={idea.text} className="example" onClick={() => p.onPick(idea.mode, idea.text, ideas.map((i) => i.text))}>
              {m && <span className="idea-mode"><Icon name={m.icon} size={12} />{m.short ?? m.label}</span>}
              <span>{idea.text}</span>
            </button>
          );
        })}
      </div>
      {!p.claudeProblem && (
        <button className="more-ideas" disabled={busy} onClick={more}>{busy ? 'Thinking…' : 'Give me 4 new ideas'}</button>
      )}
      {error && <p className="small dim" role="status">{error}</p>}
    </>
  );
}
