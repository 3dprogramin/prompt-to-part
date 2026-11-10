// generate_image, in 3D model mode: the image model draws how the object should look, from the
// user's photos and the current model if wanted, for Claude to model from. It goes into no print.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry } from '../geometry';
import { ASPECTS, designImagePrompt, imageModel } from '../artwork';
import { DESIGNS, ID_RE, IMAGE_NAME, IMAGE_TYPES } from '../routes/store';
import type { AiImages, ToolContext } from './context';

/** Most photos sent to the image model with one picture. */
const MAX_PHOTOS = 4;

/**
 * The photos the user attached in this design's chat, newest first, as data URLs (at most `max`):
 * the ones sent with this message, then those stored with earlier messages.
 */
export async function chatPhotos(designId: string, current: string[], max = MAX_PHOTOS, dir = DESIGNS): Promise<string[]> {
  const photos = current.slice(0, max);
  if (photos.length >= max || !ID_RE.test(designId)) return photos;
  let messages: { role?: string; images?: unknown }[] = [];
  try { messages = (JSON.parse(await readFile(path.join(dir, `${designId}.json`), 'utf8')) as { messages?: typeof messages }).messages ?? []; } catch { return photos; }
  const prefix = `/api/designs/${designId}/images/`;
  for (const m of [...messages].reverse()) {
    if (m.role !== 'user' || !Array.isArray(m.images)) continue;
    for (const url of m.images) {
      if (photos.length >= max) return photos;
      const name = typeof url === 'string' && url.startsWith(prefix) ? url.slice(prefix.length) : '';
      const type = IMAGE_NAME.test(name) && Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t] === name.split('.')[1]);
      if (!type) continue;
      try {
        const data = `data:${type};base64,${(await readFile(path.join(dir, designId, name))).toString('base64')}`;
        if (!photos.includes(data)) photos.push(data);
      } catch { /* no longer stored */ }
    }
  }
  return photos;
}

export type DesignImageOptions = AiImages & { designId: string; dir?: string };

export function designImageTools({ emit, drawImage, readModel, v }: ToolContext, opts: DesignImageOptions) {
  return [
    tool('generate_image', `Have the image model (${imageModel()}, Gemini) draw a picture of how the object should look, which you then model from with geometry: use it when the user asks for an image or picture to be generated (e.g. "generate an image with Gemini, then model it"), or for a concept of a complex shape they asked you to improve on. It can work from the photos the user attached in this chat (use_photos) and from a render of the current model (use_model). The picture goes into no print; the user sees it in the chat. A few cents and ~10–20 s a picture: call again only if it is wrong.`, {
      name: z.string().regex(/^[\w-]{1,40}$/).describe('A short name for the picture, e.g. "fox-v2"'),
      subject: z.string().min(10).max(2000).describe('The object to show: what it is, its shape, parts, details, colours and what to improve – be specific'),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
      style: z.string().max(400).optional().describe('The look, when not a realistic product photo of the printed object (e.g. "clay sculpture", "concept sketch")'),
      use_photos: z.boolean().optional().describe('Work from the photos the user attached in this chat (this message\'s first, then earlier ones)'),
      use_model: z.boolean().optional().describe('Work from a render of the current model.js (the design so far)'),
    }, async (a) => {
      const photos = a.use_photos ? await chatPhotos(opts.designId, opts.references, MAX_PHOTOS, opts.dir) : [];
      if (a.use_photos && !photos.length) return { content: [{ type: 'text', text: 'The user attached no photos in this chat.' }], isError: true };
      let render: string | null = null;
      if (a.use_model) {
        const code = await readModel();
        if (code == null) return { content: [{ type: 'text', text: 'There is no model.js yet to work from.' }], isError: true };
        const r = await geometry.render(code, v(), opts.signal);
        if (!r.ok || !r.png) return { content: [{ type: 'text', text: `The current model could not be rendered: ${r.ok ? 'nothing to render' : r.error.message}` }], isError: true };
        render = `data:image/png;base64,${r.png}`;
      }
      emit({ type: 'step', step: { kind: 'status', text: `Generating picture "${a.name}" with ${imageModel()}…` } });
      try {
        const references = [...photos, ...(render ? [render] : [])];
        const prompt = designImagePrompt({ subject: a.subject, style: a.style, photos: photos.length, render: !!render });
        const { image, model, cost } = await drawImage(prompt, a.aspect ?? '1:1', references.length ? references : undefined, opts.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
        const from = [photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''}` : '', render ? 'the current model' : ''].filter(Boolean).join(' and ');
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
          text: `Picture "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
          detail: `Prompt sent to ${model}${from ? ` with ${from}` : ''}:\n\n${prompt}`,
        } });
        return {
          content: [
            { type: 'image', data: image.data, mimeType: image.mediaType },
            { type: 'text', text: `Picture "${a.name}" is ready. It is a reference only: model the object from it in model.js with geometry, as closely as printing allows, and compare your render_model with it. If the picture itself is wrong, call generate_image again with a better subject.` },
          ],
        };
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Picture: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    }),
  ];
}
