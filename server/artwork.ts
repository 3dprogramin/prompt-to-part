// AI artwork for designs that need real illustration (people, characters, animals, scenes): an
// image model on OpenRouter draws it in a few flat, print-friendly colours, and the app traces each
// colour into polygons – an SVG drawing that model scripts use with H.svg, like an attached one.
import jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import { checkPngSize, MAX_PIXELS } from '../shared/imageDecode';
import { MAX_SVG_POINTS, type SvgDrawing } from '../shared/svgFeatures';
import type { Vec2 } from '../shared/types';
import type { PlannedColor } from '../shared/meshes';
import { traceField, type LineArtStyle } from '../shared/lineart';

export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image';
export const imageModel = () => process.env.PTP_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
/** Artwork needs an OpenRouter key. */
export const artworkAvailable = () => !!process.env.OPENROUTER_API_KEY;
export const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;

export interface ArtworkRequest {
  /** What to draw: subject, pose, composition, mood. */
  subject: string;
  /** Filament colours to draw with (#rrggbb, 2–6); without them, `tones` shades of grey. */
  colors?: string[];
  tones?: number;
  aspect?: (typeof ASPECTS)[number];
  /** The look; default: realistic, posterized like a screen print. */
  style?: string;
  /** Photos to work from (the user's reference images), as data URLs. */
  references?: string[];
}

export interface Artwork {
  prompt: string;
  model: string;
  /** What OpenRouter charged, in USD (null if it didn't say). */
  cost: number | null;
  image: { data: string; mediaType: string };
  drawing: SvgDrawing;
  /** The traced colours, with the share of the picture (background excluded) each covers. */
  tones: { color: string; share: number }[];
  points: number;
}

const GREYS: Record<number, string[]> = {
  2: ['#111111', '#f2f2f2'],
  3: ['#111111', '#7a7a7a', '#f2f2f2'],
  4: ['#111111', '#555555', '#aaaaaa', '#f2f2f2'],
  5: ['#111111', '#444444', '#777777', '#b0b0b0', '#f2f2f2'],
  6: ['#111111', '#3a3a3a', '#636363', '#8c8c8c', '#b8b8b8', '#f2f2f2'],
};

/** The prompt the image model gets: the app's print rules around Claude's subject, colours and look. */
export function artworkPrompt(r: ArtworkRequest): string {
  const colors = r.colors?.length ? r.colors : GREYS[Math.min(6, Math.max(2, r.tones ?? 4))];
  const palette = r.colors?.length
    ? `exactly these ${colors.length} flat colours and no others: ${colors.join(', ')}`
    : `exactly ${colors.length} flat tones of grey from black to near-white (${colors.join(', ')}), like a posterized photo`;
  return [
    'Artwork for a multi-colour 3D print (a wall relief, sign or plaque): every colour is printed as its own flat layer of filament, so the picture must be made of flat colour areas only.',
    `Subject: ${r.subject.trim()}`,
    r.references?.length ? 'Work from the attached photo(s): keep the subject\'s real likeness, features and proportions.' : '',
    `Look: ${r.style?.trim() || 'realistic and detailed – true proportions, faces, anatomy, light and shadow – rendered as a high-end posterized screen print / stencil portrait, so it reads as realistic from a distance'}.`,
    `Colours: ${palette}.`,
    'Rules:',
    '- hard, clean edges between colour areas; no gradients, soft shading, textures, noise, halftone dots or hatching',
    '- every colour area large enough to print with a 0.4 mm nozzle: no specks, no hair-thin strands or lines',
    '- the subject isolated on a plain pure white (#FFFFFF) background with a margin around it; no frame, border, panel, text, signature or watermark',
  ].filter(Boolean).join('\n');
}

/** Asks the image model for the artwork and traces it. */
export async function generateArtwork(name: string, r: ArtworkRequest, signal?: AbortSignal, onStatus?: (text: string) => void): Promise<Artwork> {
  const prompt = artworkPrompt(r);
  const { image, model, cost } = await requestImage(prompt, r.aspect ?? '1:1', r.references, signal, onStatus);
  const traced = traceArtwork(decodeImage(Buffer.from(image.data, 'base64')), r.colors?.length ? r.colors : undefined, r.tones ?? 4, name);
  return { prompt, model, cost, image, ...traced };
}

