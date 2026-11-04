import type { GenerateRequest } from './api';

/** Starter ideas for the new-design screen, and the parsing of the model's "Give me 4 new ideas" answer. */

export type IdeaMode = NonNullable<GenerateRequest['imageMode']>;
export interface Idea { text: string; mode: IdeaMode }

export const MAX_IDEA_CHARS = 120;

/** Hand-written, in priority order: the first of each mode is that mode's showcase. */
export const STARTERS: Idea[] = [
  { mode: 'off', text: 'A stackable drawer cabinet: 3 drawers on printed rails, a label slot on each front' },
  { mode: 'layertone', text: 'A mountain lake at dawn with pine trees, about 15 cm wide' },
  { mode: 'lithophane', text: 'The full moon as a round night light, 10 cm across' },
  { mode: 'lineart', text: 'Key holder: a bicycle and a dog on a bar, hung with tape' },
  { mode: 'artwork', text: 'A fox in an autumn forest as colour wall art, 15 cm wide' },
  { mode: 'figure', text: 'A small dragon sitting on a rock, 8 cm tall' },
  { mode: 'off', text: 'A headphone hook that clamps to a desk edge with a thumb screw' },
  { mode: 'off', text: 'A cable clip for a 6 mm cable on a 20 mm desk edge' },
  { mode: 'off', text: 'A hinged SD card box with 12 slots' },
  { mode: 'off', text: 'A stand for a phone and a pen, 9 cm wide, with a cable slot at the back' },
  { mode: 'off', text: 'A small plant pot with a drip tray, 8 cm across' },
  { mode: 'off', text: 'A coaster set of 4 with a holder, 10 cm across' },
  { mode: 'off', text: 'A wall hook for keys with 3 hooks and a shelf, 15 cm wide' },
  { mode: 'layertone', text: 'A city skyline at night with a full moon, 12 cm wide' },
  { mode: 'lithophane', text: 'A round night light of a sleeping cat, 10 cm across' },
  { mode: 'lineart', text: 'A name sign with a cat and a plant, 15 cm wide, hung with tape' },
];

const ORDER: IdeaMode[] = ['off', 'layertone', 'lithophane', 'lineart', 'artwork', 'figure'];

/** The modes ideas can be for: 3D model always, the picture modes with an image model, the figure with Meshy. */
export function ideaModes(o: { artwork: boolean; meshy: boolean }): IdeaMode[] {
  const m: IdeaMode[] = ['off'];
  if (o.artwork) m.push('artwork', 'layertone', 'lithophane', 'lineart');
  if (o.meshy) m.push('figure');
  return m;
}

/** The ideas to show first: each available mode's showcase in turn, then more 3D model ones. */
export function pickStarters(modes: IdeaMode[], count = 4): Idea[] {
  const out: Idea[] = [];
  for (const m of ORDER) {
    if (out.length >= count) break;
    if (!modes.includes(m)) continue;
    const s = STARTERS.find((x) => x.mode === m);
    if (s) out.push(s);
  }
  for (const s of STARTERS) {
    if (out.length >= count) break;
    if (s.mode === 'off' && !out.includes(s)) out.push(s);
  }
  return out;
}

/** One idea as a single plain line: no list marker, quotes or long dashes, at most 120 characters. */
export function cleanIdeaText(s: string): string {
  let t = s.trim().replace(/^(?:\d+[.)]|[-*•])\s+/, '').trim();
  t = t.replace(/^["'“‘](.*)["'”’]$/s, '$1');
  t = t.replace(/\s+[\u2013\u2014]\s+/g, ', ').replace(/[\u2013\u2014]/g, '-');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_IDEA_CHARS) {
    let cut = t.slice(0, MAX_IDEA_CHARS);
    if (t[MAX_IDEA_CHARS] !== ' ') {
      const sp = cut.lastIndexOf(' ');
      if (sp > 0) cut = cut.slice(0, sp);
    }
    t = cut.replace(/[\s,;:]+$/, '');
  }
  return t;
}

