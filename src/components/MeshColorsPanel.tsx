import { useRef, useState } from 'react';
import type { EvalResult } from '../../shared/types';
import { decodeMesh, type MeshEntry } from '../../shared/meshes';
import { filamentLabel, MAX_MESH_COLORS, meshPalette, triangleAreas, type MeshColor } from '../../shared/meshColors';
import { designFilaments } from '../../shared/modelWarnings';
import { libraryFilament } from '../../shared/filaments';
import type { LayerToneFilament } from '../../shared/layertone';
import { api, request } from '../lib/api';
import { FilamentPicker } from './FilamentPicker';

interface Props {
  result: EvalResult;
  /** The design's meshes (MESHES_KEY): the coloured ones (with a palette) are listed. */
  meshes: Record<string, MeshEntry>;
  /** A mesh's new colours (its entry with another palette). */
  onPalette: (name: string, palette: MeshColor[]) => void;
}

/**
 * Object tab, coloured figures: each colour of a coloured mesh with the filament it prints with
 * (the filament picker changes it), how many colours it is reduced to (1–4), and how many of the AMS
 * lite's 4 slots the whole design needs.
 */
export function MeshColorsPanel({ result, meshes, onPalette }: Props) {
  const coloured = Object.entries(meshes).filter(([, m]) => m.palette?.length);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const all = designFilaments(result.parts);
  const painted = result.parts.some((p) => p.paint);

  // Fewer or more colours: the stored mesh's triangle colours, clustered again here.
  const recolour = async (name: string, entry: MeshEntry, k: number) => {
    setBusy(name);
    setError(null);
    try {
      const mesh = decodeMesh(new Uint8Array(await (await request(entry.file)).arrayBuffer()));
      if (!mesh.colors) throw new Error('This mesh has no colours stored');
      const mine = await api.myFilaments().catch(() => [] as LayerToneFilament[]);
      onPalette(name, meshPalette(mesh.colors, triangleAreas(mesh.positions, mesh.indices), k, mine));
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
        </div>
      ))}
      {error && <p className="small warn">{error}</p>}
      <p className="dim small text-tip">Each colour of the figure prints with its filament (Bambu Studio gets the triangles painted). Geometry the script adds has its part's colour.</p>
    </div>
  );
}
