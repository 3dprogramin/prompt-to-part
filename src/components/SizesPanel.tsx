import { useEffect, useState } from 'react';
import { AXIS_NAMES, MAX_SIZES, MAX_SIZE_LABEL, sizeText, type DesignSize } from '../../shared/sizes';
import { costOf, duration, money, type CostSettings } from '../../shared/cost';
import type { EvalResult } from '../../shared/types';
import { STAGE_TEXT } from '../hooks/useCost';
import type { SizesControls } from '../hooks/useSizes';
import { Icon } from './Icon';

interface Props {
  sizes: SizesControls;
  result: EvalResult;
  /** The Cost tab's prices. */
  costSettings: CostSettings;
  /** Bambu Studio is installed (slicing needs it). */
  bambu: boolean;
}

const AXIS_CLASS = ['axis-x', 'axis-y', 'axis-z'];

/**
 * Sale sizes (Object tab, under Overall size): the sizes the design is sold in, each given by its
 * main dimension and built for real (its W × D × H shown), one at a time in the 3D view, and sliced
 * one after the other for the print time, grams and cost of each.
 */
export function SizesPanel({ sizes: z, result, costSettings, bambu }: Props) {
  const list = z.sizes;
  // Each size is built for the design as it is: the ones out of date are built again, after a
  // moment's pause (a slider being dragged changes the design many times).
  const stale = list.filter((s) => !z.resolvedOf(s)).map((s) => `${s.id}:${s.mm}`).join(',');
  useEffect(() => {
    if (!stale) return;
    const t = setTimeout(() => { for (const s of list) if (!z.resolvedOf(s)) void z.resolve(s); }, 600);
    return () => clearTimeout(t);
  }, [stale, result]);
  const axis = z.axis ?? 0;
  const how = list.map((s) => z.resolvedOf(s)?.how).find(Boolean);
  const drivers = Object.values(result.params).filter((d) => (d.type === 'number' || d.type === 'integer') && d.drives).map((d) => d.label ?? '').filter(Boolean);
  const slicing = z.slicing;
  const sliced = list.some((s) => z.sliceOf(s));
  // Sizes go from small to big; another size is never changed to keep them so, only pointed out.
  const wrong = list.findIndex((s, k) => k > 0 && s.mm <= list[k - 1].mm);
  const outOfOrder = wrong > 0 ? `${list[wrong].label} (${list[wrong].mm} mm) is not bigger than ${list[wrong - 1].label} (${list[wrong - 1].mm} mm).` : null;

  return (
    <section className="param-group sizes">
      <h4>Sale sizes <span className="h4-hint">sell it in several sizes</span></h4>
      {!list.length && (
        <>
          <div className="dim small">Sizes like S, M and L, each the model at another {AXIS_NAMES[axis]} ({['width', 'depth', 'height'][axis]}), with its own print time, grams and cost, and its own photos.</div>
          <button className="btn ghost wide" disabled={!z.base} onClick={() => void z.suggest()}><Icon name="ruler" size={14} /> Suggest S / M / L</button>
        </>
      )}
      {list.length > 0 && (
        <div className="size-rows" role="list">
          {list.map((s, i) => {
            const r = z.resolvedOf(s);
            const on = z.viewed?.id === s.id;
            return (
              <div key={s.id} className={`size-row ${on ? 'on' : ''}`} role="listitem">
                <button className="icon-btn size-eye" aria-pressed={on} onClick={() => z.view(on ? null : s.id)}
                  title={on ? 'Back to the design as it is' : 'Show this size in the 3D view'} aria-label={on ? `Stop showing size ${s.label}` : `Show size ${s.label} in the 3D view`}>
                  <Icon name="eye" size={13} />
                </button>
                <LabelInput value={s.label} onCommit={(v) => z.rename(s.id, v)} name={`Name of size ${i + 1}`} />
                <MmInput value={s.mm} axisClass={AXIS_CLASS[s.axis]} onCommit={(v) => void z.setMm(s.id, v)} name={`${AXIS_NAMES[s.axis]} of size ${s.label}, mm`} />
                <span className="size-dims mono small" title={r ? `${sizeText(r.size)}${r.note ? `: ${r.note}` : ''}` : undefined}>
                  {r ? <>{sizeText(r.size, false)}{r.note ? <Icon name="alert" size={11} /> : null}</>
                    : z.errors[s.id] ? <span className="bad-text" title={z.errors[s.id]}>failed</span>
                    : <span className="spinner" aria-label="building this size" />}
                </span>
                <button className="icon-btn" onClick={() => z.remove(s.id)} title="Remove this size" aria-label={`Remove size ${s.label}`}><Icon name="x" size={12} /></button>
              </div>
            );
          })}
        </div>
      )}
      {list.length > 0 && (
        <div className="size-actions">
          <button className="btn ghost small-btn" disabled={list.length >= MAX_SIZES || !z.base} onClick={() => void z.add()}><Icon name="plus" size={12} /> Add size</button>
          <span className="dim small size-how">
            {how === 'params' ? `${AXIS_NAMES[axis]} through ${drivers.join(', ') || 'its parameters'}`
              : how === 'face' ? 'Scaled across its face; the thickness stays'
              : how === 'scale' ? 'Scaled as a whole (Scale %)' : ''}
          </span>
        </div>
      )}
      {list.some((s) => z.clamped[s.id] || z.resolvedOf(s)?.note) && (
        <div className="size-note bad" role="note">{list.filter((s) => z.clamped[s.id] || z.resolvedOf(s)?.note).map((s) => `${s.label}: ${z.clamped[s.id] ?? z.resolvedOf(s)!.note}`).join(' ')}</div>
      )}
      {outOfOrder && (
        <div className="size-note bad" role="note">
          {outOfOrder}{' '}<button className="link" onClick={z.sort}>Sort by size</button>
        </div>
      )}

      {list.length > 0 && (
        <>
          <table className="kv sizes-table">
            <thead><tr><th>Size</th><th>Print time</th><th>Filament</th><th>Cost</th></tr></thead>
            <tbody>
              {list.map((s) => {
                const stats = z.sliceOf(s);
                const busy = slicing?.sizeId === s.id;
                return (
                  <tr key={s.id}>
                    <th>{s.label}</th>
                    {stats
                      ? <><td className="mono">{duration(stats.seconds)}</td><td className="mono">{stats.grams.toFixed(1)} g</td><td className="mono">{money(costOf(stats, costSettings).total)}</td></>
                      : <td colSpan={3} className="dim small">{busy ? <><span className="spinner" /> {STAGE_TEXT[slicing!.stage].split(' (')[0]}…</> : z.errors[s.id] && z.resolvedOf(s) ? <span className="bad-text" title={z.errors[s.id]}>{z.errors[s.id]}</span> : s.slice ? 'changed since it was sliced' : 'not sliced yet'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!bambu && <div className="dim small">Needs Bambu Studio installed: the grams and print times come from slicing each size in it.</div>}
          {bambu && (slicing
            ? <div className="size-slicing" role="status">
                <span className="spinner" /> <span>Slicing {list.find((s) => s.id === slicing.sizeId)?.label} ({slicing.done + 1} / {slicing.total}){slicing.stopping ? ', stopping after this one' : ''}… <SinceText since={slicing.since} /></span>
                <button className="btn ghost small-btn" disabled={slicing.stopping} onClick={z.cancel}><Icon name="stop" size={12} /> Stop</button>
              </div>
            : <button className="btn ghost wide" disabled={z.slicingOther} onClick={() => void z.sliceAll()} title="Slices each size in Bambu Studio, one after the other (sizes already sliced for the design as it is are kept)">
                <Icon name="printer" size={14} /> {sliced ? 'Slice the sizes again' : 'Slice every size'}
              </button>)}
        </>
      )}
    </section>
  );
}

function SinceText({ since }: { since: number }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => { const t = setInterval(() => setNow(performance.now()), 500); return () => clearInterval(t); }, []);
  return <span className="mono">{Math.round((now - since) / 1000)} s</span>;
}

/** A size's name, saved when you leave it or press Enter. */
function LabelInput({ value, onCommit, name }: { value: string; onCommit: (v: string) => void; name: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft != null && draft.trim() && draft.trim() !== value) onCommit(draft); setDraft(null); };
  return (
    <input className="size-label" aria-label={name} maxLength={MAX_SIZE_LABEL} value={draft ?? value} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setDraft(null); } }} />
  );
}

/** A size's main dimension, applied when you leave it or press Enter. */
function MmInput({ value, onCommit, name, axisClass }: { value: DesignSize['mm']; onCommit: (v: number) => void; name: string; axisClass: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft.replace(',', '.'));
    setDraft(null);
    if (Number.isFinite(v) && v > 0 && Math.abs(v - value) > 1e-6) onCommit(v);
  };
  return (
    <div className={`num-box size-mm ${axisClass}`}>
      <input className="mono" aria-label={name} value={draft ?? String(+value.toFixed(1))} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setDraft(null); (e.target as HTMLInputElement).blur(); } }} />
      <span className="unit">mm</span>
    </div>
  );
}