/**
 * A picture from the image model for `prompt` (with the reference photos, if any). `size`: a larger
 * picture than the model's default (about 1K), e.g. '2K' for shop photos; a model that refuses it
 * draws at its default size instead.
 */
export async function requestImage(prompt: string, aspect: string, references: string[] | undefined, signal?: AbortSignal, onStatus?: (text: string) => void, size?: ImageSize): Promise<{ image: { data: string; mediaType: string }; model: string; cost: number | null }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('AI pictures need an OpenRouter key: set OPENROUTER_API_KEY in .env and restart prompt-to-part.');
  // When the model is busy upstream (rate-limited for everyone, or down for a moment): wait and
  // retry, then try the fallback model.
  const models = [...new Set([imageModel(), fallbackImageModel()].filter(Boolean))];
  let last: Error | null = null;
  for (const [mi, model] of models.entries()) {
    if (mi) onStatus?.(`${models[mi - 1]} is busy – trying ${model}…`);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        onStatus?.(`${model} is busy – retrying in ${RETRY_S[attempt - 1]} s…`);
        await new Promise((r) => setTimeout(r, RETRY_S[attempt - 1] * 1000));
        if (signal?.aborted) throw new Error('Stopped');
      }
      try {
        return await requestOnce(key, model, prompt, aspect, references, signal, size);
      } catch (e) {
        last = e as Error;
        if (!(e instanceof BusyError)) throw e;
      }
    }
  }
  throw last!;
}

/** Seconds to wait before the 2nd and 3rd try of a busy model. */
const RETRY_S = [4, 10];
/** Used when the image model stays busy (PTP_IMAGE_FALLBACK; '' turns it off). */
export const fallbackImageModel = () => process.env.PTP_IMAGE_FALLBACK ?? 'google/gemini-nano-banana-2.1';
/** The model is rate-limited or down for a moment (HTTP 429/5xx): worth retrying. */
class BusyError extends Error {}
/** Picture sizes OpenRouter's Gemini image models take (image_config.image_size); without one, 1K. */
export type ImageSize = '1K' | '2K' | '4K';

