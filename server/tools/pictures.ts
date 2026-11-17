// The CAD tools that have the image model make a picture: one for H.layertone or H.lithophane
// (generate_picture), or artwork traced into a drawing for H.svg (generate_artwork).
import { loadsAtOnce } from '../../shared/printer';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ASPECTS, decodeImage, generateArtwork, imageModel, picturePrompt } from '../artwork';
import { encode as encodePng } from 'fast-png';
import { cleanFilaments, LAYERTONE_IMAGES_KEY, LAYERTONE_KEY, maxLayerToneFilaments, parseLayerToneImages, parseLayerToneSetup, stackSwapsAt, stripSwaps, toLayerToneImage, toStripImage, type LayerToneStack } from '../../shared/layertone';
import { stripPng } from '../layerToneStrip';
import { chatPhotos } from './designImage';
import { DRAWINGS_KEY, parseDrawings } from '../../shared/svgFeatures';
import type { AiImages, ToolContext } from './context';

/** generate_picture, for a LayerTone print or (with `lithophane`) a lithophane. */
export function pictureTools({ base, emit, drawImage }: ToolContext, pictures: AiImages, lithophane?: boolean) {
  // What generate_picture's pictures are for.
  const use = lithophane ? { helper: 'H.lithophane', what: 'a lithophane (H.lithophane), a white panel lit from behind' } : { helper: 'H.layertone', what: 'a LayerTone filament painting (H.layertone)' };
  return [
    tool('generate_picture', `Have an image model (${imageModel()}) make a picture for ${use.what}: realistic, with a full range of light and dark tones. Use it when the user wants a picture printed and attached no photo, or asks for a different picture.${lithophane ? '' : ' For LayerTone, give the filament stack (filaments, bottom to top, and max_height): the image model gets the strip of colours that stack prints and draws only in them, and with use_attached_photos it repaints the user\'s photo for the stack (name it e.g. "photo-1-toned"). The picture is stored for that stack and its swap layers are fixed in the LayerTone setup.'} Each call costs a few cents and takes ~10-20 s.`, {
      name: z.string().regex(/^[\w-]{1,40}$/).describe(`Name to use with ${use.helper}, e.g. "portrait"`),
      subject: z.string().min(10).max(2000).describe('What to show: subject, pose, expression, lighting, composition – be specific'),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
      style: z.string().max(400).optional().describe('The look, when not a realistic photo-like picture (e.g. "oil painting", "charcoal drawing")'),
      use_attached_photos: z.boolean().optional().describe(lithophane ? 'Work from the photos the user attached in this chat (this message\'s, or the earlier ones when it has none)' : 'Repaint the photos the user attached in this chat (this message\'s, or the earlier ones when it has none) for the filament stack, likeness kept'),
      ...(lithophane ? {} : {
        filaments: z.array(z.object({
          name: z.string().min(1).max(80), brand: z.string().max(60).optional(),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/), td: z.number().positive().max(100),
        })).min(1).max(maxLayerToneFilaments()).optional().describe('Required for LayerTone: the filament stack, bottom (first printed) to top, as you will pass it to H.layertone'),
        max_height: z.number().min(0.4).max(10).optional().describe('The max height (mm) you will build H.layertone with (default 1.6; ~2.4 with a translucent top filament)'),
        base_height: z.number().min(0.16).max(5).optional().describe('The base height (mm) you will build H.layertone with, only if not the default 0.48'),
      }),
    }, async (a) => {
      // This message's photos, or those of earlier messages in the chat when it has none (e.g. sent before an answer to a question).
      const photos = a.use_attached_photos ? await chatPhotos(pictures.designId ?? '', pictures.references) : [];
      if (a.use_attached_photos && !photos.length) return { content: [{ type: 'text', text: 'The user attached no photos in this chat.' }], isError: true };
      const lt = a as { filaments?: unknown; max_height?: number; base_height?: number };
      const filaments = lithophane ? undefined : cleanFilaments(lt.filaments);
      if (!lithophane && !filaments) return { content: [{ type: 'text', text: 'Settle the filament stack first and pass it as filaments (bottom to top, the same list you build H.layertone with): the picture is drawn in the colours that stack prints.' }], isError: true };
      const o = { width: 100, maxHeight: lt.max_height ?? 1.6, baseHeight: lt.base_height ?? 0.48 };
      const stack: LayerToneStack | undefined = filaments && { filaments, swaps: stripSwaps(filaments, o), maxHeight: o.maxHeight, baseHeight: o.baseHeight };
      emit({ type: 'step', step: { kind: 'status', text: `Generating picture "${a.name}" with ${imageModel()}…` } });
      try {
        const strip = stack && stripPng(stack, o);
        if (stack && strip) {
          emit({ type: 'step', step: {
            kind: 'render', ok: true, image: strip.dataUrl, detailOpen: true,
            text: `Colour strip of the print: ${stack.filaments.map((f) => f.name).join(', ')}`,
            detail: `The colours this stack prints, lowest layer (left) to highest (right), at max height ${o.maxHeight} mm. Sent to ${imageModel()} with the prompt; the picture is drawn only in them.`,
          } });
        }
        const references = [...photos, ...(strip ? [strip.dataUrl] : [])];
        const prompt = picturePrompt({ subject: a.subject, style: a.style, references: photos.length ? photos : undefined, use: lithophane ? 'lithophane' : 'layertone', ...(stack ? { strip: { filaments: stack.filaments, repaint: !!a.use_attached_photos } } : {}) });
        const { image, model, cost } = await drawImage(prompt, a.aspect ?? '1:1', references.length ? references : undefined, pictures.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }));
        const raster = decodeImage(Buffer.from(image.data, 'base64'));
        let picture = stack ? toStripImage(a.name, raster.width, raster.height, raster.data, stack, o) : toLayerToneImage(a.name, raster.width, raster.height, raster.data);
        // The colour picture is kept with the design (for the chat and for edits).
        if (stack && pictures.designId) picture = { ...picture, colour: await (await import('../routes/store')).storeDesignPicture(pictures.designId, encodePng({ width: raster.width, height: raster.height, data: raster.data, channels: 4 })) };
        base[LAYERTONE_IMAGES_KEY] = JSON.stringify({ ...parseLayerToneImages(base[LAYERTONE_IMAGES_KEY]), [a.name]: picture });
        emit({ type: 'layerToneImage', name: a.name, image: picture });
        // The strip's swaps as they print: moved up with a raised first filament (the setup's baseHeight).
        const fixed = stack && stackSwapsAt(stack, parseLayerToneSetup(base[LAYERTONE_KEY]).baseHeight);
        if (stack && fixed) {
          // The strip's swaps are the print's: fixed in the setup, so a brightness never moves to another colour.
          const setup = { ...parseLayerToneSetup(base[LAYERTONE_KEY]), filaments: stack.filaments, swaps: fixed };
          base[LAYERTONE_KEY] = JSON.stringify(setup);
          emit({ type: 'layerToneSetup', setup });
        }
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: `data:${image.mediaType};base64,${image.data}`, detailOpen: true,
          text: `Picture "${a.name}" from ${model}${cost != null ? ` · $${cost.toFixed(3)}` : ''}`,
          detail: `Prompt sent to ${model}${strip ? ' with the colour strip' : ''}:\n\n${prompt}\n\nStored for ${use.helper} as ${picture.width}×${picture.height} pixels${stack ? `, by position on the strip; swap layers fixed at ${fixed!.join(', ')}` : ''}.`,
        } });
        const build = stack
          ? ` Build it with H.layertone("${a.name}", { width, maxHeight: ${o.maxHeight}${lt.base_height != null ? `, baseHeight: ${o.baseHeight}` : ''}, filaments: [the same ${stack.filaments.length}] }): the same stack and heights it was drawn for, or the print stops matching it. Its swap layers (${fixed!.join(', ')}) are fixed in the LayerTone setup.`
          : '';
        return {
          content: [
            { type: 'image', data: image.data, mimeType: image.mediaType },
            { type: 'text', text: `Picture "${a.name}" is ready for ${use.helper}("${a.name}", { width, … }) (${picture.width}×${picture.height} pixels, ${(picture.width / picture.height).toFixed(3)} times as wide as high).${build} Check the print with render_model; if the picture itself is wrong, call generate_picture again with a better subject.` },
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
export function artworkTools({ base, emit, drawImage }: ToolContext, artwork: AiImages) {
  return [
    tool('generate_artwork', `Have an image model (${imageModel()}) draw real artwork, traced into an SVG drawing for H.svg: people, characters, animals, portraits, scenes and illustrations on wall art, reliefs, signs, plaques and coasters – anything you can't draw convincingly with geometry. It comes back in flat colours (the filament colours you give, or shades of grey) on no background; each colour is one shape: H.svg(name, { height, colors: [colour] }). Each call costs a few cents and takes ~10–20 s: describe the subject well and call again only if the picture is wrong.`, {
      name: z.string().regex(/^[\w-]{1,40}$/).describe('Name to use with H.svg, e.g. "players"'),
      subject: z.string().min(10).max(2000).describe('What to draw: subject(s), pose, expression, composition and framing – be specific'),
      colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(6).optional().describe('Filament colours to draw with (#rrggbb), e.g. the ones the user has; omit for shades of grey'),
      tones: z.number().int().min(2).max(6).optional().describe('Without colors: how many shades of grey (default 4)'),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 1:1)'),
      style: z.string().max(400).optional().describe('The look, when it should not be the default realistic posterized print (e.g. "bold cartoon", "minimal line art")'),
      use_attached_photos: z.boolean().optional().describe('Draw from the photos the user attached in this chat (this message\'s, or the earlier ones when it has none): a person, a pet, a place'),
    }, async (a) => {
      const photos = a.use_attached_photos ? await chatPhotos(artwork.designId ?? '', artwork.references) : [];
      if (a.use_attached_photos && !photos.length) return { content: [{ type: 'text', text: 'The user attached no photos in this chat.' }], isError: true };
      emit({ type: 'step', step: { kind: 'status', text: `Generating artwork "${a.name}" with ${imageModel()}…` } });
      try {
        const art = await generateArtwork(a.name, { subject: a.subject, colors: a.colors, tones: a.tones, aspect: a.aspect, style: a.style, references: photos.length ? photos : undefined }, artwork.signal, (text) => emit({ type: 'step', step: { kind: 'status', text } }), drawImage);
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
