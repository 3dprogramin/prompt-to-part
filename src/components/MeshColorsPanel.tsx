import { useEffect, useRef, useState } from 'react';
import type { EvalResult } from '../../shared/types';
import { decodeMesh, type MeshEntry } from '../../shared/meshes';
import { filamentLabel, MAX_MESH_COLORS, meshPalette, type MeshColor } from '../../shared/meshColors';
import { designFilaments } from '../../shared/modelWarnings';
import { libraryFilament } from '../../shared/filaments';
import type { LayerToneFilament } from '../../shared/layertone';
import { api, request } from '../lib/api';
import { FilamentPicker } from './FilamentPicker';
import { Icon } from './Icon';
import { Seg, Slider } from './PlacementControls';
import type { RepaintControls } from '../hooks/useRepaint';

interface Props {
  result: EvalResult;
  /** The design's meshes (MESHES_KEY): the coloured ones (with a palette) are listed. */
  meshes: Record<string, MeshEntry>;
  /** A mesh's new colours (its entry with another palette). */
  onPalette: (name: string, palette: MeshColor[]) => void;
  /** Repainting patches by hand (useRepaint); `onRepaintStart` turns it on for a mesh. */
  repaint: RepaintControls;
  onRepaintStart: (name: string) => void;
}

/** A patch bigger than this share of the figure is likely more than the wrong spot (it joins a real area of that colour). */
const BIG_PATCH = 0.08;

/**
 * Object tab, coloured figures: each colour of a coloured mesh with the filament it prints with
 * (the filament picker changes it), how many colours it is reduced to (1–4), how many of the AMS
 * lite's 4 slots the whole design needs, and Repaint: patches Meshy coloured wrong, fixed by hand.
 */
