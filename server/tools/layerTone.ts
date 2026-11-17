// The CAD tool for the LayerTone setup (set_layertone): the filaments and their swap layers.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkSwaps, cleanFilaments, LAYERTONE_KEY, layerCount, maxLayerToneFilaments, parseLayerToneSetup, shiftSwaps, type LayerToneSetup } from '../../shared/layertone';
import { BACK_TEXT_KEY, parseBackText, type BackTextSetting } from '../../shared/backText';
import { backText as backTextDefault } from '../config';
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
      base_height: z.number().min(0.04).max(4).optional().describe('Thickness of the first filament, mm (the First filament slider; default the script\'s baseHeight): raises everything above it by the same amount, so the print gets thicker and looks the same. Setup swaps move with it.'),
      reset: z.boolean().optional().describe('Clear the setup (the script\'s filaments and automatic swaps apply)'),
      back_text: z.union([z.string().max(40), z.literal(false)]).optional().describe('The mirrored line printed on the back (first layers): a string sets the text, "" returns to the app\'s default text, false turns it off'),
    }, async (a) => {
      // The back text is worked out first but stored only once the setup part is known to be valid:
      // a call that fails changes nothing.
      let backText: { bt: BackTextSetting; text: string } | null = null;
      if (a.back_text !== undefined) {
        const bt: BackTextSetting = parseBackText(base[BACK_TEXT_KEY]);
        if (a.back_text === false) bt.off = true;
        else { delete bt.off; if (a.back_text.trim()) bt.text = a.back_text.trim(); else delete bt.text; }
        const def = backTextDefault();
        const now = bt.off ? 'off' : bt.text ? `"${bt.text}"` : def ? `"${def}" (the default)` : 'the default (none)';
        backText = { bt, text: `Back text: ${now}.${def ? '' : ' PTP_BACK_TEXT is not set, so the app prints no back text at all.'}` };
      }
      const applyBackText = () => {
        if (!backText) return;
        const { bt, text } = backText;
        const empty = !Object.keys(bt).length;
        if (empty) delete base[BACK_TEXT_KEY]; else base[BACK_TEXT_KEY] = JSON.stringify(bt);
        emit({ type: 'backText', value: empty ? null : JSON.stringify(bt) });
        emit({ type: 'step', step: { kind: 'tool', ok: true, text } });
      };
      if (backText && a.filaments == null && a.swaps == null && a.base_height == null && !a.reset) {
        applyBackText();
        return { content: [{ type: 'text', text: backText.text }] };
      }
      const now = parseLayerToneSetup(base[LAYERTONE_KEY]);
      let setup: LayerToneSetup = a.reset ? {} : { ...now };
      if (a.filaments) setup.filaments = cleanFilaments(a.filaments);
      if (a.swaps === 'auto') delete setup.swaps;
      else if (a.swaps) setup.swaps = a.swaps;
      // New filaments without new swaps: the old swaps no longer fit, so they go automatic.
      else if (a.filaments && setup.swaps && setup.swaps.length !== setup.filaments!.length - 1) delete setup.swaps;
      if (!a.reset && a.base_height != null) {
        // Swaps kept from before are built layers: they move with the base, which must be known.
        if (setup.swaps && !a.swaps) {
          if (now.baseHeight == null) return { content: [{ type: 'text', text: 'The setup has swap layers but no base height yet: pass swaps too (the layers where each filament should start with the new base, from the render report) or swaps: "auto".' }], isError: true };
          const L = { layerHeight: 0.08, firstLayerHeight: 0.16 };
          setup.swaps = shiftSwaps(setup.swaps, layerCount(a.base_height, L) - layerCount(now.baseHeight, L));
        }
        setup.baseHeight = a.base_height;
      }
      const count = setup.filaments?.length;
      // Swaps only mean something against a known filament list (the script's may change without notice).
      if (setup.swaps && count == null) {
        return { content: [{ type: 'text', text: 'Pass the full filament list (bottom → top) together with the swaps.' }], isError: true };
      }
      if (setup.swaps && count != null && !checkSwaps(setup.swaps, count)) {
        return { content: [{ type: 'text', text: `swaps must be ${count - 1} ascending whole layer numbers, each ≥ 1 (one per filament after the first).` }], isError: true };
      }
      applyBackText();
      if (!setup.filaments) delete setup.filaments;
      if (!Object.keys(setup).length) setup = {};
      if (Object.keys(setup).length) base[LAYERTONE_KEY] = JSON.stringify(setup); else delete base[LAYERTONE_KEY];
      emit({ type: 'layerToneSetup', setup: Object.keys(setup).length ? setup : null });
      const text = !Object.keys(setup).length ? 'The LayerTone setup is cleared: the script\'s filaments and automatic swaps apply.'
        : `LayerTone setup: ${setup.filaments ? setup.filaments.map((f) => `${f.brand ? `${f.brand} ` : ''}${f.name} (${f.color}, TD ${f.td})`).join(' → ') : 'the script\'s filaments'}; swaps ${setup.swaps ? `at layers ${setup.swaps.join(', ')}` : 'automatic'}${setup.baseHeight != null ? `; first filament ${setup.baseHeight} mm thick` : ''}.`;
      emit({ type: 'step', step: { kind: 'tool', ok: true, text } });
      return { content: [{ type: 'text', text: `${backText ? `${backText.text} ` : ''}${text} The user sees it in the LayerTone panel. Call render_model to check the print.` }] };
    }),
  ];
}