const MODE_IDEA_HINTS: Record<IdeaMode, string> = {
  off: 'Everything modelled in 3D: useful objects, holders, boxes, parts, and people, characters and animals as 3D objects.',
  artwork: 'An image model draws the subject (a person, an animal, a scene or an object) as flat artwork, then it is turned into colour layers for wall art, reliefs and signs.',
  layertone: 'A picture printed flat as a thin relief, painted by stacked filaments that let the ones below show through.',
  lithophane: 'A photo-like picture in white PLA, thick where dark and thin where bright, that glows lit from behind: night lights, frames, lamp shades.',
  lineart: 'A drawing cut out as one flat piece in one colour, about 2 mm thick with 1 mm lines, to hang with tape: key-holder bars, figures in a frame, name signs.',
  figure: 'A sculpted 3D model of a person, character or animal from a description, with the base, name or mount added.',
};

export const IDEAS_SYSTEM_PROMPT = `You suggest starting ideas for someone new to prompt-to-part, an app that designs things for 3D printing in PLA from a description.
A good idea shows off what its mode can do, is concrete, has a size, and is one line under ${MAX_IDEA_CHARS} characters, written the way the user would type it into the chat (for example "A mountain lake at dawn with pine trees, about 15 cm wide").
Never use long dashes; use a plain hyphen, a comma or a colon.
Answer with ONLY a JSON array, nothing before or after it: [{"text": "...", "mode": "off" | "artwork" | "layertone" | "lithophane" | "lineart" | "figure"}]. Use only the modes you are told are allowed.`;

export function ideasPrompt(o: { modes: IdeaMode[]; bed: [number, number]; height: number; printerName: string; shown: string[] }): string {
  const lines = [
    `Give me 4 new ideas${o.modes.length >= 4 ? ', each in a different mode' : ''}.`,
    `The printer is a ${o.printerName} with a ${o.bed[0]} x ${o.bed[1]} mm bed, up to ${o.height} mm tall.`,
    'Allowed modes:',
    ...o.modes.map((m) => `- ${m}: ${MODE_IDEA_HINTS[m]}`),
  ];
  if (o.shown.length) lines.push('Already shown, give different ones:', ...o.shown.map((t) => `- ${t}`));
  return lines.join('\n');
}

/** The end of the JSON array that starts at `from`, skipping brackets inside strings; -1 when it never closes. */
function arrayEnd(text: string, from: number): number {
  let depth = 0, inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

/** The model's answer as ideas: the first JSON array, only entries for allowed modes, cleaned, distinct, at most 4. */
export function parseIdeas(text: string, modes: IdeaMode[]): Idea[] {
  const fail = () => new Error('No ideas came back');
  const start = text.indexOf('[');
  const end = start < 0 ? -1 : arrayEnd(text, start);
  if (end < 0) throw fail();
  let arr: unknown;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { throw fail(); }
  if (!Array.isArray(arr)) throw fail();
  const out: Idea[] = [];
  const seen = new Set<string>();
  for (const e of arr) {
    if (out.length >= 4) break;
    if (!e || typeof e !== 'object') continue;
    const { text: raw, mode } = e as { text?: unknown; mode?: unknown };
    if (typeof raw !== 'string' || typeof mode !== 'string' || !modes.includes(mode as IdeaMode)) continue;
    const t = cleanIdeaText(raw);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ text: t, mode: mode as IdeaMode });
  }
  return out;
}

/** `ideas`, then starters in the available modes that are not in `ideas` or `avoid`, until `count`. */
export function topUp(ideas: Idea[], modes: IdeaMode[], avoid: string[], count = 4): Idea[] {
  const out = [...ideas];
  const used = new Set([...ideas.map((i) => i.text), ...avoid]);
  for (const s of STARTERS) {
    if (out.length >= count) break;
    if (modes.includes(s.mode) && !used.has(s.text)) { out.push(s); used.add(s.text); }
  }
  return out;
}