async function requestOnce(key: string, model: string, prompt: string, aspect: string, references: string[] | undefined, signal?: AbortSignal, size?: ImageSize): Promise<{ image: { data: string; mediaType: string }; model: string; cost: number | null }> {
  const content = references?.length
    ? [{ type: 'text', text: prompt }, ...references.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : prompt;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'prompt-to-part' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'], image_config: { aspect_ratio: aspect, ...(size ? { image_size: size } : {}) } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    choices?: { finish_reason?: string; native_finish_reason?: string; message?: { content?: string; refusal?: string; images?: { image_url?: { url?: string } }[] } }[];
    usage?: { cost?: number };
    error?: { message?: string; metadata?: { raw?: string } };
  };
  if (!res.ok) {
    // OpenRouter's message is often just "Provider returned error"; the provider's own text says why.
    const why = [body.error?.message, body.error?.metadata?.raw].filter(Boolean).join(': ').slice(0, 300) || `HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) throw new BusyError(`${model} is busy (${why})`);
    // A model that doesn't take the size (or not this one): a picture at its default size rather than none.
    if (size && (res.status === 400 || res.status === 422)) {
      console.warn(`[image] ${model} refused image_size ${size} (${why}): drawing at its default size`);
      return requestOnce(key, model, prompt, aspect, references, signal);
    }
    throw new Error(`The image model refused: ${why}`);
  }
  const msg = body.choices?.[0]?.message;
  const url = msg?.images?.[0]?.image_url?.url;
  const m = url && /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(url);
  if (!m) {
    const why = [msg?.refusal, msg?.content, body.choices?.[0]?.native_finish_reason ?? body.choices?.[0]?.finish_reason].filter(Boolean).join(' – ');
    throw new Error(`The image model returned no picture${why ? ` (${why.slice(0, 300)})` : ''}. It may refuse named real people or brands: describe how they look instead of naming them.`);
  }
  return { image: { data: m[2], mediaType: m[1] }, model, cost: typeof body.usage?.cost === 'number' ? body.usage.cost : null };
}

/** The prompt for a LayerTone picture: a photo-like image with a full range of tones, no print rules about flat colours. */
export function picturePrompt(r: { subject: string; style?: string; references?: string[]; use?: 'layertone' | 'lithophane' }): string {
  return [
    r.use === 'lithophane'
      ? 'A picture to be printed as a lithophane: a white panel whose thickness follows the picture, lit from behind so it glows in shades of warm light, so the picture is judged by its light and dark values alone (no colour).'
      : 'A picture to be printed as a LayerTone filament painting: a thin relief where brightness becomes height, printed in a few stacked filaments, so the picture is judged by its light and dark values.',
    `Subject: ${r.subject.trim()}`,
    r.references?.length ? 'Work from the attached photo(s): keep the subject\'s real likeness, features and proportions.' : '',
    `Look: ${r.style?.trim() || 'realistic, detailed and sharp, like a high-quality photo or a fine painting, with strong lighting and clear contrast'}.`,
    'Rules:',
    '- a full range of tones from deep shadows to bright highlights, with the subject clearly separated from the background by light',
    '- a simple, uncluttered background that is clearly lighter or darker than the subject',
    '- no frame, border, text, signature or watermark',
  ].filter(Boolean).join('\n');
}

/**
 * The prompt for a design picture in 3D model mode (generate_image): how the object should look,
 * for Claude to model from and the user to judge. `photos` user photos come first among the
 * references, then (with `render`) a render sheet of the current model.
 */
export function designImagePrompt(r: { subject: string; style?: string; photos: number; render: boolean; views?: boolean }): string {
  const refs = [
    r.photos ? `${r.photos === 1 ? 'The first attached picture is a photo' : `The first ${r.photos} attached pictures are photos`} the user gave of what they want: keep their subject, character and style, and do better than it where the request says so.` : '',
    r.render ? `The ${r.photos ? 'last' : ''} attached picture is a render sheet of the current 3D model (four views: 3D view top left, front, right side, top): it is a starting point; keep its overall design and proportions unless the request changes them, and make it look like the finished, much better object.` : '',
  ].filter(Boolean);
  // A views sheet: the one object from four sides in one picture, so every side matches (drawn
  // separately, each view would be a slightly different object).
  const views = r.views
    ? [
      '- a reference sheet of ONE object for a 3D modeller: four views of the exact same object, at the same scale, in a 2x2 grid with wide empty gaps between them: top left FRONT (the object facing the viewer), top right SIDE (seen from the viewer\'s right of the front view, so the object faces left), bottom left BACK, bottom right TOP (from directly above, its front at the bottom)',
      '- orthographic, no perspective, aligned so the heights match between FRONT, SIDE and BACK; each view whole, with a margin around it (nothing cut off)',
      '- every detail where it is on the object: a part on one side shows in the views that face that side, and not in the others',
    ]
    : ['- the whole object in view, three-quarter front view from slightly above, with a margin around it (nothing cut off)'];
  return [
    `A design picture of a 3D-printable object, which will be modelled in CAD from this picture and printed in plastic: it must show the object's shape and details clearly${r.views ? ' from every side' : ''}.`,
    `Object: ${r.subject.trim()}`,
    ...refs,
    `Look: ${r.style?.trim() || 'a realistic studio product photo of the finished, 3D-printed object, crisp and detailed'}.`,
    'Rules:',
    ...views,
    '- forms a printer can make: no hair-thin or floating parts',
    '- soft, even studio light that shows the form; a plain light background; no other objects',
    '- no text, logos, frame, signature or watermark unless the object asks for them',
  ].join('\n');
}

/** How the subjects sit in the picture for each line-art style (the app adds the bar, frame or base itself). */
const LINE_ART_COMPOSITION: Record<LineArtStyle, string> = {
  outline: 'one connected, silhouette-like drawing of the subject, readable from its outline alone',
  keyholder: 'the subjects side by side as in the request, all standing on ONE straight, horizontal ground line across the very bottom of the picture (wheels and feet resting on it), neighbouring subjects touching or slightly overlapping; each subject shown whole, top to bottom – a person head to feet, a vehicle down to its wheels – never cut off at the knees or the waist; nothing below the line',
  sign: 'the subjects side by side as in the request, all standing on ONE straight, horizontal ground line across the very bottom of the picture (wheels and feet resting on it), neighbouring subjects touching or slightly overlapping; each subject shown whole, top to bottom – a person head to feet, a vehicle down to its wheels – never cut off at the knees or the waist; nothing below the line',
  stand: 'the subjects side by side as in the request, all standing on ONE straight, horizontal ground line across the very bottom of the picture (wheels and feet resting on it), neighbouring subjects touching or slightly overlapping; each subject shown whole, top to bottom – a person head to feet, a vehicle down to its wheels – never cut off at the knees or the waist; nothing below the line',
  framed: 'the subject large, filling the picture, its outermost parts reaching close to all four sides of the picture',
  medallion: 'a compact subject that fills a circle: its outline roughly round, reaching close to the edge of the circle all around',
};

