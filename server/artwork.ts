// AI artwork for designs that need real illustration (people, characters, animals, scenes): an
// image model on OpenRouter draws it in a few flat, print-friendly colours, and Jig traces each
// colour into polygons – an SVG drawing that model scripts use with H.svg, like an attached one.
import { createRequire } from 'node:module';
import jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import { MAX_SVG_POINTS, type SvgDrawing } from '../shared/svgFeatures';
import type { Vec2 } from '../shared/types';

interface TracePath { segments: { type: 'L' | 'Q'; x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number }[] }
const ImageTracer = createRequire(import.meta.url)('imagetracerjs') as {
  imagedataToTracedata(img: { width: number; height: number; data: Uint8ClampedArray }, o: Record<string, unknown>): { layers: TracePath[][] };
};

export const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image';
export const imageModel = () => process.env.JIG_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
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

/** The prompt the image model gets: Jig's print rules around Claude's subject, colours and look. */
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

/** A picture from the image model for `prompt` (with the reference photos, if any). */
export async function requestImage(prompt: string, aspect: string, references: string[] | undefined, signal?: AbortSignal, onStatus?: (text: string) => void): Promise<{ image: { data: string; mediaType: string }; model: string; cost: number | null }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('AI pictures need an OpenRouter key: set OPENROUTER_API_KEY in .env and restart Jig.');
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
        return await requestOnce(key, model, prompt, aspect, references, signal);
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
/** Used when the image model stays busy (JIG_IMAGE_FALLBACK; '' turns it off). */
export const fallbackImageModel = () => process.env.JIG_IMAGE_FALLBACK ?? 'google/gemini-nano-banana-2.1';
/** The model is rate-limited or down for a moment (HTTP 429/5xx): worth retrying. */
class BusyError extends Error {}

async function requestOnce(key: string, model: string, prompt: string, aspect: string, references: string[] | undefined, signal?: AbortSignal) {
  const content = references?.length
    ? [{ type: 'text', text: prompt }, ...references.map((url) => ({ type: 'image_url', image_url: { url } }))]
    : prompt;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Jig' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], modalities: ['image', 'text'], image_config: { aspect_ratio: aspect } }),
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
 * the same picture, painted like a collectible figurine, its sculpted detail and soft shading kept.
 * Meshy textures the model from it; Jig reduces the colours to at most 4 filaments afterwards.
 */
export function paintPrompt(subject: string): string {
  return [
    'Paint the attached picture: it shows a grey clay sculpture, which must become the same sculpture professionally painted, like a painted collectible figurine or resin miniature.',
    `Subject: ${subject.trim()}`,
    'Rules:',
    '- exactly the same figure, pose, proportions, sculpted details, framing and camera angle as the attached picture; change only the colours, add or remove nothing',
    '- keep the realistic sculpted detail and the natural, soft shading that shows the form (folds, hair, face); not flat or cartoon-like',
    '- a limited palette of a few main colours (at most 4, e.g. skin, hair, clothes, shoes), each area painted cleanly in its colour; no fine patterns, text, logos or markings',
    '- soft, even studio light; no dramatic lighting, glow, hard shadows or reflections',
    '- the same plain pure white (#FFFFFF) background, nothing added: no ground, base, props, scenery, frame, signature or watermark',
  ].join('\n');
}

interface Raster { width: number; height: number; data: Uint8Array | Uint8ClampedArray }

/** PNG or JPEG to RGBA pixels. */
export function decodeImage(buf: Buffer): Raster {
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 512 });
  if (buf[0] === 0x89 && buf[1] === 0x50) {
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
  throw new Error('The image model returned a picture format Jig can\'t read (only PNG and JPEG)');
}

const hex = (c: number[]) => '#' + c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
const rgb = (h: string) => { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

/**
 * The picture as an SvgDrawing with one shape per colour: pixels go to the nearest of the given
 * colours (or `tones` k-means colours), the white background touching the edges is dropped,
 * specks too small to print join their surroundings, and each colour is traced into polygons.
 */
export function traceArtwork(input: Raster, colors: string[] | undefined, tones: number, name: string): Pick<Artwork, 'drawing' | 'tones' | 'points'> {
  const img = downscale(input, 1400);
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

  // Background: the lightest class where it touches the edges, flood-filled.
  const lightest = classes.map((c, j) => [lum(c), j]).sort((a, b) => b[0] - a[0])[0][1];
  const BG = 255;
  const stack: number[] = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
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
  mergeSpecks(label, W, H, Math.round(N * 0.00004) + 12);

  // Trace each colour (the background traced too, then left out).
  const pal = [...cent.map(([r, g, b]) => ({ r: Math.round(r), g: Math.round(g), b: Math.round(b), a: 255 })), { r: 255, g: 0, b: 255, a: 255 }];
  const rgba = new Uint8ClampedArray(N * 4);
  const counts = new Array(cent.length).fill(0);
  for (let i = 0; i < N; i++) {
    const l = label[i] === BG ? cent.length : label[i];
    if (l < cent.length) counts[l]++;
    const p = pal[l];
    rgba[i * 4] = p.r; rgba[i * 4 + 1] = p.g; rgba[i * 4 + 2] = p.b; rgba[i * 4 + 3] = 255;
  }
  const colorOf = (j: number) => (colors ? colors[j].toLowerCase() : hex(cent[j]));
  for (const res of [1, 2, 4, 8]) {
    const td = ImageTracer.imagedataToTracedata({ width: W, height: H, data: rgba }, {
      pal, colorsampling: 0, numberofcolors: pal.length, colorquantcycles: 1, ltres: res, qtres: res, pathomit: 8 * res, rightangleenhance: false, blurradius: 0,
    });
    const shapes: SvgDrawing['shapes'] = [];
    let points = 0;
    // Darkest first, so lighter colours are painted on top.
    const order = cent.map((_, j) => j).filter((j) => counts[j]).sort((a, b) => lum(cent[a]) - lum(cent[b]));
    for (const j of order) {
      const contours = (td.layers[j] ?? []).map((p) => toContour(p, W, H)).filter((c) => c.length >= 3);
      points += contours.reduce((n, c) => n + c.length, 0);
      if (contours.length) shapes.push({ rule: 'EvenOdd', contours, color: colorOf(j) });
    }
    if (points <= MAX_SVG_POINTS || res === 8) {
      const total = counts.reduce((a, b) => a + b, 0) || 1;
      return {
        drawing: { name, aspect: W / H, shapes },
        tones: order.map((j) => ({ color: colorOf(j), share: counts[j] / total })),
        points,
      };
    }
  }
  throw new Error('unreachable');
}

function dist(a: number[], b: number[]) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function nearest(cs: number[][], c: number[]) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < cs.length; j++) { const d = dist(cs[j], c); if (d < bd) { bd = d; best = j; } }
  return best;
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

/** A traced path as a polygon: centred on (0, 0), y up, 1 unit = the picture's height. */
function toContour(p: TracePath, W: number, H: number): Vec2[] {
  const out: Vec2[] = [];
  const pt = (x: number, y: number) => out.push([(x - W / 2) / H, (H / 2 - y) / H]);
  for (const s of p.segments) {
    pt(s.x1, s.y1);
    if (s.type === 'Q') pt(0.25 * s.x1 + 0.5 * s.x2 + 0.25 * s.x3!, 0.25 * s.y1 + 0.5 * s.y2 + 0.25 * s.y3!);
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
