import { useEffect, useState } from 'react';
import { load, store } from '../lib/storage';
import {
  bambuOverrides, cleanSettings, describeSetting, effectiveSettings, FUZZY_SKIN, INFILL_PATTERNS, IRONING_TYPES, MODEL_WIDE_KEYS, PER_OBJECT_KEYS, SCARF_SEAMS, SEAMS, SETTING_GROUPS, SETTING_LABELS, spiralFits,
  supportStylesFor, TOP_ONE_WALL, TOP_PATTERNS, WALL_GENERATORS, WALL_ORDERS, type Brim, type PrintProfile, type PrintSettings, type Supports,
} from '../../shared/print';
import { layerHeights, printer, profileName, shortName, type PrinterSetup } from '../../shared/printer';
import type { PrinterInfo } from '../../shared/api';
import { PrinterDialog } from './PrinterPicker';

/** "loads 4 filaments at once", or "no AMS". */
const loadsLabel = (n: number) => (n === 1 ? 'no AMS' : `loads ${n} filaments at once`);
import type { PartMesh } from '../../shared/types';
import { oneColourFilament, printFilaments } from '../lib/bambu3mf';
import { Icon } from './Icon';
import { useReleaseSlider } from './useReleaseSlider';

type Key = keyof PrintSettings;
const KEYS: Key[] = ['layerHeight', 'firstLayerHeight', 'walls', 'topLayers', 'bottomLayers', 'infill', 'infillPattern', 'topPattern', 'supports', 'supportsOnPlate', 'brim', 'wallOrder', 'seam', 'ironing', 'fuzzySkin'];

interface Props {
  parts: string[];
  ai: PrintProfile;
  user: PrintProfile;
  /** The profile's own settings (from the user's Bambu Studio template). */
  base: Required<PrintSettings>;
  onChange: (user: PrintProfile) => void;
  bambu: string | null;
  /** The chosen printer and the ones to pick from (null until loaded). */
  printerInfo: PrinterInfo | null;
  onPrinter: (s: PrinterSetup) => Promise<void>;
  /** Why the shown version's settings can't change (printed), or null: the printer can still be changed. */
  locked?: string | null;
}

/** Who decided the value shown for this key in this scope. */
function source(ai: PrintProfile, user: PrintProfile, key: Key, part: string | null): 'you' | 'ai' | 'default' {
  const get = (p: PrintProfile) => (part ? (p.parts?.[part] as PrintSettings | undefined)?.[key] ?? p[key] : p[key]);
  if (get(user) !== undefined) return 'you';
  if (get(ai) !== undefined) return 'ai';
  return 'default';
}

/** More parts than this and the part choice folds away. */
const MANY_PARTS = 6;