/** The width a piece of each style usually has (mm), for the line weight the image model draws at. */
export const LINE_ART_WIDTH: Record<LineArtStyle, number> = { outline: 200, keyholder: 240, framed: 200, medallion: 180, sign: 220, stand: 150 };

/**
 * The prompt for line art (generate_line_art): the house style, bold, simplified black line art
 * on white, like a laser-cut metal sign or a vinyl decal, that joins into ONE piece, so a shop's
 * designs look alike – around the subject, composed for the style (a key holder's subjects stand
 * on one ground line, a framed one fills the picture, …). The line weight and the detail suit the
 * print: at `width` mm wide with `lineWidth` mm lines, a stroke is a fixed share of the picture's
 * width, and anything finer than a few strokes can't be printed, so it is left out.
 */
export function lineArtPrompt(r: { subject: string; style: LineArtStyle; references?: string[]; look?: string; width?: number; lineWidth?: number }): string {
  const width = r.width ?? LINE_ART_WIDTH[r.style];
  // A little bolder than the thinnest printable line, so the drawing's own lines carry the look.
  const stroke = (1.4 * (r.lineWidth ?? 1)) / width;
  const at1600 = Math.max(4, Math.round(stroke * 1600));
  return [
    `Line art to be cut out of a sheet as ONE piece, about ${Math.round(width)} mm wide (a 3D-printed wall decoration in black, like laser-cut metal wall art or a vinyl car decal): the black lines are the piece, the white is empty space.`,
    `Subject: ${r.subject.trim()}`,
    r.references?.length ? 'Work from the attached photo(s): keep the real subject\'s exact model, proportions and signature features (a vehicle\'s body shape, lights and wheels; a person\'s or pet\'s likeness, hair and build), in a clean side or three-quarter view unless the subject asks for another view.' : '',
    `Look: ${r.look?.trim() || 'bold, simplified black line art on pure white, like a laser-cut metal wall sign or a vinyl decal: smooth, confident strokes, a heavier outer outline and lighter inner lines, only the lines that make the subject recognisable'}.`,
    `Composition: ${LINE_ART_COMPOSITION[r.style]}.`,
    'Rules:',
    '- pure black (#000000) lines on pure white (#FFFFFF) only: no grey, shading, hatching, gradients, textures or colour',
    `- thick strokes: every line about 1/${Math.round(1 / stroke)} of the picture's width thick (about ${at1600} px on a 1600 px wide picture), the outer outline up to twice that; never thinner, never hair-thin; smooth, unbroken, not sketchy or doubled`,
    `- open space: any two lines at least one stroke width apart; leave out every detail smaller than about three stroke widths – it can't be printed at this size`,
    '- simplified: the main body contours, wheels as a thick tyre ring with a few bold spokes or rim shapes, lights, windows and a few main panel or fold lines; no small parts, mechanical internals, cables, bolts, mesh or grille patterns, textures, or small text and logos',
    '- every line joins the others so the whole drawing is ONE connected piece: no floating details – an eye, a badge, a wheel hub, a window must touch a line',
    '- it is stuck to a wall with tape on its back, so nothing may dangle: every line starts and ends on another line (no line ending in empty space), and parts such as mirrors, handles, brackets and badges are joined at two or more points, like a web',
    '- a few larger solid black areas (window glass, tyres, a seat, hair) give the tape room to hold – include them where they suit the subject; everything else stays open line work',
    '- the subject isolated with a white margin around it; no text, signature, watermark, frame, border, panel or background scenery',
  ].filter(Boolean).join('\n');
}

/**
 * The prompt for changing part of a line-art drawing (generate_line_art with edit): the drawing as
 * it is now is the attached picture, and only `change` may differ – same subjects, layout, lines
 * and line weight everywhere else, under the same print rules.
 */
