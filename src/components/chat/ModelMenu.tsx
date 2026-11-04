// The composer's model and reasoning effort chip ("Opus 5.5 · High") and its menu. Through
// OpenRouter the model list is OpenRouter's: its top models, a search box and "Show more".
import { useEffect, useState } from 'react';
import type { OpenRouterModel } from '../../../shared/api';
import { api } from '../../lib/api';
import { Icon } from '../Icon';
import { useChipMenu } from './useChipMenu';

const MODELS = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }];
const EFFORTS = [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'X-High' }, { id: 'max', label: 'Max' }];
/** How many more models "Show more" adds (and a search shows at first). */
const PAGE = 20;

interface Item { id: string; label: string; price?: string }

/** The model and reasoning effort in one chip ("Opus 5.5 · High"), both chosen in its menu. */
export function ModelMenu({ model, effort, defaultModel, openRouter = false, onModel, onEffort }: { model: string; effort: string; defaultModel: string; openRouter?: boolean; onModel: (m: string) => void; onEffort: (e: string) => void }) {
  const m = useChipMenu();
  const or = useOpenRouterModels(openRouter);
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(0);
  useEffect(() => { if (!m.open) { setQuery(''); setMore(0); } }, [m.open]);
  // The server's starting model is offered too when it is a full model ID.
  const claudeModels = MODELS.some((x) => x.id === defaultModel) ? MODELS : [...MODELS, { id: defaultModel, label: modelLabel(defaultModel) }];
  const known = or.models?.find((x) => x.id === model);
  const modelName = known?.name ?? claudeModels.find((x) => x.id === model)?.label ?? modelLabel(model);
  const effortName = EFFORTS.find((x) => x.id === effort)?.label ?? effort;
  // "Opus 5.5": the family stays when the chip gets narrow, the version goes first.
  const [family, ...version] = modelName.split(' ');
  const full = `${modelName} · ${effortName}`;
  // Longer than "Opus · High": the credits badge beside it goes sooner (styles.css), so it rarely needs an ellipsis.
  const long = family.length + effortName.length > 8;
  useEffect(() => { if (m.open) m.menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, [m.open]);

  // Through OpenRouter: the top models (plus the chosen one), or what the search finds, a page at a time.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = or.models && (words.length ? or.models.filter((x) => words.every((w) => `${x.id} ${x.fullName}`.toLowerCase().includes(w))) : null);
  const featured = or.models?.filter((x) => x.featured) ?? [];
  const rest = found ?? or.models?.filter((x) => !x.featured) ?? [];
  const shown = found ? found.slice(0, PAGE + more) : [...featured, ...rest.slice(0, more)];
  const left = found ? found.length - shown.length : rest.length - more;
  const current = !found && !shown.some((x) => x.id === model) ? [{ id: model, label: modelName }] : [];
  const orItems: Item[] = [...current, ...shown.map((x) => ({ id: x.id, label: x.name, price: perMillion(x) }))];

  // Left and Right go between the two lists (to the chosen item); the other keys as in any menu.
  // In the search box the keys type, except Down (to the first model) and Tab.
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).classList.contains('model-search')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); m.menu.current?.querySelector<HTMLElement>('.model-list [role^="menuitem"]')?.focus(); }
      else if (e.key === 'Tab') m.onMenuKey(e);
      return;
    }
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
  const pick = (cur: string, id: string, set: (id: string) => void) => (id === cur ? m.close() : set(id));
  const rows = (items: Item[], cur: string, set: (id: string) => void) => items.map((x) => (
    <button key={x.id} role="menuitemradio" aria-checked={x.id === cur} className={x.id === cur ? 'on' : ''} onClick={() => pick(cur, x.id, set)} title={x.price ? `${x.id}: ${x.price} per million tokens (in / out)` : undefined}>
      <span className="mode-check" aria-hidden>{x.id === cur && <Icon name="check" size={13} />}</span>
      <span className="model-row-text">
        <span className="model-row-name">{x.label}</span>
        {x.price && <span className="model-price">{x.price}</span>}
      </span>
    </button>
  ));
  const list = (label: string, head: string, items: Item[], cur: string, set: (id: string) => void) => (
    <div role="group" aria-label={label} className="model-group">
      <div className="model-group-head" aria-hidden>{head}</div>
      {rows(items, cur, set)}
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
        <div className={`mode-menu model-menu ${openRouter ? 'openrouter' : ''}`} role="menu" aria-label="Model and reasoning effort" ref={m.menu} onKeyDown={onKey}>
          {openRouter ? (
            <div role="group" aria-label="Model" className="model-group">
              <div className="model-group-head" aria-hidden>Model · OpenRouter</div>
              <input className="model-search" type="search" placeholder="Search models" aria-label="Search OpenRouter models" value={query}
                onChange={(e) => { setQuery(e.target.value); setMore(0); }} />
              <div className="model-list">
                {rows(orItems, model, onModel)}
                {or.loading && <div className="model-note">Loading models…</div>}
                {or.error && (
                  <div className="model-note error">
                    Couldn't load the models. <button role="menuitem" className="link-btn" onClick={or.retry}>Retry</button>
                  </div>
                )}
                {found && !found.length && <div className="model-note">No model matches.</div>}
                {left > 0 && <button role="menuitem" className="model-more" onClick={() => setMore(more + PAGE)}>Show more ({left})</button>}
              </div>
            </div>
          ) : list('Model', 'Model', claudeModels, model, onModel)}
          {list('Reasoning effort', 'Effort', EFFORTS, effort, onEffort)}
        </div>
      )}
    </span>
  );
}

// OpenRouter's list, loaded once for the page (the server keeps it for an hour).
let loaded: Promise<OpenRouterModel[]> | null = null;

/** OpenRouter's models when the menu offers them: loaded on first use, with a retry after a failure. */
function useOpenRouterModels(on: boolean) {
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    setError(false);
    loaded ??= api.models().then((r) => r.models);
    loaded.then((list) => { if (live) setModels(list); }, () => { loaded = null; if (live) setError(true); });
    return () => { live = false; };
  }, [on, attempt]);
  return { models: on ? models : null, loading: on && !models && !error, error: on && error, retry: () => setAttempt((a) => a + 1) };
}

/** "$0.05 / $0.50": the price per million input and output tokens. */
function perMillion(x: OpenRouterModel) {
  const f = (usd: number) => {
    const v = usd * 1e6;
    if (v === 0) return 'free';
    return `$${v < 0.1 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : Number(v.toPrecision(3))}`;
  };
  return `${f(x.pricing.prompt)} / ${f(x.pricing.completion)}`;
}

/** "claude-opus-5-5" → "Opus 5.5"; other IDs without their provider ("deepseek-v4.1-flash"). */
function modelLabel(id: string) {
  const m = /^(?:anthropic\/)?claude-([a-z]+)-(\d+)[.-](\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id.replace(/^~?[^/]+\//, '');
}
