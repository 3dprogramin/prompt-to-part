// Filament library for HueForge prints: brands, colours and TD (transmission distance) values.
//
// CONTRACT (feat/hueforge): the side panel uses FILAMENT_LIBRARY and searchFilaments; the server
// answers POST /api/filaments/lookup { brand, name } with FilamentLookup (TD found on the web),
// which the page calls through lookupFilament() in src/lib/api.ts. TODO(filaments): the data and
// the lookup.
import type { HfFilament } from './hueforge';

export interface LibraryFilament extends HfFilament {
  brand: string;
  /** Product line, e.g. "PLA Basic", "PLA Matte", "PLA+". */
  line?: string;
  /** Where the TD value comes from (URL or "measured by …"). */
  source?: string;
}

/** POST /api/filaments/lookup reply. */
export interface FilamentLookup {
  filament: LibraryFilament;
  /** How sure the lookup is: 'listed' (a published TD for this exact filament), 'similar' (from a close match), 'estimate'. */
  confidence: 'listed' | 'similar' | 'estimate';
  note?: string;
}

export const FILAMENT_LIBRARY: LibraryFilament[] = [];

/** Library filaments matching a free-text query ("bambu black", "esun pla+ red"), best first. */
export function searchFilaments(query: string, limit = 20): LibraryFilament[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return FILAMENT_LIBRARY.filter((f) => words.every((w) => `${f.brand} ${f.line ?? ''} ${f.name}`.toLowerCase().includes(w))).slice(0, limit);
}