export function lineArtEditPrompt(r: { change: string; references?: string[]; width?: number; style: LineArtStyle }): string {
  return [
    `Edit the attached picture: it is black line art for a one-piece wall cut-out, about ${Math.round(r.width ?? LINE_ART_WIDTH[r.style])} mm wide, 3D-printed in black.`,
    `Change only this: ${r.change.trim()}`,
    r.references?.length ? 'The other attached photo(s) show the real subject: use them for the part you change.' : '',
    'Keep everything else exactly as it is: the same picture size and framing, the same subjects in the same places and poses, and every other line where it is, at the same weight – copy them, don\'t redraw them.',
    ...LINE_ART_EDIT_RULES,
  ].filter(Boolean).join('\n');
}

/** The print rules for what an edit of line art changes (lineArtEditPrompt, and a marked picture edit of a line-art drawing). */
export const LINE_ART_EDIT_RULES = [
  'Rules for what you change:',
  '- pure black (#000000) lines on pure white (#FFFFFF), the same line weight and bold, simplified style as the rest of the picture; no grey, shading, hatching or textures',
  '- it joins the lines around it, so the drawing stays ONE connected piece with nothing floating or dangling',
  '- no detail smaller than about three line widths; no text, signature or watermark',
];

/** The longest side traceLineArt traces at: a larger picture is box-filtered down by a whole factor first. */
export const LINE_TRACE_MAX_SIDE = 2400;

/**
 * Line art (black on white: the image model's, or an attached picture that already is line art)
 * as a drawing for H.lineart: one black shape, the white between its lines as holes in it (EvenOdd)
 * and the white background touching the edges dropped. A white shape on top would only repeat
 * those holes, so it is left out: half the points, so finer tracing within MAX_SVG_POINTS.
 */
export function traceLineArt(input: Raster, name: string): Pick<Artwork, 'drawing' | 'points'> {
  // Ink and paper split where the picture's own tones split (Otsu), so a pencil sketch on cream
  // paper or a grey-ish JPEG keeps its lines.
  const n = input.width * input.height, hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) hist[Math.round(0.2126 * input.data[i * 4] + 0.7152 * input.data[i * 4 + 1] + 0.0722 * input.data[i * 4 + 2])]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let best = 128, bestVar = -1, wB = 0, sumB = 0;
  for (let t = 0; t < 255; t++) {
    wB += hist[t]; sumB += t * hist[t];
    const wF = n - wB;
    if (!wB || !wF) continue;
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (v > bestVar) { bestVar = v; best = t; }
  }
  const cut = Math.min(200, Math.max(60, best));
  // The ink traced straight from the picture's own pixels (not the colour tracer, which would cut
  // curves into a few chords and drop short lines): marching squares on the darkness, at the
  // threshold, so anti-aliased edges land between pixels. A 2-pixel empty border closes every outline.
  const img = downscale(input, LINE_TRACE_MAX_SIDE);
  const W = img.width + 4, H = img.height + 4, ink = new Float32Array(W * H);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const i = (y * img.width + x) * 4;
    ink[(y + 2) * W + x + 2] = 1 - (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
  }
  // Drawing units: 1 = the picture's height, centred, y up.
  const px = 1 / img.height;
  const grid = { w: W, h: H, px, x0: -img.width / 2 / img.height - 2 * px, y1: 0.5 + 2 * px };
  let contours: Vec2[][] = [], points = Infinity;
  for (let tol = 0.3; points > MAX_SVG_POINTS && tol < 20; tol *= 1.6) {
    contours = traceField(ink, grid, 1 - (cut + 0.5) / 255, tol * px) as Vec2[][];
    points = contours.reduce((n, c) => n + c.length, 0);
  }
  const drawing: SvgDrawing = { name, aspect: img.width / img.height, shapes: contours.length ? [{ rule: 'EvenOdd', contours, color: '#000000' }] : [] };
  return { drawing, points };
}

/**
 * The prompt for a concept picture (generate_concept): the subject alone as a grey clay sculpture,
 * the way image-to-3D reads a picture best – one subject, whole, lit evenly, on plain white. Meshy
 * infers the shape mostly from the shading, so a coloured figure starts from this same picture too
 * (paintPrompt paints it afterwards).
 */
