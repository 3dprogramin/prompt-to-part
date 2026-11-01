// The CAD tools that have the image model make a picture: one for H.layertone or H.lithophane
// (generate_picture), or artwork traced into a drawing for H.svg (generate_artwork).
import { loadsAtOnce } from '../../shared/printer';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ASPECTS, decodeImage, generateArtwork, imageModel, picturePrompt, requestImage } from '../artwork';
import { LAYERTONE_IMAGES_KEY, parseLayerToneImages, toLayerToneImage } from '../../shared/layertone';
import { DRAWINGS_KEY, parseDrawings } from '../../shared/svgFeatures';
import type { AiImages, ToolContext } from './context';

/** generate_picture, for a LayerTone print or (with `lithophane`) a lithophane. */
export function pictureTools({ base, emit }: ToolContext, pictures: AiImages, lithophane?: boolean) {
  // What generate_picture's pictures are for.
  const use = lithophane ? { helper: 'H.lithophane', what: 'a lithophane (H.lithophane), a white panel lit from behind' } : { helper: 'H.layertone', what: 'a LayerTone filament painting (H.layertone)' };
  return [
    tool('generate_picture', `Have an image model (${imageModel()}) make a picture for ${use.what}: realistic, with a full range of light and dark tones. Use it when the user wants a picture printed and attached no photo, or asks for a different picture. Each call costs a few cents and takes ~10–20 s.`, {
      name: z.string().regex(/^[\w-]{1,40}$/).describe(`Name to use with ${use.helper}, e.g. "portrait"`),
      subject: z.string().min(10).max(2000).describe('What to show: subject, pose, expression, lighting, composition – be specific'),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
      style: z.string().max(400).optional().describe('The look, when not a realistic photo-like picture (e.g. "oil painting", "charcoal drawing")'),
      use_attached_photos: z.boolean().optional().describe('Work from the photos the user attached to this message'),
    }, async (a) => {
      if (a.use_attached_photos && !pictures.references.length) return { content: [{ type: 'text', text: 'The user attached no photos to this message.' }], isError: true };
      emit({ type: 'step', step: { kind: 'status', text: `Generating picture "${a.name}" with ${imageModel()}…` } });
      try {
        const references = a.use_attached_photos ? pictures.references : undefined;
        const prompt = picturePrompt({ subject: a.subject, style: a.style, references, use: lithophane ? 'lithophane' : 'layertone' });
        const { image, model, cost } = await requestImage(prompt, a.aspect ?? '1:1', references, pictures.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
        const raster = decodeImage(Buffer.from(image.data, 'base64'));
        const picture = toLayerToneImage(a.name, raster.width, raster.height, raster.data);
        base[LAYERTONE_IMAGES_KEY] = JSON.stringify({ ...parseLayerToneImages(base[LAYERTONE_IMAGES_KEY]), [a.name]: picture });
        emit({ type: 'layerToneImage', name: a.name, image: picture });
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
          text: `Picture "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
          detail: `Prompt sent to ${model}:\n\n${prompt}\n\nStored for ${use.helper} as ${picture.width}×${picture.height} pixels.`,
        } });
        return {
          content: [
            { type: 'image', data: image.data, mimeType: image.mediaType },
            { type: 'text', text: `Picture "${a.name}" is ready for ${use.helper}("${a.name}", { width, … }) (${picture.width}×${picture.height} pixels, ${(picture.width / picture.height).toFixed(3)} times as wide as high). Check the print with render_model; if the picture itself is wrong, call generate_picture again with a better subject.` },
          ],
        };
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Picture: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    }),
  ];
}

/** generate_artwork, in AI artwork mode. */
export function artworkTools({ base, emit }: ToolContext, artwork: AiImages) {
  return [
    tool('generate_artwork', `Have an image model (${imageModel()}) draw real artwork, traced into an SVG drawing for H.svg: people, characters, animals, portraits, scenes and illustrations on wall art, reliefs, signs, plaques and coasters – anything you can't draw convincingly with geometry. It comes back in flat colours (the filament colours you give, or shades of grey) on no background; each colour is one shape: H.svg(name, { height, colors: [colour] }). Each call costs a few cents and takes ~10–20 s: describe the subject well and call again only if the picture is wrong.`, {
      name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.svg, e.g. "players"'),
      subject: z.string().min(10).max(2000).describe('What to draw: subject(s), pose, expression, composition and framing – be specific'),
      colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(6).optional().describe('Filament colours to draw with (#rrggbb), e.g. the ones the user has; omit for shades of grey'),
      tones: z.number().int().min(2).max(6).optional().describe('Without colors: how many shades of grey (default 4)'),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
      style: z.string().max(400).optional().describe('The look, when it should not be the default realistic posterized print (e.g. "bold cartoon", "minimal line art")'),
      use_attached_photos: z.boolean().optional().describe('Draw from the photos the user attached to this message (a person, a pet, a place)'),
    }, async (a) => {
      if (a.use_attached_photos && !artwork.references.length) return { content: [{ type: 'text', text: 'The user attached no photos to this message.' }], isError: true };
      emit({ type: 'step', step: { kind: 'status', text: `Generating artwork "${a.name}" with ${imageModel()}…` } });
      try {
        const art = await generateArtwork(a.name, { subject: a.subject, colors: a.colors, tones: a.tones, aspect: a.aspect, style: a.style, references: a.use_attached_photos ? artwork.references : undefined }, artwork.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
        // From now on every check and render can use it, and the app keeps it with the design.
        base[DRAWINGS_KEY] = JSON.stringify({ ...parseDrawings(base[DRAWINGS_KEY]), [a.name]: art.drawing });
        emit({ type: 'drawing', name: a.name, drawing: art.drawing });
        const tones = art.tones.map((t) => `  - ${t.color}: ${(t.share * 100).toFixed(1)} % of the picture`).join('\n');
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: `data:${art.image.mediaType};base64,${art.image.data}`, detailOpen: true,
          text: `Artwork "${a.name}" from ${art.model}${art.cost != null ? ` · $${art.cost.toFixed(3)}` : ''}`,
          detail: `Prompt sent to ${art.model}:\n\n${art.prompt}\n\nTraced into ${art.tones.length} colours (${art.points} points):\n${tones}`,
        } });
        return {
          content: [
            { type: 'image', data: art.image.data, mimeType: art.image.mediaType },
            { type: 'text', text: `Artwork "${a.name}" is ready: H.svg("${a.name}", { height, colors }), ${art.drawing.aspect.toFixed(3)} times as wide as high. Its white background is removed.\nColours, darkest first (share of the picture without the background):\n${tones}\nEach colour is one shape. Build the relief from them, e.g. a backing plate with each colour raised on it at its own height, or stacked layers; keep each colour as its own part for the AMS (${loadsAtOnce()}). Check the result with render_model; if the picture itself is wrong, call generate_artwork again with a better subject.` },
          ],
        };
      } catch (e) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Artwork: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    }),
  ];
}
