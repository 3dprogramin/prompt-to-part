// The user's own HueForge filaments (name, brand, colour, TD), saved from the HueForge panel. They
// live in the data folder, so they outlast the browser and a new Docker container.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config';
import { cleanMyFilaments } from '../shared/filaments';
import type { HfFilament } from '../shared/hueforge';

export const MY_FILAMENTS_FILE = path.join(DATA_DIR, 'filaments.json');

/** The saved filaments, checked; none if the file is missing or unreadable. */
export async function readMyFilaments(): Promise<HfFilament[]> {
  try {
    return cleanMyFilaments((JSON.parse(await readFile(MY_FILAMENTS_FILE, 'utf8')) as { filaments?: unknown }).filaments);
  } catch {
    return [];
  }
}