export function conceptPrompt(subject: string): string {
  return [
    'A concept picture for an AI image-to-3D generator, which will sculpt a 3D-printable figure from it: the picture must show the shape only.',
    `Subject: ${subject.trim()}`,
    'Rules:',
    '- the single subject only, full body, in the pose described, three-quarter front view, the whole subject in frame with a margin around it (nothing cut off)',
    '- rendered as a neutral grey clay / sculpture render: one matte grey material, no colours, no textures painted on, no text, logos or markings',
    '- soft, even studio light with gentle shading that shows the form; no hard shadows, no dramatic lighting',
    '- a plain pure white (#FFFFFF) background; nothing else in the scene (only what the subject wears or holds): no ground, base, props, scenery or other figures, no frame, signature or watermark',
  ].join('\n');
}

/**
 * The prompt that paints a grey concept picture (attached as the reference) for a coloured figure:
 * the same picture, painted like a collectible figurine in `palette` (each "colour: the parts in it",
 * at most 4) under soft light, so Meshy's texture holds the paint colours rather than light and shade.
 * Meshy textures the model from it; the app reduces the colours to at most 4 filaments afterwards.
 */
export function paintPrompt(subject: string, palette?: PlannedColor[]): string {
  const colours = palette?.length
    ? [`- paint it in exactly these ${palette.length} colours and no others, every area in the colour listed for it:`, ...palette.map((c, i) => `  ${i + 1}. ${c.name} (${c.color}): ${c.parts}`), '- anything not listed takes the listed colour closest to it; no extra colours, no accents, no gradients between colours']
    : ['- a limited palette of a few main colours (at most 4, e.g. skin, hair, clothes, shoes), each area painted cleanly in its colour'];
  return [
    'Paint the attached picture: it shows a grey clay sculpture, which must become the same sculpture professionally painted, like a painted collectible figurine or resin miniature.',
    `Subject: ${subject.trim()}`,
    'Rules:',
    '- exactly the same figure, pose, proportions, sculpted details, framing and camera angle as the attached picture; change only the colours, add or remove nothing',
    ...colours,
    '- each colour solid and even over its whole area, the same in light and in shade; no fine patterns, text, logos or markings',
    '- still a photo of the same 3D sculpture with its sculpted detail, not a drawing or illustration: no outlines, no cel shading',
    '- soft, diffuse light from all around, as in a light tent: only gentle shading, no cast or dark shadows, no highlights, glow or reflections',
    '- the same plain pure white (#FFFFFF) background, nothing added: no ground, base, props, scenery, frame, signature or watermark',
  ].join('\n');
}

interface Raster { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

/** PNG or JPEG to RGBA pixels. */
export function decodeImage(buf: Buffer): Raster {
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512, maxResolutionInMP: MAX_PIXELS / 1e6 });
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    checkPngSize(buf);
    const p = decodePng(buf);
    const n = p.width * p.height, ch = p.channels, data = new Uint8Array(n * 4);
    const src = p.data as ArrayLike<number>;
    const scale = p.depth === 16 ? 1 / 257 : 1;
    for (let i = 0; i < n; i++) {
      const grey = ch < 3;
      for (let c = 0; c < 3; c++) data[i * 4 + c] = src[i * ch + (grey ? 0 : c)] * scale;
      data[i * 4 + 3] = 255;
    }
    return { width: p.width, height: p.height, data };
  }
  throw new Error('The image model returned a picture format that can\'t be read (only PNG and JPEG)');
}

/** An RGB triple as #rrggbb (each channel rounded and clamped). */
export const hex = (c: number[]) => '#' + c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
/** A #rrggbb colour as an RGB triple. */
export const rgb = (h: string) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

/** Pictures are traced at most this many pixels on the long side (larger ones are box-filtered down by a whole factor). */
export const TRACE_MAX_SIDE = 2400;

export interface TraceOptions {
  /**
   * 1 where the picture is background (one byte per pixel of `input`): the background is then the
   * lightest colour flood-filled from these pixels instead of from the picture's edges.
   */
  background?: Uint8Array;
  /** The most points the drawing may have (default MAX_SVG_POINTS); the outlines are simplified harder until it fits. */
  budget?: number;
}

/**
 * The picture as an SvgDrawing with one shape per colour: pixels go to the nearest of the given
 * colours (or `tones` k-means colours), the white background touching the edges is dropped,
 * specks too small to print join their surroundings, and each colour is traced into polygons.
 * Colours in `omit` are traced (they are holes in the others) but left out of the drawing.
 */
