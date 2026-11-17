// The user's own LayerTone filaments (name, brand, colour, TD), saved from the LayerTone panel. They
// live in the data folder, so they outlast the browser and a new Docker container.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { cleanMyFilaments, withoutRolls, type MyFilament } from '../shared/filaments';
import type { LayerToneFilament } from '../shared/layertone';

export const MY_FILAMENTS_FILE = path.join(DATA_DIR, 'filaments.json');

/** The saved filaments with their roll counts, checked; none if the file is missing or unreadable. */
export async function readMyFilaments(): Promise<MyFilament[]> {
  try {
    return cleanMyFilaments((JSON.parse(await readFile(MY_FILAMENTS_FILE, 'utf8')) as { filaments?: unknown }).filaments);
  } catch {
    return [];
  }
}

/** The saved filaments for the agent and its tools: name, brand, colour and TD, never the roll count. */
export async function savedFilamentsForAgent(): Promise<LayerToneFilament[]> {
  return withoutRolls(await readMyFilaments());
}
