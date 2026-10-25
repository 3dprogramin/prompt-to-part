// The composer's model and reasoning effort chip ("Opus 5.5 · High") and its menu.
import { useEffect } from 'react';
import { Icon } from '../Icon';
import { useChipMenu } from './useChipMenu';

const MODELS = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }];
const EFFORTS = [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'X-High' }, { id: 'max', label: 'Max' }];

/** The model and reasoning effort in one chip ("Opus 5.5 · High"), both chosen in its menu. */
export function ModelMenu({ model, effort, defaultModel, onModel, onEffort }: { model: string; effort: string; defaultModel: string; onModel: (m: string) => void; onEffort: (e: string) => void }) {
  const m = useChipMenu();
  // The server's starting model is offered too when it is a full model ID.
  const models = MODELS.some((x) => x.id === defaultModel) ? MODELS : [...MODELS, { id: defaultModel, label: modelLabel(defaultModel) }];
  const modelName = models.find((x) => x.id === model)?.label ?? modelLabel(model);
  const effortName = EFFORTS.find((x) => x.id === effort)?.label ?? effort;
  // "Opus 5.5": the family stays when the chip gets narrow, the version goes first.
  const [family, ...version] = modelName.split(' ');
  const full = `${modelName} · ${effortName}`;
  // Longer than "Opus · High": the credits badge beside it goes sooner (styles.css), so it rarely needs an ellipsis.
  const long = family.length + effortName.length > 8;
  useEffect(() => { if (m.open) m.menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, [m.open]);
  // Left and Right go between the two lists (to the chosen item); the other keys as in any menu.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const groups = [...(m.menu.current?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])];
      const other = groups.find((g) => !g.contains(document.activeElement));
      e.preventDefault();
      (other?.querySelector<HTMLElement>('[aria-checked="true"]') ?? other?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
      return;
    }
    m.onMenuKey(e);
  };
  // Choosing keeps the menu open (to set the other one too); choosing the chosen item again closes it.
  const pick = (current: string, id: string, set: (id: string) => void) => (id === current ? m.close() : set(id));
  const list = (label: string, head: string, items: { id: string; label: string }[], current: string, set: (id: string) => void) => (
    <div role="group" aria-label={label} className="model-group">
      <div className="model-group-head" aria-hidden>{head}</div>
      {items.map((x) => (
        <button key={x.id} role="menuitemradio" aria-checked={x.id === current} className={x.id === current ? 'on' : ''} onClick={() => pick(current, x.id, set)}>
          <span className="mode-check" aria-hidden>{x.id === current && <Icon name="check" size={13} />}</span>
          <span>{x.label}</span>
        </button>
      ))}
    </div>
  );
  return (
    <span className={`mode-wrap model-wrap ${long ? 'long' : ''}`} ref={m.wrap}>
      <button {...m.triggerProps} className="web-toggle model-btn" aria-label={`Model and reasoning effort: ${full}`} title={`Model and reasoning effort: ${full}. Click to choose.`}>
        <span className="model-icon" aria-hidden><Icon name="cpu" size={14} /></span>
        <span className="model-text" aria-hidden>
          <span className="model-name">{family}<span className="model-version">{version.length ? ` ${version.join(' ')}` : ''}</span></span><span className="model-sep">·</span><span className="model-effort">{effortName}</span>
        </span>
      </button>
      {m.open && (
        <div className="mode-menu model-menu" role="menu" aria-label="Model and reasoning effort" ref={m.menu} onKeyDown={onKey}>
          {list('Model', 'Model', models, model, onModel)}
          {list('Reasoning effort', 'Effort', EFFORTS, effort, onEffort)}
        </div>
      )}
    </span>
  );
}

/** "claude-opus-5-5" → "Opus 5.5"; other IDs as they are. */
function modelLabel(id: string) {
  const m = /^(?:anthropic\/)?claude-([a-z]+)-(\d+)[.-](\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}