export function MeshColorsPanel({ result, meshes, onPalette, repaint, onRepaintStart }: Props) {
  const coloured = Object.entries(meshes).filter(([, m]) => m.palette?.length);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const all = designFilaments(result.parts);
  const painted = result.parts.some((p) => p.paint);
  // Repainting ends with the panel (another tab, the section folded).
  const stopRepaint = repaint.stop;
  useEffect(() => stopRepaint, [stopRepaint]);

  // Fewer or more colours: the stored mesh's triangle colours, clustered again here.
  const recolour = async (name: string, entry: MeshEntry, k: number) => {
    setBusy(name);
    setError(null);
    try {
      const mesh = decodeMesh(new Uint8Array(await (await request(entry.file)).arrayBuffer()));
      if (!mesh.colors) throw new Error('This mesh has no colours stored');
      const mine = await api.myFilaments().catch(() => [] as LayerToneFilament[]);
      onPalette(name, meshPalette({ ...mesh, colors: mesh.colors }, k, mine));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mesh-colors">
      {painted && (
        <p className={`small ${all.length > MAX_MESH_COLORS ? 'warn' : 'dim'}`}>
          {all.length} of {MAX_MESH_COLORS} AMS slots{all.length > MAX_MESH_COLORS ? ` – too many: give other parts one of the figure's colours, or the figure fewer colours` : ''}
        </p>
      )}
      {coloured.map(([name, entry]) => (
        <div key={name} className="mesh-colors-mesh">
          <div className="mesh-colors-head">
            <b>{name}</b>
            <span className="spacer" />
            <span className="dim small">Colours</span>
            <div className="seg" role="group" aria-label={`Colours of ${name}`}>
              {Array.from({ length: MAX_MESH_COLORS }, (_, i) => i + 1).map((k) => (
                <button key={k} className={entry.palette!.length === k ? 'on' : ''} aria-pressed={entry.palette!.length === k} disabled={busy === name}
                  title={k === 1 ? 'One colour' : `Reduce its colours to ${k}`} onClick={() => entry.palette!.length !== k && void recolour(name, entry, k)}>{k}</button>
              ))}
            </div>
          </div>
          <ul className="mesh-colors-list">
            {entry.palette!.map((c, i) => {
              const key = `${name}:${i}`;
              const current: LayerToneFilament = { name: c.filament.name ?? c.filament.color, ...(c.filament.brand ? { brand: c.filament.brand } : {}), color: c.filament.color, td: libraryFilament({ name: c.filament.name ?? '', brand: c.filament.brand })?.td ?? 1 };
              return (
                <li key={i} className="mesh-colors-row">
                  <span className="swatch" style={{ background: c.color }} title={`The model's colour ${c.color}, ${Math.round(c.share * 100)} % of its surface`} />
                  <span className="dim small mono">{Math.round(c.share * 100)} %</span>
                  <span className="dim" aria-hidden>→</span>
                  <button className="layertone-pick" onClick={(e) => { trigger.current = e.currentTarget; setPicking(picking === key ? null : key); }} aria-haspopup="dialog" aria-expanded={picking === key} aria-label={`${filamentLabel(c.filament)}: change the filament`} title="Change the filament">
                    <span className="layertone-swatch" style={{ background: c.filament.color }} />
                    <span className="layertone-title">{c.filament.name ?? c.filament.color}</span>
                    {c.filament.brand && <span className="dim small">{c.filament.brand}</span>}
                  </button>
                  {picking === key && (
                    <FilamentPicker current={current} trigger={trigger} onClose={() => setPicking(null)}
                      onPick={(f) => { setPicking(null); onPalette(name, entry.palette!.map((x, j) => (j === i ? { ...x, filament: { color: f.color.toLowerCase(), name: f.name, ...(f.brand ? { brand: f.brand } : {}) } } : x))); }} />
                  )}
                </li>
              );
            })}
          </ul>
          <RepaintControlsRow name={name} entry={entry} repaint={repaint} onStart={onRepaintStart} />
        </div>
      ))}
      {error && <p className="small warn">{error}</p>}
      <p className="dim small text-tip">Each colour of the figure prints with its filament (Bambu Studio gets the triangles painted). Geometry the script adds has its part's colour.</p>
    </div>
  );
}

/** Repaint for one coloured mesh: the switch, Undo and Clear, and while on its tools. */
function RepaintControlsRow({ name, entry, repaint, onStart }: { name: string; entry: MeshEntry; repaint: RepaintControls; onStart: (name: string) => void }) {
  const on = repaint.state?.mesh === name ? repaint.state : null;
  const count = entry.repaint?.length ?? 0;
  const palette = entry.palette!;
  const sel = on && repaint.selection;
  const swatches = (label: string, onPick: (i: number) => void, current?: number) => (
    <div className="repaint-swatches" role="group" aria-label={label}>
      {palette.map((c, i) => (
        <button key={i} className={current === i ? 'on' : ''} aria-pressed={current === undefined ? undefined : current === i} onClick={() => onPick(i)}
          aria-label={`${label}: ${filamentLabel(c.filament)}`} title={filamentLabel(c.filament)}>
          <span className="layertone-swatch" style={{ background: c.filament.color }} />
          <span className="layertone-title">{c.filament.name?.replace(/^PLA (Basic|Matte) /, '') ?? c.filament.color}</span>
        </button>
      ))}
    </div>
  );
  return (
    <div className="repaint">
      <div className="repaint-bar">
        <button className={`chip ${on ? 'on' : ''}`} aria-pressed={!!on} onClick={() => (on ? repaint.stop() : onStart(name))}
          title="Fix spots Meshy coloured wrong: click one on the model and pick its filament">
          <Icon name="brush" size={13} /> Repaint
        </button>
        {count > 0 && <>
          <span className="spacer" />
          <button className="chip" onClick={() => repaint.undo(name)} title="Take back the last repaint"><Icon name="undo" size={13} /> Undo</button>
          <button className="chip" onClick={() => repaint.clear(name)} title={count > 1 ? `Remove all ${count} repaints` : 'Remove the repaint'}>Clear repaints ({count})</button>
        </>}
      </div>
      {on && (
        <div className="repaint-tools">
          <Seg value={on.tool} options={[['patch', 'Patch'], ['brush', 'Brush']]} onChange={(tool) => repaint.set({ tool })} />
          {repaint.loading && <div className="hint-line"><span className="spinner" /> Loading the figure…</div>}
          {on.tool === 'patch' && (sel ? <>
            <p className={`small ${sel.share > BIG_PATCH ? 'warn' : ''}`}>
              Patch: {sel.share < 0.001 ? '< 0.1' : +(sel.share * 100).toFixed(1)} % of the figure{sel.share > BIG_PATCH ? ' – more than the wrong spot? Use Brush' : ''}
            </p>
            {swatches('Print it in', repaint.apply)}
            <button className="chip" onClick={repaint.cancel}>Cancel</button>
          </> : <div className="hint-line">Click a spot on the model: its patch of one colour is picked.</div>)}
          {on.tool === 'brush' && <>
            {swatches('Brush colour', (brush) => repaint.set({ brush }), on.brush)}
            <Slider label="Brush radius" unit="mm" min={0.5} max={10} step={0.5} value={on.radius} onChange={(radius) => repaint.set({ radius })} />
            <div className="hint-line">Drag over the model to paint; drag beside it to turn the view. Esc ends.</div>
          </>}
          {repaint.error && <p className="small warn">{repaint.error}</p>}
        </div>
      )}
    </div>
  );
}
