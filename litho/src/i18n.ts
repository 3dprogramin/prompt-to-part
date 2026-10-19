// The widget's words, in Romanian (the default) and English. Brand-neutral: the shop's own name
// never appears here. A string may hold {name} placeholders, filled by t().

export type Lang = 'ro' | 'en';
export const LANGS: Lang[] = ['ro', 'en'];

const ro = {
  // Upload
  uploadTitle: 'Alege o fotografie',
  uploadHint: 'Trage poza aici sau alege una din telefon ori calculator.',
  choosePhoto: 'Alege fotografia',
  takePhoto: 'Fă o poză',
  privacy: 'Fotografia rămâne pe dispozitivul tău: o trimitem doar când plasezi comanda.',
  loading: 'Se încarcă fotografia…',
  badFile: 'Nu am putut deschide fișierul. Încearcă o poză JPEG sau PNG.',
  // Tabs and stage
  tabFrame: 'Încadrare',
  tabLit: 'Iluminat',
  tab3d: '3D',
  frameHint: 'Trage ca să muți poza, ciupește sau folosește bara ca să mărești.',
  wrapHint: 'Poza se înfășoară în jurul lămpii; marginile din stânga și dreapta se întâlnesc.',
  litHint: 'Așa arată cu lumina aprinsă în spate.',
  unlitHint: 'Cu lumina stinsă se vede un relief alb; poza apare când o luminezi.',
  view3dHint: 'Rotește cu degetul sau mouse-ul.',
  unrolled: 'desfășurat',
  lightsOn: 'Lumina aprinsă',
  lightsOff: 'Lumina stinsă',
  zoom: 'Mărire',
  seePreview: 'Vezi cum arată',
  no3d: 'Previzualizarea 3D nu merge în acest browser.',
  // Options
  shape: 'Formă',
  shape_flat: 'Panou drept',
  shape_curved: 'Panou curbat',
  shape_cylinder: 'Lampă',
  size: 'Dimensiune',
  orientation: 'Orientare',
  landscape: 'Orizontal',
  portrait: 'Vertical',
  tones: 'Luminozitate',
  tonesHint: 'Mută spre dreapta ca să deschizi zonele întunecate.',
  diameter: 'Ø {d} × {h} cm',
  newPhoto: 'Altă fotografie',
  price: 'Preț',
  // Tips
  tipDark: 'Poza e destul de întunecată: fețele și detaliile din umbră se vor vedea greu. Alege o poză mai luminoasă sau mută bara de luminozitate spre dreapta.',
  tipBright: 'Poza e foarte luminoasă: zonele albe vor ieși foarte subțiri și fără detalii.',
  tipFlat: 'Poza are contrast mic, așa că va ieși ștearsă. Merg cel mai bine pozele clare, cu lumini și umbre.',
  tipSmall: 'Poza are rezoluție mică pentru această dimensiune: va ieși neclară. Alege o poză mai mare sau o dimensiune mai mică.',
  tipGood: 'Poza arată bine pentru o litofanie.',
  // Form
  needPhoto: 'Adaugă o fotografie înainte de a pune produsul în coș.',
  ready: 'Gata: alegerile tale și fotografia se trimit odată cu comanda.',
  // Line item properties (seen by the customer in the cart and by the shop in the order)
  propShape: 'Formă',
  propSize: 'Dimensiune',
  propPhoto: 'Fotografie',
};

export type StringKey = keyof typeof ro;

const en: Record<StringKey, string> = {
  uploadTitle: 'Choose a photo',
  uploadHint: 'Drop a picture here, or pick one from your phone or computer.',
  choosePhoto: 'Choose photo',
  takePhoto: 'Take a photo',
  privacy: 'Your photo stays on your device: it is only sent when you place the order.',
  loading: 'Loading the photo…',
  badFile: "That file couldn't be opened. Try a JPEG or PNG photo.",
  tabFrame: 'Frame',
  tabLit: 'Lit',
  tab3d: '3D',
  frameHint: 'Drag to move the photo; pinch or use the slider to zoom.',
  wrapHint: 'The photo wraps around the lamp; its left and right edges meet.',
  litHint: 'This is how it looks with the light on behind it.',
  unlitHint: 'With the light off you see a white relief; the photo appears when it is lit.',
  view3dHint: 'Rotate it with your finger or mouse.',
  unrolled: 'unrolled',
  lightsOn: 'Light on',
  lightsOff: 'Light off',
  zoom: 'Zoom',
  seePreview: 'See how it looks',
  no3d: "The 3D preview doesn't work in this browser.",
  shape: 'Shape',
  shape_flat: 'Flat panel',
  shape_curved: 'Curved panel',
  shape_cylinder: 'Lamp',
  size: 'Size',
  orientation: 'Orientation',
  landscape: 'Landscape',
  portrait: 'Portrait',
  tones: 'Brightness',
  tonesHint: 'Move right to open up the dark areas.',
  diameter: 'Ø {d} × {h} cm',
  newPhoto: 'Another photo',
  price: 'Price',
  tipDark: 'The photo is quite dark: faces and details in the shadows will be hard to see. Pick a brighter photo or move the brightness slider right.',
  tipBright: 'The photo is very bright: white areas come out very thin and without detail.',
  tipFlat: 'The photo has little contrast, so it will look washed out. Clear photos with light and shadow work best.',
  tipSmall: 'The photo is small for this size and will look blurry. Pick a larger photo or a smaller size.',
  tipGood: 'The photo looks good for a lithophane.',
  needPhoto: 'Add a photo before adding the product to the cart.',
  ready: 'Ready: your choices and the photo are sent with the order.',
  propShape: 'Shape',
  propSize: 'Size',
  propPhoto: 'Photo',
};

const STRINGS: Record<Lang, Record<StringKey, string>> = { ro, en };

/** A language from an attribute or `navigator.language`-like tag ('en-GB' → en); Romanian otherwise. */
export function pickLang(tag: string | null | undefined): Lang {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return (LANGS as string[]).includes(base) ? (base as Lang) : 'ro';
}

/** The string for `key` in `lang`, with {name} placeholders filled from `vars`. */
export function t(lang: Lang, key: StringKey, vars: Record<string, string | number> = {}): string {
  return STRINGS[lang][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
