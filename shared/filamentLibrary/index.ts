// The built-in filament library: the frozen base list (base.ts) and the entries added after it, one
// file per brand. What a design's build resolves (line art's fallback TD, the colour paint palette)
// reads the base; what the user picks from (the pickers, the Filaments tab, the lookup) reads it all.
import type { LibraryFilament } from '../filaments';
import { BASE_FILAMENT_LIBRARY } from './base';
import { POLYMAKER_FILAMENTS } from './polymaker';
import { PRUSAMENT_FILAMENTS } from './prusament';
import { FUEL3D_FILAMENTS } from './fuel3d';
import { ESUN_MORE_FILAMENTS } from './esunMore';

export { BASE_FILAMENT_LIBRARY };

/** Entries added after the base, from the brand files. */
export const ADDED_FILAMENTS: readonly LibraryFilament[] = [...POLYMAKER_FILAMENTS, ...PRUSAMENT_FILAMENTS, ...FUEL3D_FILAMENTS, ...ESUN_MORE_FILAMENTS];

/** Base first, then the added ones. */
export const FILAMENT_LIBRARY: LibraryFilament[] = [...BASE_FILAMENT_LIBRARY, ...ADDED_FILAMENTS];
