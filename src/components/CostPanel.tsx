import { useEffect, useState } from 'react';
import { costOf, CURRENCY, duration, money, type CostSettings } from '../../shared/cost';
import type { PriceSuggestion } from '../../shared/api';
import { api } from '../lib/api';
import { STAGE_TEXT, type CostResult, type CostStage } from '../hooks/useCost';
import { Icon } from './Icon';

interface Props {
  designId: string;
  designName: string;
  /** Claude's summary of the shown version (what the item is), for the price suggestion. */
  summary?: string;
  settings: CostSettings;
  onSettings: (s: CostSettings) => void;
  result: CostResult | null;
  upToDate: boolean;
  error: string | null;
  running: { designId: string; stage: CostStage; since: number } | null;
  /** Bambu Studio is installed (slicing needs it). */
  bambu: boolean;
  onCalculate: () => void;
}

/**
 * Cost tab: filament and print time from Bambu Studio's slice, electricity only from a measured
 * average power, and Claude's suggested selling price (labelled as its suggestion).
 */
export function CostPanel(p: Props) {
  const mine = p.running?.designId === p.designId;
  // Opening the tab (or another design in it) calculates what is missing or out of date; later
  // changes only mark the numbers as out of date, so moving a slider doesn't start a slice.
  useEffect(() => {
    if (p.bambu && !p.running && !p.upToDate && !p.error) p.onCalculate();
  }, [p.designId, p.bambu]);

  return (
    <div className="cost-panel">
      <section>
        <h4>Your prices</h4>
        <div className="cost-inputs">
          <PriceInput label={`Filament (${CURRENCY} per 1 kg roll)`} value={p.settings.filamentPerKg} onCommit={(v) => p.onSettings({ ...p.settings, filamentPerKg: v })} />
          <PriceInput label={`Electricity (${CURRENCY} per kWh)`} value={p.settings.electricityPerKwh} onCommit={(v) => p.onSettings({ ...p.settings, electricityPerKwh: v })} />
          <PriceInput label="Printer's average power while printing (W, measured)" value={p.settings.averageWatts} onCommit={(v) => p.onSettings({ ...p.settings, averageWatts: v })} />
        </div>
        <p className="dim small">
          Measure the power once with a plug-in meter: the kWh a print used ÷ its hours × 1000. The A1's 1300 W rating is its peak while
          the bed heats, so it isn't used: without a measurement, electricity is left out rather than guessed.
        </p>
      </section>

      <section>
        <div className="cost-head">
          <h4>This print</h4>
          {p.bambu && <button className="btn ghost small-btn" disabled={!!p.running} onClick={p.onCalculate}><Icon name="restore" size={12} /> Recalculate</button>}
        </div>
        {!p.bambu && <div className="dim small">Needs Bambu Studio installed: the grams and print time come from slicing the model in it.</div>}
        {p.running && <Progress stage={p.running.stage} since={p.running.since} other={!mine} />}
        {p.error && !p.running && <div className="bad-note small" role="alert">{p.error}</div>}
        {p.result && <Breakdown result={p.result} settings={p.settings} stale={!p.upToDate} />}
      </section>

      {p.result && p.upToDate && <Suggestion key={p.result.key} {...p} result={p.result} />}
    </div>
  );
}

function Progress({ stage, since, other }: { stage: CostStage; since: number; other: boolean }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => { const t = setInterval(() => setNow(performance.now()), 500); return () => clearInterval(t); }, []);
  return (
    <div className="cost-progress" role="status">
      <span className="spinner" /> {other ? 'Calculating another design: ' : ''}{STAGE_TEXT[stage]}… <span className="mono">{Math.round((now - since) / 1000)} s</span>
    </div>
  );
}