export function traceArtwork(input: Raster, colors: string[] | undefined, tones: number, name: string, omit: string[] = [], opts: TraceOptions = {}): Pick<Artwork, 'drawing' | 'tones' | 'points'> {
  const img = downscale(input, TRACE_MAX_SIDE);
  const { width: W, height: H, data } = img;
  const N = W * H;
  const px = (i: number) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  // The colours: the requested ones, or k-means. It starts from a colour histogram: the most common
  // colour, then each time the one that is common and far from those chosen (k-means++, greedy), so
  // a small tone such as highlights or eyes gets its own colour while stray JPEG pixels don't.
  let cent: number[][];
  if (colors) cent = colors.map(rgb);
  else {
    const k = Math.min(6, Math.max(2, tones));
    const sample: number[] = [];
    for (let i = 0; i < N; i += 7) sample.push(i);
    const bins = new Map<number, number[]>();
    for (const i of sample) {
      const c = px(i), key = ((c[0] >> 5) << 6) | ((c[1] >> 5) << 3) | (c[2] >> 5);
      const b = bins.get(key) ?? [0, 0, 0, 0];
      b[0] += c[0]; b[1] += c[1]; b[2] += c[2]; b[3]++;
      bins.set(key, b);
    }
    const hist = [...bins.values()].map((b) => ({ c: [b[0] / b[3], b[1] / b[3], b[2] / b[3]], n: b[3] }));
    cent = [hist.reduce((a, b) => (b.n > a.n ? b : a)).c];
    while (cent.length < k) {
      const next = hist.reduce((best, h) => { const s = h.n * Math.min(...cent.map((c) => dist(c, h.c))); return s > best.s ? { s, c: h.c } : best; }, { s: -1, c: [0, 0, 0] });
      if (next.s <= 0) break;
      cent.push(next.c);
    }
    for (let it = 0; it < 12; it++) {
      const sum = cent.map(() => [0, 0, 0, 0]);
      for (const i of sample) { const c = px(i), s = sum[nearest(cent, c)]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++; }
      cent = cent.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c));
    }
  }
  // A white background class when no colour is close to white (the prompt asks for a white background).
  const white = [255, 255, 255];
  const bgExtra = !cent.some((c) => dist(c, white) < 60 ** 2);
  const classes = bgExtra ? [...cent, white] : cent;
  const label = new Uint8Array(N);
  for (let i = 0; i < N; i++) label[i] = nearest(classes, px(i));

  // Background: the lightest class where it touches the edges (or the given background), flood-filled.
  const lightest = classes.map((c, j) => [lum(c), j]).sort((a, b) => b[0] - a[0])[0][1];
  const BG = 255;
  const stack: number[] = [];
  if (opts.background) {
    const seeds = downscaleMask(opts.background, input.width, input.height, W, H);
    for (let i = 0; i < N; i++) if (seeds[i]) stack.push(i);
  } else {
    for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
    for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    if (label[i] !== lightest) continue;
    label[i] = BG;
    const x = i % W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (i >= W) stack.push(i - W);
    if (i < N - W) stack.push(i + W);
  }
  // White inside the subject that isn't one of the colours joins the nearest real colour.
  if (bgExtra) for (let i = 0; i < N; i++) if (label[i] === cent.length) label[i] = nearest(cent, px(i));
  // Strips a pixel wide where two colours meet (their blend read as a third colour) join their
  // neighbours; then specks too small to matter join their surroundings.
  cleanSlivers(label, W, H, 2);
  mergeSpecks(label, W, H, Math.round(N * 0.00001) + 8);

  const counts = new Array(cent.length).fill(0);
  for (let i = 0; i < N; i++) if (label[i] !== BG) counts[label[i]]++;
  const colorOf = (j: number) => (colors ? colors[j].toLowerCase() : hex(cent[j]));
  // Darkest first, so lighter colours are painted on top.
  const order = cent.map((_, j) => j).filter((j) => counts[j]).sort((a, b) => lum(cent[a]) - lum(cent[b]));
  const rank = new Int16Array(N).fill(-1);
  order.forEach((j, k) => { for (let i = 0; i < N; i++) if (label[i] === j) rank[i] = k; });
  // Each colour is traced with everything painted on top of it (the lighter colours inside it), so
  // two colours that meet share one edge – no gaps between them – and the shapes painted on top cut
  // the rest out again. Marching squares on the lightly smoothed area (a 2-pixel empty border
  // closes the outlines) keeps curves smooth and short details whole.
  const GW = W + 4, GH = H + 4;
  const grid = { w: GW, h: GH, px: 1 / H, x0: -W / 2 / H - 2 / H, y1: 0.5 + 2 / H };
  const fields = order.map((_, k) => {
    const m = new Uint8Array(GW * GH);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rank[y * W + x] >= k) m[(y + 2) * GW + x + 2] = 1;
    const v = new Float32Array(GW * GH);
    for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
      const i = y * GW + x;
      v[i] = (m[i - GW - 1] + m[i - GW] + m[i - GW + 1] + m[i - 1] + m[i] + m[i + 1] + m[i + GW - 1] + m[i + GW] + m[i + GW + 1]) / 9;
    }
    return v;
  });
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  let out: Pick<Artwork, 'drawing' | 'tones' | 'points'> | null = null;
  for (let tol = 0.3; !out; tol *= 2) {
    const shapes: SvgDrawing['shapes'] = [];
    let points = 0;
    order.forEach((j, k) => {
      if (omit.includes(colorOf(j))) return;
      const contours = traceField(fields[k], grid, 0.5, tol / H) as Vec2[][];
      points += contours.reduce((n, c) => n + c.length, 0);
      if (contours.length) shapes.push({ rule: 'EvenOdd', contours, color: colorOf(j) });
    });
    if (points <= (opts.budget ?? MAX_SVG_POINTS) || tol > 8) out = { drawing: { name, aspect: W / H, shapes }, tones: order.map((j) => ({ color: colorOf(j), share: counts[j] / total })), points };
  }
  return out;
}

