// The CAD tool for the LayerTone setup (set_layertone): the filaments and their swap layers.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkSwaps, cleanFilaments, LAYERTONE_KEY, maxLayerToneFilaments, parseLayerToneSetup, type LayerToneSetup } from '../../shared/layertone';
import type { ToolContext } from './context';

/** set_layertone, for a LayerTone design. */
export function layerToneTools({ base, emit }: ToolContext) {
  return [
    tool('set_layertone', 'Change the LayerTone setup – the same one the user edits in the LayerTone panel (Print tab), which wins over the script\'s own filaments and swaps: the filaments bottom → top (order, colours, TDs) and the layers where each filament after the first starts. Omitted fields stay as they are; reset clears the setup so the script\'s choices apply again. Applies at once (no submit_model needed); to change filaments after the first version use this, not the script. Check the result with render_model (the report lists the stack used).', {
      filaments: z.array(z.object({
        name: z.string().max(120).describe('e.g. "PLA Basic Black"'),
        brand: z.string().max(60).optional().describe('e.g. "Bambu Lab", "eSUN"'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('#rrggbb'),
        td: z.number().min(0.05).max(20).describe('Transmission distance, mm'),
      })).min(1).max(maxLayerToneFilaments()).optional().describe('All filaments, bottom (printed first) → top'),
      swaps: z.union([z.array(z.number().int().min(1)).max(maxLayerToneFilaments() - 1), z.literal('auto')]).optional()
        .describe('The layer (0-based from the bed: layer 0 is the first layer, layer n starts at firstLayerHeight + (n − 1) × layerHeight) where each filament after the first starts: one ascending number per filament after the first; "auto" lets the app choose'),
      reset: z.boolean().optional().describe('Clear the setup (the script\'s filaments and automatic swaps apply)'),
    }, async (a) => {
      const now = parseLayerToneSetup(base[LAYERTONE_KEY]);
      let setup: LayerToneSetup = a.reset ? {} : { ...now };
      if (a.filaments) setup.filaments = cleanFilaments(a.filaments);
      if (a.swaps === 'auto') delete setup.swaps;
      else if (a.swaps) setup.swaps = a.swaps;
      // New filaments without new swaps: the old swaps no longer fit, so they go automatic.
      else if (a.filaments && setup.swaps && setup.swaps.length !== setup.filaments!.length - 1) delete setup.swaps;
      const count = setup.filaments?.length;
      // Swaps only mean something against a known filament list (the script's may change without notice).
      if (setup.swaps && count == null) {
        return { content: [{ type: 'text', text: 'Pass the full filament list (bottom → top) together with the swaps.' }], isError: true };
      }
      if (setup.swaps && count != null && !checkSwaps(setup.swaps, count)) {
        return { content: [{ type: 'text', text: `swaps must be ${count - 1} ascending whole layer numbers, each ≥ 1 (one per filament after the first).` }], isError: true };
      }
      if (!setup.filaments) delete setup.filaments;
      if (!Object.keys(setup).length) setup = {};
      if (Object.keys(setup).length) base[LAYERTONE_KEY] = JSON.stringify(setup); else delete base[LAYERTONE_KEY];
      emit({ type: 'layerToneSetup', setup: Object.keys(setup).length ? setup : null });
      const text = !Object.keys(setup).length ? 'The LayerTone setup is cleared: the script\'s filaments and automatic swaps apply.'
        : `LayerTone setup: ${setup.filaments ? setup.filaments.map((f) => `${f.brand ? `${f.brand} ` : ''}${f.name} (${f.color}, TD ${f.td})`).join(' → ') : 'the script\'s filaments'}; swaps ${setup.swaps ? `at layers ${setup.swaps.join(', ')}` : 'automatic'}.`;
      emit({ type: 'step', step: { kind: 'tool', ok: true, text } });
      return { content: [{ type: 'text', text: `${text} The user sees it in the LayerTone panel. Call render_model to check the print.` }] };
    }),
  ];
}
