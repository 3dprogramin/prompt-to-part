// The CAD tools that store a line-art drawing for H.lineart: drawn by the image model
// (generate_line_art) or traced from an attached picture (trace_line_art).
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry } from '../geometry';
import { ASPECTS, decodeImage, imageModel, lineArtEditPrompt, lineArtPrompt, traceLineArt } from '../artwork';
import { encode as encodePng } from 'fast-png';
import { colourStrokes, drawingFingerprint, drawingPicture, LINE_ART_STYLE_INFO, LINE_ART_STYLES, LINEART_EDITS_KEY, parseLineArtEdits, type LineArtStyle } from '../../shared/lineart';
import { DRAWINGS_KEY, MAX_DRAWINGS, MAX_SVG_POINTS, parseDrawings, type SvgDrawing } from '../../shared/svgFeatures';
import type { LineArtOptions, ToolContext } from './context';

/** generate_line_art (when the image model can draw) and trace_line_art, for a line-art design. */
export function lineArtTools({ base, emit, drawImage, readModel, v }: ToolContext, lineArt: LineArtOptions) {
  // A traced line-art drawing: kept for every check and render from now on, and by the app with the design.
  const storeLineArt = (name: string, traced: { drawing: SvgDrawing; points: number }) => {
    if (traced.points > MAX_SVG_POINTS) throw new Error(`The drawing is too detailed to keep (${traced.points.toLocaleString('en')} points, at most ${MAX_SVG_POINTS.toLocaleString('en')}): ask for a simpler drawing with fewer, bolder lines.`);
    const drawings = parseDrawings(base[DRAWINGS_KEY]);
    if (!drawings[name] && Object.keys(drawings).length >= MAX_DRAWINGS) throw new Error(`This design already has ${MAX_DRAWINGS} drawings (${Object.keys(drawings).join(', ')}): reuse one of the names to replace it.`);
    base[DRAWINGS_KEY] = JSON.stringify({ ...drawings, [name]: traced.drawing });
    emit({ type: 'drawing', name, drawing: traced.drawing });
  };
  // Where a drawing sits in the current model (its scale, for drawing hand edits at their width), if the model uses it.
  const lineArtFrame = async (name: string) => {
    const code = await readModel();
    if (!code) return null;
    try {
      const r = await geometry.evaluate(code, v(), 'draft');
      const la = r.ok ? r.parts.find((p) => p.lineArt?.frames.some((f) => f.name === name))?.lineArt : undefined;
      const f = la?.frames.find((x) => x.name === name);
      return f && la ? { k: f.k, k0: f.k0 ?? f.k, lineWidth: la.lineWidth } : null;
    } catch { return null; }
  };
  return [
    ...(lineArt?.pictures ? [tool('generate_line_art', `Have an image model (${imageModel()}) draw line art for H.lineart in Jig's house style – bold, simplified black lines on white, like a laser-cut metal sign, that join into one piece, drawn with a line weight and detail for the piece's width – traced into a drawing. Use it when the user wants line art and attached no drawing: from a description, or from a photo of their own subject (a car, a bike, a person, a pet: use_attached_photos). Not for a picture that already is line art (trace_line_art) or an attached SVG (already a drawing: use H.lineart with it directly). Each call costs a few cents and takes ~10–20 s: describe the subject well and call again only if the drawing is wrong or not connected enough.`, {
      name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.lineart, e.g. "bike-and-car"; an existing name is replaced'),
      subject: z.string().min(10).max(2000).describe('What to draw – content only: the subject(s) left to right, their view and pose, and the features that make them recognisable (e.g. "a sport motorbike on the left and a 1967 Ford Mustang fastback on the right, both in side view facing right"). Not how to draw it (line weight, how many lines, a simple face, solid or outlined areas): Jig\'s house style sets that, the same for every design. With edit: the change to make'),
      style: z.enum(LINE_ART_STYLES).optional().describe(`The piece it is drawn for, which sets the composition (default "${lineArt.style}", the user's menu): ${LINE_ART_STYLES.map((s) => `${s} = ${LINE_ART_STYLE_INFO[s].desc.toLowerCase()}`).join('; ')}`),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 16:9 for keyholder, sign and stand, else 1:1); 16:9 or 21:9 for a key holder with several subjects side by side, 3:4 or 4:5 for a standing figure'),
      look: z.string().max(400).optional().describe('A different line style, only when the user asks for one (e.g. "thin elegant single-line drawing", "bold comic outlines")'),
      use_attached_photos: z.boolean().optional().describe('Draw from the photos the user attached to this message (their own car, bike, pet or person)'),
      width: z.number().min(40).max(1000).optional().describe('The piece\'s planned width in mm (default by style, e.g. 240 for a key holder): the line weight and the detail are drawn for it'),
      line_width: z.number().min(0.4).max(10).optional().describe('The planned lineWidth in mm (default 1)'),
      edit: z.string().regex(/^[\w-]{1,40}$/).optional().describe('Change part of an existing drawing instead of drawing a new one: its name. The image model gets that drawing as it is now (with the user\'s hand edits) and changes only what `subject` says (e.g. "replace the exhaust with a short angular Akrapovic silencer"), keeping every other line; use it for any change to part of a drawing the user likes'),
    }, async (a) => {
      if (a.use_attached_photos && !lineArt.references.length) return { content: [{ type: 'text', text: 'The user attached no photos to this message.' }], isError: true };
      const style = a.style ?? lineArt.style;
      const status = (text: string) => emit({ type: 'step', step: { kind: 'status', text } });
      const drawings = parseDrawings(base[DRAWINGS_KEY]);
      const old = a.edit ? drawings[a.edit] : undefined;
      if (a.edit && !old) return { content: [{ type: 'text', text: `There is no drawing "${a.edit}" to edit (drawings: ${Object.keys(drawings).map((n) => `"${n}"`).join(', ') || 'none'}).` }], isError: true };
      status(old ? `Changing line art "${a.edit}" with ${imageModel()}…` : `Drawing line art "${a.name}" with ${imageModel()}…`);
      try {
        const photos = a.use_attached_photos ? lineArt.references : undefined;
        let prompt: string, references = photos, aspect = a.aspect ?? (BAR_STYLES.has(style) ? '16:9' : '1:1'), lineWidth = a.line_width ?? 1;
        // A change to part of a drawing: the drawing as it is (hand edits drawn in) goes first.
        const edits = old ? parseLineArtEdits(base[LINEART_EDITS_KEY])[a.edit!] : undefined;
        const hand = edits && edits.fp === drawingFingerprint(old!) ? edits.strokes : [];
        if (old) {
          const frame = await lineArtFrame(a.edit!);
          lineWidth = frame?.lineWidth ?? lineWidth;
          const pic = drawingPicture(old, hand, 1024, frame?.k ?? 80, lineWidth, frame?.k0 ?? frame?.k ?? 80);
          references = [`data:image/png;base64,${Buffer.from(encodePng({ width: pic.width, height: pic.height, data: pic.rgba, channels: 4 })).toString('base64')}`, ...(photos ?? [])];
          prompt = lineArtEditPrompt({ change: a.subject, references: photos, width: a.width, style });
          aspect = a.aspect ?? nearestAspect(old.aspect);
        } else prompt = lineArtPrompt({ subject: a.subject, style, references, look: a.look, width: a.width, lineWidth: a.line_width });
        const { image, model, cost } = await drawImage(prompt, aspect, references, lineArt.signal, status);
        const traced = traceLineArt(decodeImage(Buffer.from(image.data, 'base64')), a.name);
        storeLineArt(a.name, traced);
        // The hand edits are in the new picture now: the drawing they were made on is gone. Their
        // colours aren't in it: they stay, on the new drawing.
        if (old && a.name === a.edit && hand.length) {
          const { [a.name]: _baked, ...rest } = parseLineArtEdits(base[LINEART_EDITS_KEY]);
          const strokes = colourStrokes(hand, lineWidth);
          const kept = strokes.length ? { fp: drawingFingerprint(traced.drawing), strokes } : undefined;
          const all = kept ? { ...rest, [a.name]: kept } : rest;
          if (Object.keys(all).length) base[LINEART_EDITS_KEY] = JSON.stringify(all); else delete base[LINEART_EDITS_KEY];
          emit({ type: 'lineArtEditsBaked', name: a.name, ...(kept ? { kept } : {}) });
        }
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
          text: `Line art "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
          detail: `Prompt sent to ${model}:\n\n${prompt}\n\nTraced for H.lineart (${traced.points.toLocaleString('en')} points).`,
        } });
        return {
          content: [
            { type: 'image', data: image.data, mimeType: image.mediaType },
            { type: 'text', text: `${lineArtReady(a.name, traced.drawing.aspect, style)} Look at the picture: if it isn't one connected drawing (loose details, a broken outline) or the subject is wrong, call generate_line_art again with a better subject.` },
          ],
        };
      } catch (e) {
        if (lineArt.signal?.aborted) throw e;
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Line art: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    })] : []),
    tool('trace_line_art', 'Trace a picture the user attached that already IS line art (dark lines on a white background: a drawing, a scan, a design from their shop) into a drawing for H.lineart, exactly as it is – no image model, free. Not for a photo of a real subject (that needs generate_line_art with use_attached_photos to be redrawn as line art) or an attached SVG (already a drawing: use H.lineart with it directly).', {
      name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.lineart, e.g. "woman"; an existing name is replaced'),
      image: z.number().int().min(1).max(8).describe('Which attached image, 1 = the first the user attached to this message'),
    }, async (a) => {
      const url = lineArt.references[a.image - 1];
      if (!url) return { content: [{ type: 'text', text: lineArt.references.length ? `The user attached ${lineArt.references.length} image${lineArt.references.length > 1 ? 's' : ''} to this message: image must be 1–${lineArt.references.length}.` : 'The user attached no images to this message.' }], isError: true };
      try {
        const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(url);
        if (!m) throw new Error(`Attached image ${a.image} isn't a PNG or JPEG picture, the only kinds Jig can trace.`);
        const traced = traceLineArt(decodeImage(Buffer.from(m[2], 'base64')), a.name);
        storeLineArt(a.name, traced);
        emit({ type: 'step', step: { kind: 'tool', ok: true, text: `Traced attached image ${a.image} as line art "${a.name}" (${traced.points.toLocaleString('en')} points)` } });
        return { content: [{ type: 'text', text: lineArtReady(a.name, traced.drawing.aspect, lineArt.style) }] };
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Line art: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    }),
  ];
}

/** Line-art styles whose drawing stands on a bar or base: their subjects share one ground line. */
const BAR_STYLES = new Set<LineArtStyle>(['keyholder', 'sign', 'stand']);

/** The image model's picture shape closest to `aspect` (width ÷ height). */
function nearestAspect(aspect: number): (typeof ASPECTS)[number] {
  const ratio = (a: string) => { const [w, h] = a.split(':').map(Number); return w / h; };
  return ASPECTS.reduce((best, a) => (Math.abs(Math.log(ratio(a) / aspect)) < Math.abs(Math.log(ratio(best) / aspect)) ? a : best));
}

/** What Claude is told when a line-art drawing is stored. */
function lineArtReady(name: string, aspect: number, style: LineArtStyle) {
  return `Line art "${name}" is ready for H.lineart("${name}", { style: '${style}', width, thickness, lineWidth, … }) (${aspect.toFixed(3)} times as wide as high; its white is open). Check the piece with render_model: the report's line-art line says how many bridges Jig had to add and how many specks it dropped.`;
}