function dist(a: number[], b: number[]) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function nearest(cs: number[][], c: number[]) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < cs.length; j++) { const d = dist(cs[j], c); if (d < bd) { bd = d; best = j; } }
  return best;
}

/** Pixels with at most two of the same label around them (a strip one pixel wide) take the label most of their neighbours have. */
function cleanSlivers(label: Uint8Array, W: number, H: number, passes: number) {
  const tally = new Map<number, number>();
  for (let pass = 0; pass < passes; pass++) {
    const was = label.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, l = was[i];
      let same = 0;
      tally.clear();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const n = was[i + dy * W + dx];
        if (n === l) same++; else tally.set(n, (tally.get(n) ?? 0) + 1);
      }
      if (same <= 2 && tally.size) label[i] = [...tally].sort((a, b) => b[1] - a[1])[0][0];
    }
  }
}

/** Connected areas smaller than `min` pixels take the label most of their neighbours have. */
function mergeSpecks(label: Uint8Array, W: number, H: number, min: number) {
  const N = W * H, seen = new Uint8Array(N), comp: number[] = [];
  for (let s = 0; s < N; s++) {
    if (seen[s]) continue;
    const l = label[s];
    comp.length = 0; comp.push(s); seen[s] = 1;
    const nb = new Map<number, number>();
    for (let q = 0; q < comp.length; q++) {
      const i = comp[q], x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1]) {
        if (j < 0) continue;
        if (label[j] === l) { if (!seen[j]) { seen[j] = 1; comp.push(j); } } else nb.set(label[j], (nb.get(label[j]) ?? 0) + 1);
      }
    }
    if (comp.length < min && nb.size) {
      const to = [...nb].sort((a, b) => b[1] - a[1])[0][0];
      for (const i of comp) label[i] = to;
    }
  }
}


/** A W x H mask of a w x h one box-filtered down as `downscale` does (by a whole factor): 1 where most of a block is. */
function downscaleMask(m: Uint8Array, w: number, h: number, W: number, H: number): Uint8Array {
  if (m.length !== w * h) throw new Error(`The background mask has ${m.length} pixels, the picture ${w * h}`);
  if (W === w && H === h) return m;
  const f = Math.ceil(Math.max(w, h) / TRACE_MAX_SIDE), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += m[(y * f + dy) * w + x * f + dx] ? 1 : 0;
    out[y * W + x] = 2 * s >= f * f ? 1 : 0;
  }
  return out;
}

/** Box-filtered down to at most `max` pixels on the long side. */
function downscale(img: Raster, max: number): Raster {
  const f = Math.ceil(Math.max(img.width, img.height) / max);
  if (f <= 1) return img;
  const W = Math.floor(img.width / f), H = Math.floor(img.height / f), out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += img.data[((y * f + dy) * img.width + x * f + dx) * 4 + c];
      out[(y * W + x) * 4 + c] = s / (f * f);
    }
  }
  return { width: W, height: H, data: out };
}
