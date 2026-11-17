// The user's own filaments as the page holds them, and the rule that keeps the saved file safe: nothing is
// written from a list that was never read. Each write sends the whole list, so a write built from an empty
// list that only means "not read yet" would replace every saved filament. No React and no fetch here (the
// store in myFilaments.ts gives it the API), so the tests run it as it is.
import type { MyFilament } from '../../shared/filaments';

/** 'loading' until the first read answers (and again while "Try again" reads), 'failed' when it did not. */
export type MineStatus = 'loading' | 'ready' | 'failed';
export interface MineState { list: MyFilament[]; status: MineStatus }

/** Why a change was refused when the list could not be read. */
export const NOT_LOADED = 'Your filaments could not be loaded. Nothing was changed.';

export interface MineStore {
  get(): MineState;
  subscribe(f: (s: MineState) => void): () => void;
  /** Reads the list again (one read at a time); rejects when the read fails. */
  refresh(): Promise<void>;
  /** Saves a list made from the read one; refused (NOT_LOADED) before the first read worked. */
  save(list: MyFilament[]): Promise<void>;
  /** Makes a change on the newest list, reading it first if it never was, and saves it. A problem refuses it. */
  change(f: (list: MyFilament[]) => { list: MyFilament[]; problem?: string }): Promise<void>;
}

export function mineStore(io: { read(): Promise<MyFilament[]>; write(list: MyFilament[]): Promise<MyFilament[]> }): MineStore {
  let state: MineState = { list: [], status: 'loading' };
  const subs = new Set<(s: MineState) => void>();
  const set = (s: MineState) => { state = s; subs.forEach((f) => f(s)); };
  let reading: Promise<void> | null = null;
  // Saves answered so far: a read that started before one of them has an older list than the save's answer.
  let writes = 0;

  const refresh = (): Promise<void> => {
    if (reading) return reading;
    const at = writes;
    if (state.status === 'failed') set({ ...state, status: 'loading' });
    reading = io.read().then(
      (list) => { reading = null; if (writes === at) set({ list, status: 'ready' }); },
      (e: unknown) => { reading = null; if (state.status !== 'ready') set({ ...state, status: 'failed' }); throw e; },
    );
    return reading;
  };
  const save = async (list: MyFilament[]) => {
    if (state.status !== 'ready') throw new Error(NOT_LOADED);
    const kept = await io.write(list);
    writes++;
    set({ list: kept, status: 'ready' });
  };
  const change = async (f: (list: MyFilament[]) => { list: MyFilament[]; problem?: string }) => {
    if (state.status !== 'ready') await refresh().catch(() => {});
    if (state.status !== 'ready') throw new Error(NOT_LOADED);
    const base = state.list;
    const { list, problem } = f(base);
    if (problem) throw new Error(problem);
    if (list !== base) await save(list);
  };
  return {
    get: () => state,
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    refresh,
    save,
    change,
  };
}
