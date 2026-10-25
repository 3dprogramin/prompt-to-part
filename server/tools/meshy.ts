// The CAD tools for AI 3D figures: a concept picture to approve first (generate_concept) and the
// model Meshy makes (generate_3d), stored with the design for H.mesh.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { geometry } from '../geometry';
import { ASPECTS, conceptPrompt, imageModel, paintPrompt } from '../artwork';
import { CONCEPT_URL, CONCEPTS_KEY, MESHES_KEY, parseConcepts, parseMeshes, withConcept } from '../../shared/meshes';
import { forgetBalance, generateMeshyModel, MESHY_CREDITS_PER_COLOR_MODEL, MESHY_CREDITS_PER_MODEL, meshyCredits, meshyMaxPerReply } from '../meshy';
import { readMyFilaments } from '../myFilaments';
import { filamentLabel, matchFilaments, MAX_MESH_COLORS } from '../../shared/meshColors';
import { describeImport, meshDir, storeConceptPicture, storeMesh } from '../meshes';
import type { MeshyOptions, ToolContext } from './context';

/** generate_concept (when the image model can draw concept pictures) and generate_3d. */
export function meshyTools({ base, emit, state, drawImage }: ToolContext, meshy: MeshyOptions) {
  return [
    ...(meshy?.concepts ? [tool('generate_concept', `Have the image model (${imageModel()}) draw a concept picture of a 3D figure for generate_3d to build from: the subject alone, full body, on white, as a grey clay render (the shape). With color: true (a coloured figure) it then paints that same picture like a painted collectible figurine (the colours), so the user approves the pair. A few cents a picture and ~10–20 s each, no Meshy credits. The user sees it in the chat: end your reply asking them to approve it or say what to change; once they approve, generate_3d({ name, from_concept }) builds exactly this picture (the shape from the grey one, painted from the coloured one).`, {
      name: z.string().regex(/^[\w.-]{1,40}$/).describe('Name of the picture, e.g. "spiderman" (generate_3d takes it as from_concept); an existing name is replaced'),
      subject: z.string().min(10).max(2000).describe('The one subject: who or what it is, pose, proportions, clothes, hair, what it wears or holds, style – no base, scenery or props (those are built in the script)'),
      aspect: z.enum(ASPECTS).optional().describe('Picture shape, width:height (default 3:4, for a standing figure)'),
      color: z.boolean().optional().describe(`Also paint it in colour, for a coloured figure printed in up to ${MAX_MESH_COLORS} filaments (default: ${meshy.color ? 'on – the user turned on Colour' : 'off, grey only – on only when the user asks for a figure in colour'})`),
      palette: z.array(z.object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('The paint colour, #rrggbb, as it looks in plain light (e.g. skin "#d9a383", not its shadow)'),
        name: z.string().min(2).max(40).describe('e.g. "olive green"'),
        parts: z.string().min(2).max(200).describe('Every part painted in it, e.g. "both pairs of shorts and the belt"'),
      })).min(1).max(MAX_MESH_COLORS).optional().describe(`Required with color: the colours to paint it in, at most ${MAX_MESH_COLORS} (one AMS lite slot each), every part of the subject in one of them. Plan it from the subject: give parts that should differ clearly different colours, and parts that can share one the same colour (e.g. a grey shirt with a grey beard) rather than a fifth.`),
    }, async (a) => {
      const color = a.color ?? !!meshy.color;
      if (color && !a.palette?.length) return { content: [{ type: 'text' as const, text: `With color, give palette: at most ${MAX_MESH_COLORS} colours and every part in each, so the picture is painted in colours the AMS lite can print.` }], isError: true };
      const palette = color ? a.palette?.map((c) => ({ color: c.color.toLowerCase(), name: c.name.trim(), parts: c.parts.trim() })) : undefined;
      const aspect = a.aspect ?? '3:4';
      const status = (text: string) => emit({ type: 'step', step: { kind: 'status', text } });
      const toFile = (image: { data: string; mediaType: string }) => {
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const)[image.mediaType as 'image/png'];
        if (!ext) throw new Error(`The image model returned a ${image.mediaType} picture, which Meshy can't take`);
        return { bytes: Buffer.from(image.data, 'base64'), ext };
      };
      status(`Drawing concept "${a.name}"${color ? ' (the shape)' : ''} with ${imageModel()}…`);
      try {
        // The shape: the same grey clay render with or without colour (image to 3D reads the shape from its shading).
        const prompt = conceptPrompt(a.subject);
        const grey = await drawImage(prompt, aspect, undefined, meshy.signal, status);
        const greyUrl = `data:${grey.image.mediaType};base64,${grey.image.data}`;
        const image = await storeConceptPicture(meshy.designId, toFile(grey.image));
        const credits = meshyCredits(color);
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: greyUrl, detailOpen: true,
          text: `Concept "${a.name}"${color ? ' – shape' : ''} from ${grey.model}${grey.cost != null ? ` · $${grey.cost.toFixed(3)}` : ''}`,
          detail: `Prompt sent to ${grey.model}:\n\n${prompt}\n\nOnce you approve it, Meshy builds the 3D model ${color ? 'in this shape' : 'from this picture'} (${credits} credits).`,
        } });
        // The colours: that picture painted (image to image), Meshy's texture. Without it, Meshy paints the model itself.
        let painted: { url: string; image: { data: string; mediaType: string } } | undefined;
        let paintError = '';
        let plan = '';
        if (color) {
          status(`Painting concept "${a.name}" in colour with ${imageModel()}…`);
          const paint = paintPrompt(a.subject, palette);
          // The filament each planned colour prints with, shown before any Meshy credits are spent.
          if (palette) plan = matchFilaments(palette.map((c) => c.color), await readMyFilaments()).map((f, i) => `- ${palette[i].name} (${palette[i].parts}) → ${filamentLabel(f)}`).join('\n');
          try {
            const p = await drawImage(paint, aspect, [greyUrl], meshy.signal, status);
            painted = { url: await storeConceptPicture(meshy.designId, toFile(p.image)), image: p.image };
            emit({ type: 'step', step: {
              kind: 'render', ok: true, image: `data:${p.image.mediaType};base64,${p.image.data}`, detailOpen: true,
              text: `Concept "${a.name}" – colours from ${p.model}${p.cost != null ? ` · $${p.cost.toFixed(3)}` : ''}`,
              detail: `${plan ? `Prints in:\n${plan}\n\n` : ''}Prompt sent to ${p.model} with the shape picture:\n\n${paint}\n\nOnce you approve the pair, Meshy builds the shape from the grey picture and paints the model from this one (${credits} credits); Jig then reduces its colours to at most ${MAX_MESH_COLORS} filaments.`,
            } });
          } catch (e) {
            if (meshy.signal?.aborted) throw e;
            paintError = (e as Error).message;
            emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Concept colours: ${paintError} – Meshy will paint the model itself` } });
          }
        }
        const entry = { image, ...(painted ? { painted: painted.url } : {}), subject: a.subject.trim(), createdAt: Date.now(), ...(color ? { color: true } : {}), ...(painted && palette ? { palette } : {}) };
        base[CONCEPTS_KEY] = withConcept(base[CONCEPTS_KEY], a.name, entry);
        state.newConcepts.add(a.name);
        emit({ type: 'concept', name: a.name, entry });
        const check = painted
          ? `The first picture is the shape (grey clay), the second the colours (the same picture painted). Check that they show the subject asked for – one subject, whole, on white – and that the painted one matches the grey one (same pose and framing) and keeps to the palette: every part in its planned colour, no colour outside it (another colour would take a filament of its own or print in the wrong one). If not, call generate_concept again – once; if the second is still off, tell the user what differs.${plan ? ` The planned colours print with:\n${plan}\n` : ''} Then end your reply: tell the user this is the concept for their figure, the shape and its colours, and ask them to approve the pair or say what to change.`
          : `Check that it shows the subject asked for – one subject, whole, grey, on white – and call generate_concept again if not.${paintError ? ` Painting it in colour failed (${paintError}): there is only the grey picture, and Meshy will paint the model with its own texturing – tell the user the colours will come from Meshy.` : ''} Then end your reply: tell the user this is the concept for their figure and ask them to approve it or say what to change.`;
        return {
          content: [
            { type: 'image', data: grey.image.data, mimeType: grey.image.mediaType },
            ...(painted ? [{ type: 'image' as const, data: painted.image.data, mimeType: painted.image.mediaType }] : []),
            { type: 'text', text: `Concept picture "${a.name}" is ready; the user sees it in the chat. ${check} Don't call generate_3d now. When the user approves (their next message), call generate_3d({ name, from_concept: "${a.name}" }) (${credits} Meshy credits${color ? ', in colour' : ''}); if they want changes, draw a new concept instead.` },
          ],
        };
      } catch (e) {
        if (meshy.signal?.aborted) throw e;
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Concept: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      }
    })] : []),
    tool('generate_3d', `Have Meshy (an AI 3D generator) make a sculpted 3D model of the main subject – a figure, character, animal, statue or ornament – from an approved concept picture (from_concept: its grey picture gives the shape, and in colour its painted one the texture), the photo the user attached (from_photo) or a description. It comes back repaired into a watertight solid for H.mesh(name, …), with a four-view render and a report. With color it is textured and its colours are kept, reduced to at most ${MAX_MESH_COLORS} filaments (the A1's AMS lite) and painted on its triangles. Takes about 1–3 minutes and costs ${MESHY_CREDITS_PER_MODEL} Meshy credits (${MESHY_CREDITS_PER_COLOR_MODEL} in colour): only for the subject(s) the user asked for, never for bases, scenery or props; at most ${meshyMaxPerReply()} per reply.`, {
      name: z.string().regex(/^[\w.-]{1,40}$/).describe('Name to use with H.mesh, e.g. "fox"; an existing name is replaced'),
      prompt: z.string().max(700).optional().describe('The subject: what it is, pose, proportions, clothes, accessories, style – no printing instructions (Jig adds them). Required unless from_photo or from_concept'),
      from_photo: z.boolean().optional().describe('Build it from the photo the user attached to this message (image to 3D) instead of the description'),
      from_concept: z.string().regex(/^[\w.-]{1,40}$/).optional().describe('Build it from this concept picture (generate_concept) the user approved (image to 3D): Meshy gets exactly that picture, and in colour paints the model from its coloured version'),
      color: z.boolean().optional().describe(`A coloured figure (textured, ${MESHY_CREDITS_PER_COLOR_MODEL} credits instead of ${MESHY_CREDITS_PER_MODEL}), printed in up to ${MAX_MESH_COLORS} filaments. Default: ${meshy.color ? 'on (the user turned on Colour)' : 'off'}, or as the concept picture was drawn; turn it on only when the user asks for colour`),
      colors: z.number().int().min(1).max(MAX_MESH_COLORS).optional().describe(`With color: most colours (filaments) the figure gets (default ${MAX_MESH_COLORS}); fewer leave AMS slots for other parts in colours of their own`),
    }, async (a) => {
      const refuse = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
      if (a.from_photo && a.from_concept) return refuse('Use either from_photo or from_concept, not both.');
      if (a.from_photo && !meshy.references.length) return refuse('The user attached no photo to this message.');
      const concepts = parseConcepts(base[CONCEPTS_KEY]);
      const concept = a.from_concept ? concepts[a.from_concept] : undefined;
      if (a.from_concept && !concept) {
        const names = Object.keys(concepts);
        return refuse(`No concept picture named "${a.from_concept}"${names.length ? ` (there are: ${names.map((n) => `"${n}"`).join(', ')})` : ''}.`);
      }
      if (a.from_concept && state.newConcepts.has(a.from_concept)) {
        return refuse(`The user hasn't approved concept "${a.from_concept}" yet: end your reply and ask them to approve it or say what to change. Build it in their next message.`);
      }
      if (!a.from_photo && !a.from_concept && !a.prompt?.trim()) return refuse('Describe the subject in prompt (or use from_concept or from_photo).');
      const max = meshyMaxPerReply();
      const color = a.color ?? (concept?.color || !!meshy.color);
      const cost = meshyCredits(color);
      if (state.meshyCalls >= max) {
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Meshy: not making "${a.name}" – at most ${max} model${max === 1 ? '' : 's'} per reply` } });
        return refuse(`Refused – ${max ? `you have already had Meshy make ${state.meshyCalls} model${state.meshyCalls === 1 ? '' : 's'} in this reply, the most allowed per reply` : 'Meshy models are turned off (JIG_MESHY_MAX_PER_REPLY=0)'}. Stop calling generate_3d: build the rest (bases, scenery, props) in the script, or end your reply and ask the user whether to make "${a.name}" with Meshy – it would cost ${cost} Meshy credits${color ? ' (in colour)' : ''}. Their next message gets a fresh allowance.`);
      }
      // The slot is taken now (calls may run side by side) and given back if no task was started.
      state.meshyCalls++;
      let started = false;
      let image: string | undefined;
      let texture: string | undefined;
      if (concept) {
        const dataUri = async (url: string) => {
          const m = CONCEPT_URL.exec(url)!;
          const bytes = await readFile(path.join(meshDir(m[1]), m[2]));
          return `data:image/${m[2].endsWith('.jpg') ? 'jpeg' : m[2].slice(33)};base64,${bytes.toString('base64')}`;
        };
        try {
          // The grey picture is the shape; in colour, the painted one is the texture (Meshy paints it itself without one).
          image = await dataUri(concept.image);
          if (color && concept.painted) texture = await dataUri(concept.painted);
        } catch {
          state.meshyCalls--;
          return refuse(`The picture of concept "${a.from_concept}" is missing: draw it again with generate_concept.`);
        }
      }
      const how = concept ? `from concept "${a.from_concept}"` : a.from_photo ? 'from the photo' : 'from the description';
      emit({ type: 'step', step: { kind: 'status', text: `Meshy: making "${a.name}" ${how}${color ? ' in colour' : ''} (${cost} credits)…` } });
      let shown = -1;
      let status = '';
      const input = concept ? { image: image!, texture, label: `From concept picture "${a.from_concept}": ${concept.subject}` } : a.from_photo ? { image: meshy.references[0] } : { prompt: a.prompt! };
      try {
        const r = await generateMeshyModel(meshy.client, input, {
          signal: meshy.signal,
          color,
          onStarted: (id) => { started = true; emit({ type: 'step', step: { kind: 'status', verbose: true, text: `Meshy task ${id}` } }); },
          onProgress: (t, stage) => {
            const p = Math.round(t.progress ?? 0);
            // A coloured model from a description is made in two stages: the shape, then its colours.
            const what = stage === 'texture' ? 'painting the colours, ' : color && 'prompt' in input ? 'the shape, ' : '';
            const line = t.status === 'PENDING' ? `Meshy: ${what}waiting in the queue${t.preceding_tasks ? ` (${t.preceding_tasks} ahead)` : ''}…` : `Meshy: ${what}${p} %…`;
            emit({ type: 'live', text: line });
            // The steps get the status changes and every quarter; the live line every poll.
            if (`${stage} ${t.status}` !== status || (t.status === 'IN_PROGRESS' && Math.floor(p / 25) > Math.floor(shown / 25))) {
              status = `${stage} ${t.status}`;
              shown = p;
              if (t.status === 'PENDING' || t.status === 'IN_PROGRESS') emit({ type: 'step', step: { kind: 'status', text: line } });
            }
          },
        });
        emit({ type: 'live', text: `Meshy: importing and repairing "${a.name}"…` });
        const imported = color
          ? await geometry.importMesh(r.model.bytes, r.model.filename, { colors: true }, { colors: a.colors ?? MAX_MESH_COLORS, mine: await readMyFilaments() })
          : await geometry.importMesh(r.model.bytes, r.model.filename);
        const entry = await storeMesh(meshy.designId, imported, r.model, { source: 'meshy', prompt: r.prompt, picture: r.picture });
        if (!entry) throw new Error('The design was deleted');
        base[MESHES_KEY] = JSON.stringify({ ...parseMeshes(base[MESHES_KEY]), [a.name]: entry });
        emit({ type: 'mesh', name: a.name, entry });
        const report = describeImport(a.name, entry, imported.report) + (color && !entry.palette ? '\nMeshy sent it without colours: it prints in one colour (the part\'s).' : '');
        const picture = r.picture ? `data:image/${r.picture.ext === 'jpg' ? 'jpeg' : r.picture.ext};base64,${Buffer.from(r.picture.bytes).toString('base64')}` : `data:image/png;base64,${imported.png}`;
        emit({ type: 'step', step: {
          kind: 'render', ok: true, image: picture, detailOpen: true,
          text: `${color ? 'Coloured 3D model' : '3D model'} "${a.name}" from Meshy${r.credits ? ` · ${r.credits} credits` : ''}`,
          detail: `${'prompt' in input ? 'Prompt sent to Meshy (text to 3D)' : `Sent to Meshy (image to 3D${texture ? ': the shape picture, painted from the colours picture' : ''})`}:\n\n${r.prompt}\n\n${report}`,
        } });
        return {
          content: [
            { type: 'image', data: imported.png, mimeType: 'image/png' },
            { type: 'text', text: `${report}\nThe picture shows it as stored (ISO, FRONT, RIGHT, TOP; grid ${imported.gridStep} mm). Check that it is the subject asked for and stands upright (rotate it with H.mesh's rotate if not), then build the design around it.` },
          ],
        };
      } catch (e) {
        if (!started) state.meshyCalls--;
        if (meshy.signal?.aborted) throw e;
        emit({ type: 'step', step: { kind: 'tool', ok: false, text: `Meshy: ${(e as Error).message}` } });
        return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
      } finally {
        // The credits changed: the next balance asks Meshy.
        if (started) forgetBalance();
      }
    }),
  ];
}