function Breakdown({ result, settings, stale }: { result: CostResult; settings: CostSettings; stale: boolean }) {
  const { stats } = result;
  const cost = costOf(stats, settings);
  return (
    <>
      {stale && <div className="cost-stale small">The model or its settings changed since this was calculated – recalculate for current numbers.</div>}
      <table className="kv">
        <tbody>
          <tr><th>Print time <span className="dim small">(Bambu Studio estimate)</span></th><td className="mono">{duration(stats.seconds)}</td></tr>
          <tr><th>Filament <span className="dim small">(supports and purge included)</span></th><td className="mono">{stats.grams.toFixed(1)} g</td></tr>
          {stats.filaments.length > 1 && stats.filaments.map((f, i) => (
            <tr key={i} className="cost-sub"><th><span className="swatch" style={{ background: f.color }} /> Filament {i + 1}</th><td className="mono">{f.grams.toFixed(1)} g</td></tr>
          ))}
          <tr><th>Filament cost</th><td className="mono">{cost.filament != null ? money(cost.filament) : <span className="dim">set a filament price</span>}</td></tr>
          <tr>
            <th>Electricity{cost.kwh != null && <span className="dim small"> ({cost.kwh.toFixed(2)} kWh)</span>}</th>
            <td className="mono">{cost.electricity != null ? money(cost.electricity) : <span className="dim">{settings.averageWatts == null ? 'needs a measured power' : 'set an electricity price'}</span>}</td>
          </tr>
          <tr className="cost-total"><th>Total{cost.filament == null || cost.electricity == null ? <span className="dim small"> (what is known)</span> : null}</th><td className="mono">{money(cost.total)}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function Suggestion(p: Props & { result: CostResult }) {
  const [state, setState] = useState<{ busy: boolean; price?: PriceSuggestion; error?: string }>({ busy: false });
  const ask = async () => {
    const { result: r, settings } = p;
    const cost = costOf(r.stats, settings);
    const b = r.result.bbox;
    setState({ busy: true });
    try {
      const price = await api.suggestPrice({
        name: r.result.meta.name || p.designName,
        description: p.summary ?? r.result.meta.description,
        size: b ? `${(b.max[0] - b.min[0]).toFixed(0)} × ${(b.max[1] - b.min[1]).toFixed(0)} × ${(b.max[2] - b.min[2]).toFixed(0)} mm` : 'unknown',
        parts: r.parts, colours: r.colours, grams: r.stats.grams, seconds: r.stats.seconds,
        filamentCost: cost.filament, electricityCost: cost.electricity,
      });
      setState({ busy: false, price });
    } catch (e) {
      setState({ busy: false, error: (e as Error).message });
    }
  };
  return (
    <section>
      <div className="cost-head">
        <h4>Selling price</h4>
        <button className="btn ghost small-btn" disabled={state.busy} onClick={ask}><Icon name="spark" size={12} /> {state.price ? 'Ask again' : 'Ask Jig'}</button>
      </div>
      {state.busy && <div className="cost-progress" role="status"><span className="spinner" /> Jig is thinking about a price…</div>}
      {state.error && <div className="bad-note small" role="alert">{state.error}</div>}
      {state.price && (
        <div className="cost-price">
          <div><b className="mono">{state.price.price.toFixed(0)} {state.price.currency}</b> <span className="dim small">(range {state.price.low.toFixed(0)}–{state.price.high.toFixed(0)} {state.price.currency})</span></div>
          <p className="small">{state.price.reasoning}</p>
          <div className="dim small">Jig's suggestion from the costs and the design – not a calculation.</div>
        </div>
      )}
      {!state.price && !state.busy && !state.error && <div className="dim small">Jig suggests a price from these costs, the print time and what the item is (uses a little of your Claude usage).</div>}
    </section>
  );
}

/** A price field that saves when you leave it or press Enter; empty clears it. */
function PriceInput({ label, value, onCommit }: { label: string; value?: number; onCommit: (v: number | undefined) => void }) {
  const [text, setText] = useState(value != null ? String(value) : '');
  useEffect(() => setText(value != null ? String(value) : ''), [value]);
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    const v = text.trim() === '' ? undefined : Number.isFinite(n) && n > 0 ? n : value;
    if (v !== value) onCommit(v); else setText(value != null ? String(value) : '');
  };
  return (
    <label className="cost-input">
      <span>{label}</span>
      <input type="text" inputMode="decimal" className="mono" value={text} placeholder="not set" onChange={(e) => setText(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}
