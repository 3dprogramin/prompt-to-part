import { useCallback, useEffect, useRef, useState } from 'react';
import type { Design, EvalResult, ParamValues } from '../../shared/types';
import type { BambuTemplate } from '../../shared/api';
import type { PrintProfile } from '../../shared/print';
import { costKey, type CostSettings, type SliceStats } from '../../shared/cost';
import { api } from '../lib/api';
import { buildProject } from '../lib/projects';
import { oneColourFilament } from '../lib/bambu3mf';
import { exportedParts } from '../geometry/parts';
import type { GeometryClient } from '../geometry/client';

/** What a cost calculation is doing; shown with the time since the calculation started. */
export type CostStage = 'model' | 'template' | 'slicing';
export const STAGE_TEXT: Record<CostStage, string> = {
  model: 'Building the model at export resolution',
  template: 'Preparing the Bambu Studio project (the first time, Jig reads your Bambu Studio profiles – this can take a few minutes)',
  slicing: 'Bambu Studio is slicing the model',
};

export interface CostResult {
  /** The inputs it was calculated from: a different key means it is out of date. */
  key: string;
  stats: SliceStats;
  /** The build that was sliced (size, part names, colours). */
  result: EvalResult;
  parts: number;
  colours: number;
}

interface Inputs {
  design: Design;
  /** The values to slice with (the print layout, not an assembled view). */
  values: ParamValues;
  hiddenParts: string[];
  userPrint: PrintProfile;
  /** "Print in one colour" (parseOneColour): the project is sliced with that one filament. */
  oneColour: null | 'main' | string;
  onTemplate: (tpl: BambuTemplate) => void;
}

/**
 * Cost of printing the open design: the exported parts at export resolution, made into the same
 * Bambu Studio project as the 3MF export and sliced by the user's Bambu Studio. Results are kept per
 * design; one calculation at a time.
 */
export function useCost(geo: GeometryClient, { design, values, hiddenParts, userPrint, oneColour, onTemplate }: Inputs) {
  const [settings, setSettings] = useState<CostSettings>({});
  const [running, setRunning] = useState<{ designId: string; stage: CostStage; since: number } | null>(null);
  const [results, setResults] = useState<Record<string, CostResult>>({});
  const [errors, setErrors] = useState<Record<string, { key: string; message: string }>>({});
  const busy = useRef(false);
  useEffect(() => { api.costSettings().then(setSettings).catch(() => {}); }, []);

  const key = costKey(design.code, values, hiddenParts, userPrint, oneColour);
  const latest = useRef({ design, values, hiddenParts, userPrint, oneColour, onTemplate, key });
  latest.current = { design, values, hiddenParts, userPrint, oneColour, onTemplate, key };

  const calculate = useCallback(async () => {
    const { design: d, values: v, hiddenParts: hidden, userPrint: user, oneColour: single, onTemplate: gotTemplate, key: k } = latest.current;
    if (busy.current || !d.code) return;
    busy.current = true;
    // One clock for the whole calculation: a new stage isn't a restart.
    const since = performance.now();
    const stage = (s: CostStage) => setRunning({ designId: d.id, stage: s, since });
    const fail = (message: string) => setErrors((e) => ({ ...e, [d.id]: { key: k, message } }));
    try {
      stage('model');
      const o = await geo.evaluate(d.code, v, 'high');
      if (!o.result) return fail(`The model failed at export resolution: ${o.error.message}`);
      const parts = exportedParts(o.result, { exclude: hidden });
      if (!parts.length) return fail('Every part is hidden in the viewer: nothing to print.');
      stage('template');
      const tpl = await api.bambuTemplate();
      gotTemplate(tpl);
      const colour = single ? oneColourFilament(parts, single).colour : null;
      const colours = colour ? 1 : new Set(parts.map((p) => p.color.toLowerCase())).size;
      const project = await buildProject({ kind: 'bambu', parts, title: o.result.meta.name || d.name, tpl, opts: { oneColour: colour, print: { ai: o.result.print, user }, primeTower: false } });
      stage('slicing');
      const stats = await api.slice(project);
      setResults((r) => ({ ...r, [d.id]: { key: k, stats, result: o.result, parts: parts.length, colours } }));
      setErrors((e) => { const next = { ...e }; delete next[d.id]; return next; });
    } catch (e) {
      fail((e as Error).message);
    } finally {
      busy.current = false;
      setRunning(null);
    }
  }, [geo]);

  const saveSettings = useCallback((s: CostSettings) => {
    setSettings(s);
    api.saveCostSettings(s).then(setSettings).catch(() => {});
  }, []);

  const result = results[design.id];
  const error = errors[design.id];
  return {
    settings, saveSettings, calculate,
    /** The calculation under way (for this or another design), or null. */
    running,
    result: result ?? null,
    upToDate: !!result && result.key === key,
    /** Why the last calculation for these inputs failed (null once the inputs change). */
    error: error && error.key === key ? error.message : null,
  };
}
