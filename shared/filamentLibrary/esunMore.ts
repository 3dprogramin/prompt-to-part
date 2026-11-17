// Colours missing from the base list, with the hex from eSUN's store pages (read via the Internet Archive on 2026-11-17) and a TD from the community list, read on 2026-11-17.
// Left out: PLA+ Very Peri, whose hex is eSUN's web store swatch, which can differ a lot from the real filament.
import type { LibraryFilament } from '../filaments';

const SOURCE = 'https://github.com/penleychan/hueforge-td/blob/main/public/data/filaments/esun.json';

export const ESUN_MORE_FILAMENTS: LibraryFilament[] = [
  { brand: 'eSUN', line: 'eSilk-PLA', name: 'eSilk-PLA Gold', color: '#c48e30', td: 3.3, source: SOURCE },
  { brand: 'eSUN', line: 'eSilk-PLA', name: 'eSilk-PLA Silver', color: '#b5c1c6', td: 2.6, source: SOURCE },
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Brown', color: '#664033', td: 0.8, source: SOURCE }, // hex from the maker's store page
  { brand: 'eSUN', line: 'PLA+', name: 'PLA+ Space Blue', color: '#50d3ff', td: 3.5, source: SOURCE }, // hex from the maker's store page
];
