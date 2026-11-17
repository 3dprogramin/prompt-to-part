// What the filament picker shows, its decisions: the library's lines of a chosen brand, and the groups
// of swatches for a brand, a line and a search text. FilamentPicker.tsx only renders these.
import { COMMON_FILAMENTS, filamentLines, pickerFilaments, searchMyFilaments, type FilamentLine, type LibraryFilament, type MyFilament } from '../../shared/filaments';

export interface PickerGroup { key: string; label: string | undefined; filaments: (LibraryFilament | MyFilament)[] }

/** One brand's lines in library order; none with no brand chosen. */
export function pickerLines(brand: string, all: FilamentLine[] = filamentLines()): FilamentLine[] {
  return brand ? all.filter((l) => l.brand === brand) : [];
}

/** The chosen line (a line key) when it is one of the brand's, else none: switching brand drops a line of another brand. */
export function validLine(brand: string, line: string, all: FilamentLine[] = filamentLines()): string {
  return pickerLines(brand, all).some((l) => l.key === line) ? line : '';
}

/**
 * The grid's groups. A search gives one group: the user's own matches (only with no brand or line chosen)
 * then the library's, within the chosen brand and line. Without one: with no brand, My filaments (when
 * there are any), Common and every line; with a brand, its lines (or the chosen one).
 */
export function pickerGroups(q: { query: string; brand: string; line: string }, mine: MyFilament[], all: FilamentLine[] = filamentLines()): PickerGroup[] {
  const line = validLine(q.brand, q.line, all);
  if (q.query.trim()) {
    const found = pickerFilaments(q.query, line || undefined).filter((f) => !q.brand || f.brand === q.brand);
    return [{ key: 'found', label: undefined, filaments: [...(q.brand || line ? [] : searchMyFilaments(mine, q.query)), ...found] }];
  }
  if (!q.brand) return [...(mine.length ? [{ key: 'mine', label: 'My filaments', filaments: mine }] : []), { key: 'common', label: 'Common', filaments: COMMON_FILAMENTS }, ...all.map((l) => ({ key: l.key, label: l.key, filaments: l.filaments }))];
  return pickerLines(q.brand, all).filter((l) => !line || l.key === line).map((l) => ({ key: l.key, label: l.key, filaments: l.filaments }));
}

/** What the grid says when a search finds nothing, and whether the same search has matches in other brands (then "Search every brand" is offered). */
export function noMatch(q: { query: string; brand: string; line: string }, all: FilamentLine[] = filamentLines()): { text: string; everyBrand: boolean } {
  if (!q.brand) return { text: 'No filament in the library matches: use a custom colour.', everyBrand: false };
  const line = validLine(q.brand, q.line, all);
  return { text: `No ${line || q.brand} filament matches.`, everyBrand: !!q.query.trim() && pickerFilaments(q.query).length > 0 };
}
