// The user's own filaments (GET/PUT /api/filaments/mine), shared by every open picker and the Settings
// dialog's Filaments tab. Read each time one of them opens, so a change made in another browser tab shows
// up. Nothing is written before the list was read (mineStore.ts).
import { useEffect, useState } from 'react';
import type { MyFilament } from '../../shared/filaments';
import { api } from './api';
import { mineStore, type MineState } from './mineStore';

const store = mineStore({ read: api.myFilaments, write: api.saveMyFilaments });

/** Saves the list; everything showing it gets the list the server kept. Refused before the list was read. */
export const saveMine = (list: MyFilament[]): Promise<void> => store.save(list);

/** Reads the list from the server again. */
export const refreshMine = (): Promise<void> => store.refresh();

/** Makes a change on the list as read (reading it first if it never was) and saves it. */
export const changeMine = (f: (list: MyFilament[]) => { list: MyFilament[]; problem?: string }): Promise<void> => store.change(f);

/** The list as read, or null while it has not been read. */
export const readMine = (): MyFilament[] | null => { const s = store.get(); return s.status === 'ready' ? s.list : null; };

/** The user's filaments and whether they have been read, kept up to date; read from the server when the caller mounts. */
export function useMyFilamentsState(): MineState {
  const [state, setState] = useState(store.get);
  useEffect(() => {
    const stop = store.subscribe(setState);
    setState(store.get());
    store.refresh().catch(() => {});
    return stop;
  }, []);
  return state;
}

/** The user's filaments (empty until read). */
export const useMyFilaments = (): MyFilament[] => useMyFilamentsState().list;
