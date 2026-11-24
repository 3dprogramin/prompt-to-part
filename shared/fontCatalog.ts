// The fonts bundled with the app (@fontsource) and the loose name matching for them. No Node
// imports, so a browser or another project can use it.
export interface StandardFont { pkg: string; family: string; weight: number; style: string }

export const STANDARD_FONTS: StandardFont[] = [
  { pkg: 'roboto', family: 'Roboto', weight: 400, style: 'Regular' },
  { pkg: 'roboto', family: 'Roboto', weight: 700, style: 'Bold' },
  { pkg: 'roboto', family: 'Roboto', weight: 900, style: 'Black' },
  { pkg: 'inter', family: 'Inter', weight: 400, style: 'Regular' },
  { pkg: 'inter', family: 'Inter', weight: 700, style: 'Bold' },
  { pkg: 'montserrat', family: 'Montserrat', weight: 700, style: 'Bold' },
  { pkg: 'montserrat', family: 'Montserrat', weight: 900, style: 'Black' },
  { pkg: 'oswald', family: 'Oswald', weight: 600, style: 'SemiBold' },
  { pkg: 'roboto-mono', family: 'Roboto Mono', weight: 700, style: 'Bold' },
  { pkg: 'bebas-neue', family: 'Bebas Neue', weight: 400, style: 'Regular' },
  { pkg: 'black-ops-one', family: 'Black Ops One', weight: 400, style: 'Regular' },
  { pkg: 'allerta-stencil', family: 'Allerta Stencil', weight: 400, style: 'Regular' },
  { pkg: 'pacifico', family: 'Pacifico', weight: 400, style: 'Regular' },
  { pkg: 'lobster', family: 'Lobster', weight: 400, style: 'Regular' },
];

export const standardFontId = (f: StandardFont): string => `std:${f.pkg}-${f.weight}`;

export const normalFontName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const REGULAR = ['regular', 'book', 'normal', 'roman', 'medium'];

/** An id or a loose name ("Montserrat Black", "Roboto Bold", "lobster") to a bundled font, else null. */
export function matchStandardFont(name: string): StandardFont | null {
  const byId = STANDARD_FONTS.find((s) => standardFontId(s) === name);
  if (byId) return byId;
  const q = normalFontName(name.replace(/^(std|sys):/, ''));
  const all = STANDARD_FONTS.map((s) => ({ s, key: normalFontName(s.family + s.style), fam: normalFontName(s.family), style: normalFontName(s.style) }));
  const hit = all.find((f) => f.key === q)
    ?? all.find((f) => f.fam === q && REGULAR.includes(f.style))
    ?? all.find((f) => f.fam === q)
    ?? all.find((f) => f.key.startsWith(q));
  return hit?.s ?? null;
}

/** The @fontsource files of a font, relative to node_modules/@fontsource. */
export const standardFontFiles = (f: StandardFont): string[] =>
  ['latin', 'latin-ext'].map((sub) => `${f.pkg}/files/${f.pkg}-${sub}-${f.weight}-normal.woff`);
