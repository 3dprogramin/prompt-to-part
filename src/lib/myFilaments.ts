// The user's own filaments (GET/PUT /api/filaments/mine), shared by every open picker and the Settings
// dialog's Filaments tab. Fetched each time one of them opens, so a change made in another browser tab
// shows up.
import { useEffect, useState } from 'react';
import type { MyFilament } from '../../shared/filaments';
import { api } from './api';

const mine = { list: [] as MyFilament[], subs: new Set<(l: MyFilament[]) => void>() };
const setMine = (list: MyFilament[]) => { mine.list = list; mine.subs.forEach((f) => f(list)); };

/** Saves the list; everything showing it gets the list the server kept. */
export const saveMine = async (list: MyFilament[]): Promise<void> => setMine(await api.saveMyFilaments(list));

/** Reads the list from the server again. */
export const refreshMine = async (): Promise<void> => setMine(await api.myFilaments());

/** The user's filaments, kept up to date; read from the server when the caller mounts. */
export function useMyFilaments(): MyFilament[] {
  const [list, setList] = useState(mine.list);
  useEffect(() => {
    mine.subs.add(setList);
    refreshMine().catch(() => {});
    return () => { mine.subs.delete(setList); };
  }, []);
  return list;
}
