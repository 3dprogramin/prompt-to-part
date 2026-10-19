import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodeMesh, type MeshData, type MeshEntry } from '../../shared/meshes';
import { encodeTris, MAX_REPAINT_CHARS, MAX_REPAINTS, slotPatch, storedSlots, triangleAreas, triangleNeighbours, type Repaint } from '../../shared/meshColors';
import type { RepaintView } from '../viewer/Viewer';
import { request } from '../lib/api';
import { useEscape } from '../components/useEscape';

export type RepaintTool = 'patch' | 'brush';

/** The stored mesh being repainted, with what a patch needs: its triangles' neighbours and areas. */
interface Stored { url: string; mesh: MeshData & { colors: Uint8Array }; neighbours: Int32Array; areas: Float32Array; total: number }
/** The last one loaded (meshes are big; repainting is one mesh at a time). */
let stored: Stored | null = null;
async function loadStored(url: string): Promise<Stored> {
  if (stored?.url === url) return stored;
  const mesh = decodeMesh(new Uint8Array(await (await request(url)).arrayBuffer()));
  if (!mesh.colors) throw new Error('This mesh has no colours stored');
  const areas = triangleAreas(mesh.positions, mesh.indices);
  stored = { url, mesh: { ...mesh, colors: mesh.colors }, neighbours: triangleNeighbours(mesh.indices), areas, total: areas.reduce((s, a) => s + a, 0) };
  return stored;
}

export interface RepaintState {
  /** The coloured mesh in repaint mode (one at a time). */
  mesh: string;
  tool: RepaintTool;
  /** Brush radius, mm. */
  radius: number;
  /** The brush's palette colour (index). */
  brush: number;
}

/**
 * Repainting a coloured mesh's patches by hand (the Object tab's Repaint, the 3D view's clicks): a
 * click picks the connected patch of its colour on the stored mesh, which then takes one of the
 * palette's colours; a brush stroke paints the triangles it passes over. Each is saved as one
 * repaint of the mesh (`onSave`), shown in the view at once (`paintRef`) while the model rebuilds.
 */
export function useRepaint(meshes: Record<string, MeshEntry>, onSave: (name: string, repaint: Repaint[] | undefined) => void) {
  const [state, setState] = useState<RepaintState | null>(null);
  const [selection, setSelection] = useState<{ faces: Uint32Array; mask: Uint8Array; share: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paintRef = useRef<((mesh: string, mask: Uint8Array, color: string) => void) | null>(null);
  const entry = state ? meshes[state.mesh] : undefined;
  const live = useRef({ meshes, entry, state, onSave });
  live.current = { meshes, entry, state, onSave };

  const stop = useCallback(() => { setState(null); setSelection(null); setError(null); }, []);
  useEscape(!!state, stop);
  // The mesh went (another design, colour turned off): repainting ends.
  useEffect(() => { if (state && !entry?.palette?.length) stop(); }, [state, entry, stop]);

  const start = useCallback((name: string) => {
    const e = live.current.meshes[name];
    if (!e?.palette?.length) return;
    setState((s) => ({ mesh: name, tool: s?.tool ?? 'patch', radius: s?.radius ?? 2, brush: Math.min(s?.brush ?? 0, e.palette!.length - 1) }));
    setSelection(null);
    setError(null);
    setLoading(true);
    // Loaded and its colours worked out now, so the first click answers at once.
    loadStored(e.file).then((s) => { storedSlots(e.file, s.mesh, e.palette!, e.repaint); }, (err: Error) => setError(err.message)).finally(() => setLoading(false));
  }, []);

  /** Each repaint, saved: appended (shown at once in `color`) or the list replaced. */
  const save = (name: string, next: Repaint[] | undefined) => live.current.onSave(name, next?.length ? next : undefined);
  const add = (faces: ArrayLike<number>, slot: number, mask?: Uint8Array) => {
    const { state: s, entry: e } = live.current;
    if (!s || !e?.palette?.[slot] || !faces.length) return;
    const list = e.repaint ?? [];
    if (list.length >= MAX_REPAINTS) { setError(`At most ${MAX_REPAINTS} repaints: clear some first`); return; }
    const tris = encodeTris(faces);
    if (tris.length > MAX_REPAINT_CHARS) { setError('Too much at once: repaint it in smaller parts'); return; }
    if (!mask) {
      let n = 0;
      for (let i = 0; i < faces.length; i++) n = Math.max(n, faces[i] + 1);
      mask = new Uint8Array(n);
      for (let i = 0; i < faces.length; i++) mask[faces[i]] = 1;
    }
    paintRef.current?.(s.mesh, mask, e.palette[slot].filament.color);
    setError(null);
    save(s.mesh, [...list, { color: e.palette[slot].color, tris }]);
  };

  /** Patch: the connected triangles of the clicked one's colour (as it prints now). */
  const pick = useCallback(async (face: number) => {
    const { state: s, entry: e } = live.current;
    if (!s || s.tool !== 'patch' || !e?.palette) return;
    try {
      const st = await loadStored(e.file);
      if (face >= st.areas.length) return;
      const faces = slotPatch(st.neighbours, storedSlots(e.file, st.mesh, e.palette, e.repaint), face);
      const mask = new Uint8Array(st.areas.length);
      let area = 0;
      for (const t of faces) { mask[t] = 1; area += st.areas[t]; }
      setSelection({ faces, mask, share: st.total ? area / st.total : 0 });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const apply = (slot: number) => {
    if (!selection) return;
    add(selection.faces, slot, selection.mask);
    setSelection(null);
  };
  /** Brush: one stroke, one repaint (the view painted it already). */
  const stroke = useCallback((faces: number[]) => {
    const s = live.current.state;
    if (s?.tool === 'brush') add(faces, s.brush);
  }, []);
  const undo = (name: string) => save(name, meshes[name]?.repaint?.slice(0, -1));
  const clear = (name: string) => { save(name, undefined); setSelection(null); };
  const set = (patch: Partial<RepaintState>) => {
    setState((s) => (s ? { ...s, ...patch } : s));
    if (patch.tool) setSelection(null);
  };

  const view = useMemo<RepaintView | null>(() => (state && entry?.palette ? {
    mesh: state.mesh, mode: state.tool, radius: state.radius, color: entry.palette[state.brush]?.filament.color ?? '#ffffff', selected: selection?.mask ?? null,
  } : null), [state, entry, selection]);

  return { state, selection, loading, error, start, stop, set, pick, apply, cancel: () => setSelection(null), stroke, undo, clear, view, paintRef };
}

export type RepaintControls = ReturnType<typeof useRepaint>;