export function PrintPanel({ parts, ai, user, base, onChange, bambu, printerInfo, onPrinter, locked }: Props) {
  const [choosing, setChoosing] = useState(false);
  const [scopeOpen, setScopeOpen] = useState<boolean>(() => load('printScopeOpen', false));
  useEffect(() => store('printScopeOpen', scopeOpen), [scopeOpen]);
  const [writtenOpen, setWrittenOpen] = useState<boolean>(() => load('printWrittenOpen', false));
  useEffect(() => store('printWrittenOpen', writtenOpen), [writtenOpen]);
  const [scope, setScope] = useState<string | null>(null); // null = whole model
  const part = scope && parts.includes(scope) ? scope : null;
  // Spiral vase only for a design of one part (the export leaves it off with more, as the slicer refuses it).
  const vaseFits = spiralFits(parts.length);
  const settingsOf = (name?: string) => { const s = effectiveSettings(ai, user, name, base); return vaseFits ? s : { ...s, spiralVase: false }; };
  const eff = settingsOf(part ?? undefined);

  const own = (p: PrintProfile): PrintSettings => (part ? (p.parts?.[part] ?? {}) : p);
  const setValue = (key: Key, value: PrintSettings[Key] | undefined) => {
    const next: PrintProfile = structuredClone(user);
    if (part) {
      const ps = { ...(next.parts?.[part] ?? {}) } as PrintSettings;
      if (value === undefined) delete ps[key]; else (ps as Record<string, unknown>)[key] = value;
      next.parts = { ...(next.parts ?? {}), [part]: ps };
      if (!Object.keys(ps).length) delete next.parts[part];
      if (next.parts && !Object.keys(next.parts).length) delete next.parts;
    } else {
      if (value === undefined) delete next[key]; else (next as Record<string, unknown>)[key] = value;
    }
    onChange(next);
  };

  // What will differ from the profile, per part.
  const changes = parts.map((name) => ({ name, keys: bambuOverrides(settingsOf(name), base) })).filter((c) => Object.keys(c.keys).length);
  const aiHasAny = Object.keys(ai).length > 0;

  return (
    <div className="print-panel">
      <div className="pp-printer">
        <span><b>{printer().name}</b><span className="dim small"> · {loadsLabel(printer().filaments)}</span></span>
        <button className="btn ghost small" disabled={!printerInfo} onClick={() => setChoosing(true)}>Change</button>
      </div>
      {printerInfo?.missing && <div className="small warn-note" role="alert">Your saved printer wasn't found in Bambu Studio; using the Bambu Lab A1 until you pick another.</div>}
      {printer().extruders > 1 && <div className="dim small">Two nozzles: no Bambu Studio project for it yet, so print settings stay out of the export.</div>}
      {choosing && printerInfo && <PrinterDialog info={printerInfo} onCancel={() => setChoosing(false)} onSave={async (s) => { await onPrinter(s); setChoosing(false); }} />}
      <fieldset className="lock-fieldset" disabled={!!locked} title={locked ?? undefined}>
      <div className="pp-profile">
        <b>PLA · {profileName()}</b>
        <span className="dim small">Only changes from this profile go into the 3MF (tick “Print settings” when exporting).{!bambu && ' Needs Bambu Studio installed.'}</span>
      </div>

      {parts.length > 1 && (() => {
        const chips = (
          <div className="pp-scope">
            <button className={`chip ${part === null ? 'on' : ''}`} aria-pressed={part === null} onClick={() => setScope(null)}>Whole model</button>
            {parts.map((n) => {
              const marked = !!(ai.parts?.[n] || user.parts?.[n]);
              return <button key={n} className={`chip ${part === n ? 'on' : ''}`} aria-pressed={part === n} onClick={() => setScope(n)}>{n}{marked && <><i className="pp-dot" aria-hidden /><span className="sr-only"> (has its own settings)</span></>}</button>;
            })}
          </div>
        );
        // Many parts (a split line art has dozens): the choice folds away, closed by default (remembered).
        return parts.length <= MANY_PARTS ? chips : (
          <details className="pp-scope-fold" open={scopeOpen} onToggle={(e) => setScopeOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary className="small">Settings for: <b>{part ?? 'Whole model'}</b> <span className="dim">· {parts.length} parts</span></summary>
            {chips}
          </details>
        );
      })()}

      {KEYS.filter((k) => !(part && (k === 'layerHeight' || k === 'firstLayerHeight')) && !(k === 'supportsOnPlate' && eff.supports === 'off')).map((key) => (
        <Row key={key} k={key} eff={eff} base={base} src={source(ai, user, key, part)} ownUser={(own(user) as PrintSettings)[key] !== undefined} onChange={setValue} />
      ))}

      {SETTING_GROUPS.map((g) => {
        // A part has no model-wide rows: a group left with none (Seam) is not shown there.
        const keys = g.keys.filter((k) => !(part && (MODEL_WIDE_KEYS as Key[]).includes(k)));
        if (!keys.length) return null;
        const changed = keys.some((k) => source(ai, user, k, part) !== 'default');
        // Supports and ironing only matter when they are on: until then a line says so.
        const off = g.id === 'supports' ? eff.supports === 'off' : g.id === 'ironing' ? eff.ironing === 'off' : false;
        return (
          <PrintGroup key={g.id} id={g.id} label={g.label} changed={changed}>
            {off
              ? <div className="dim small">Turn {g.id === 'supports' ? 'supports' : 'ironing'} on to tune them.</div>
              : keys.map((key) => (
                <Row key={key} k={key} eff={eff} base={base} src={source(ai, user, key, part)} ownUser={(own(user) as PrintSettings)[key] !== undefined} onChange={setValue}
                  disabled={key === 'spiralVase' && !vaseFits}
                  hint={key === 'spiralVase' && !vaseFits ? 'Only for a design of one part.' : part && PER_OBJECT_KEYS.includes(key) ? 'Applies to the whole object this part belongs to.' : undefined} />
              ))}
            {g.id === 'advanced' && !part && eff.spiralVase && <div className="dim small">Prints as one continuous wall: 1 wall, no top layers, no infill, no supports. One part, one colour.</div>}
          </PrintGroup>
        );
      })}

      {/* What goes into the 3MF, folded by default (remembered). */}
      <details className="pp-summary pp-fold" open={writtenOpen} onToggle={(e) => setWrittenOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <h4>Written to the 3MF</h4>
          <span className="dim small">{changes.length === 0 ? ` · nothing, the ${shortName()} profile as is` : ` · changes for ${changes.length} part${changes.length > 1 ? 's' : ''}`}</span>
        </summary>
        {changes.length === 0
          ? <div className="dim small">Nothing – the standard {shortName()} profile is used as is.</div>
          : <ul>{changes.map((c) => (
            <li key={c.name}><b>{c.name}</b>: {Object.entries(c.keys).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')}</li>
          ))}</ul>}
      </details>
      <div className="pp-actions">
        <button className="btn ghost" disabled={!Object.keys(user).length} onClick={() => onChange({})}><Icon name="restore" size={14} /> {aiHasAny ? 'Back to AI settings' : `Back to ${shortName()} defaults`}</button>
      </div>
      </fieldset>
    </div>
  );
}

/** One setting: its label, who decided it, a reset when it is yours, the control, and a one-line hint under it. */
function Row({ k, eff, base, src, ownUser, onChange, disabled, hint }: { k: Key; eff: Required<PrintSettings>; base: Required<PrintSettings>; src: 'you' | 'ai' | 'default'; ownUser: boolean; onChange: (key: Key, value: PrintSettings[Key] | undefined) => void; disabled?: boolean; hint?: string }) {
  return (
    <div className="pp-row">
      <div className="pp-label">
        <span>{SETTING_LABELS[k]}</span>
        <span className={`pp-src ${src}`} title={src === 'default' ? `Profile default: ${describeSetting(k, base[k])}` : undefined}>
          {src === 'you' ? 'You' : src === 'ai' ? 'AI' : 'Default'}
        </span>
        {ownUser && <button className="icon-btn pp-reset" title="Reset" aria-label={`Reset ${SETTING_LABELS[k]}`} onClick={() => onChange(k, undefined)}><Icon name="restore" size={12} /></button>}
      </div>
      <Control k={k} label={SETTING_LABELS[k]} value={eff[k]} supports={eff.supports} disabled={disabled} onChange={(v) => onChange(k, v)} />
      {hint && <div className="dim small">{hint}</div>}
    </div>
  );
}

/** A folded group of rows, closed by default (remembered per group); a dot marks a change in it. */
function PrintGroup({ id, label, changed, children }: { id: string; label: string; changed: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => load(`printGroup-${id}`, false));
  useEffect(() => store(`printGroup-${id}`, open), [id, open]);
  return (
    <details className="pp-group" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{label}{changed && <><i className="pp-dot" aria-hidden /><span className="sr-only"> (changed)</span></>}</summary>
      <div className="pp-group-rows">{children}</div>
    </details>
  );
}

/**
 * A number typed in: each value in progress that is a number is cleaned (clamped, rounded) and saved as
 * typed, and the field keeps showing the typed text until it loses focus, then the saved value.
 */
function NumberField({ k, label, value, min, max, step, unit, onChange }: { k: Key; label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: PrintSettings[Key]) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="pp-num">
      <input type="number" aria-label={label} min={min} max={max} step={step} value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = e.target.value.trim() === '' ? NaN : Number(e.target.value);
          const clean = Number.isFinite(n) ? (cleanSettings({ [k]: n }) as Record<string, unknown>)[k] : undefined;
          if (clean !== undefined) onChange(clean as PrintSettings[Key]);
        }}
        onBlur={() => setDraft(null)} />
      <span className="dim small">{unit}</span>
    </div>
  );
}

function Control({ k, label, value, supports, disabled, onChange }: { k: Key; label: string; value: PrintSettings[Key]; supports: Supports; disabled?: boolean; onChange: (v: PrintSettings[Key]) => void }) {
  switch (k) {
    case 'layerHeight': case 'firstLayerHeight':
      return <select aria-label={label} value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>{layerHeights(printer().nozzle).map((h) => <option key={h} value={h}>{h.toFixed(2)} mm{Math.abs(h - printer().nozzle / 2) < 1e-6 ? ' (standard)' : ''}</option>)}</select>;
    case 'walls': case 'topLayers': case 'bottomLayers':
      return <Stepper label={label} value={Number(value)} min={k === 'walls' ? 1 : 0} max={k === 'walls' ? 10 : 30} onChange={onChange} />;
    case 'infill':
      return <InfillSlider value={Number(value)} onChange={onChange} />;
    case 'infillPattern':
      return <select aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value)}>{INFILL_PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>;
    case 'topPattern':
      return <select aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value as PrintSettings[Key])}>{TOP_PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>;
    case 'supports':
      return (
        <div className="seg">{(['off', 'normal', 'tree'] as Supports[]).map((s) => (
          <button key={s} className={value === s ? 'on' : ''} aria-pressed={value === s} onClick={() => onChange(s)}>{describeSetting('supports', s)}</button>))}
        </div>
      );
    case 'supportsOnPlate':
      return (
        <div className="seg">{[false, true].map((on) => (
          <button key={String(on)} className={value === on ? 'on' : ''} aria-pressed={value === on} onClick={() => onChange(on)}>{on ? 'Plate only' : 'Everywhere'}</button>))}
        </div>
      );
    case 'ironing': case 'seam': case 'wallOrder': case 'fuzzySkin': {
      const options: readonly string[] = k === 'ironing' ? IRONING_TYPES : k === 'seam' ? SEAMS : k === 'wallOrder' ? WALL_ORDERS : FUZZY_SKIN;
      return <select aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value as PrintSettings[Key])}>{options.map((o) => <option key={o} value={o}>{describeSetting(k, o as PrintSettings[Key])}</option>)}</select>;
    }
    case 'supportAngle': return <Stepper label={label} value={Number(value)} min={0} max={90} unit="°" onChange={onChange} />;
    case 'supportInterfaceLayers': return <Stepper label={label} value={Number(value)} min={0} max={5} onChange={onChange} />;
    case 'ironingSpeed': return <Stepper label={label} value={Number(value)} min={10} max={100} unit="mm/s" onChange={onChange} />;
    case 'ironingFlow': return <Stepper label={label} value={Number(value)} min={5} max={30} unit="%" onChange={onChange} />;
    case 'supportGap': return <NumberField k={k} label={label} value={Number(value)} min={0} max={1} step={0.01} unit="mm" onChange={onChange} />;
    case 'infillDirection': return <NumberField k={k} label={label} value={Number(value)} min={0} max={180} step={5} unit="°" onChange={onChange} />;
    case 'ironingSpacing': return <NumberField k={k} label={label} value={Number(value)} min={0.05} max={0.3} step={0.01} unit="mm" onChange={onChange} />;
    case 'holeCompensation': case 'contourCompensation': return <NumberField k={k} label={label} value={Number(value)} min={-0.5} max={0.5} step={0.01} unit="mm" onChange={onChange} />;
    case 'elephantFoot': return <NumberField k={k} label={label} value={Number(value)} min={0} max={1} step={0.005} unit="mm" onChange={onChange} />;
    case 'supportStyle': case 'topOneWall': case 'wallGenerator': case 'scarfSeam': {
      const options: readonly string[] = k === 'supportStyle' ? supportStylesFor(supports) : k === 'topOneWall' ? TOP_ONE_WALL : k === 'wallGenerator' ? WALL_GENERATORS : SCARF_SEAMS;
      const shown = options.includes(String(value)) ? String(value) : options[0];
      return <select aria-label={label} value={shown} onChange={(e) => onChange(e.target.value as PrintSettings[Key])}>{options.map((o) => <option key={o} value={o}>{describeSetting(k, o as PrintSettings[Key])}</option>)}</select>;
    }
    case 'spiralVase':
      return (
        <div className="seg">{[false, true].map((on) => (
          <button key={String(on)} className={value === on ? 'on' : ''} aria-pressed={value === on} disabled={disabled} onClick={() => onChange(on)}>{on ? 'On' : 'Off'}</button>))}
        </div>
      );
    case 'brim': {
      const b = value as Brim;
      const width = typeof b === 'number';
      return (
        <div className="pp-brim">
          <div className="seg">
            <button className={b === 'auto' ? 'on' : ''} aria-pressed={b === 'auto'} onClick={() => onChange('auto')}>Auto</button>
            <button className={b === 'none' ? 'on' : ''} aria-pressed={b === 'none'} onClick={() => onChange('none')}>None</button>
            <button className={width ? 'on' : ''} aria-pressed={width} onClick={() => onChange(width ? b : 5)}>Width</button>
          </div>
          {width && <Stepper label="Brim width" value={b} min={1} max={20} unit="mm" onChange={onChange} />}
        </div>
      );
    }
  }
}

function Stepper({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return (
    <div className="pp-stepper" role="group" aria-label={label}>
      <button onClick={() => onChange(clamp(value - 1))} disabled={value <= min} aria-label={`Fewer (${label})`}>−</button>
      <span className="mono" aria-live="polite">{value}{unit ? ` ${unit}` : ''}</span>
      <button onClick={() => onChange(clamp(value + 1))} disabled={value >= max} aria-label={`More (${label})`}>+</button>
    </div>
  );
}

function InfillSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const s = useReleaseSlider(value, onChange);
  return (
    <div className="num-control">
      <input type="range" aria-label="Infill" min={0} max={100} step={5} {...s.inputProps} />
      <span className="mono pp-pct">{Math.round(s.shown)} %</span>
    </div>
  );
}

/**
 * "Print in one colour" (top of the Print tab, saved with the design): everything in one filament,
 * the main one or one the user picks from the design's filaments. `parts` are the parts shown.
 */
export function OneColourSwitch({ parts, choice, onChange }: { parts: PartMesh[]; choice: null | 'main' | string; onChange: (c: null | 'main' | string) => void }) {
  // One entry per colour: the same colour under two names (LayerTone) is one filament here.
  const filaments = printFilaments(parts).filter((f, i, all) => all.findIndex((g) => g.colour === f.colour) === i);
  const main = oneColourFilament(parts, 'main');
  const single = choice ? oneColourFilament(parts, choice) : null;
  const label = (f: { colour: string; name?: string }) => f.name ?? f.colour;
  return (
    <div className={`one-colour ${choice ? 'on' : ''}`}>
      <label className="switch">
        <input type="checkbox" checked={!!choice} onChange={(e) => onChange(e.target.checked ? 'main' : null)} />
        <span className="track" />
        <span className="switch-label"><b>Print in one colour</b></span>
      </label>
      <span className="dim small">Everything in one filament – keeps the print settings. Off: one filament per colour (AMS).</span>
      {single && (
        <div className="oc-filament">
          <span className="swatch" style={{ background: single.colour }} aria-hidden />
          {filaments.length > 1
            ? <select aria-label="Filament to print with" value={choice === 'main' ? 'main' : single.colour} onChange={(e) => onChange(e.target.value)}>
              <option value="main">Main filament ({label(main)})</option>
              {filaments.map((f) => <option key={f.colour} value={f.colour}>{label(f)}</option>)}
            </select>
            : <span>{label(single)}</span>}
        </div>
      )}
      {single && <span className="dim small">The 3D view, the 3MF and the cost show this filament only.</span>}
    </div>
  );
}
