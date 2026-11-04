// Which printer the user has and how many filaments it loads at once: asked on the first start,
// changed from the Print tab. The list is the user's Bambu Studio: every Bambu Lab printer and
// nozzle, and the printer presets they saved there themselves.
import { useEffect, useMemo, useState } from 'react';
import type { PrinterInfo } from '../../shared/api';
import { MAX_FILAMENTS, type Printer, type PrinterSetup } from '../../shared/printer';
import { useEscape } from './useEscape';

/** What a filament count means, for the choices. */
function filamentsLabel(n: number): string {
  if (n === 1) return '1 (no AMS)';
  if (n === 4) return '4 (one AMS or AMS lite)';
  if (n % 4 === 0) return `${n} (${n / 4} AMS)`;
  return String(n);
}

/** Bambu's printers by model (each with its nozzle sizes), then the user's own presets. */
function groupPrinters(printers: Printer[]) {
  const models = new Map<string, Printer[]>();
  for (const p of printers.filter((x) => !x.custom)) models.set(p.model, [...(models.get(p.model) ?? []), p]);
  return { models: [...models.entries()].map(([model, list]) => ({ model, list: [...list].sort((a, b) => a.nozzle - b.nozzle) })), mine: printers.filter((x) => x.custom) };
}

interface Props {
  info: PrinterInfo;
  onSave: (s: PrinterSetup) => Promise<void>;
  /** Without it (the first start) there is no Cancel. */
  onCancel?: () => void;
}

/** The printer and filament choice as a dialog. */
export function PrinterDialog({ info, onSave, onCancel }: Props) {
  const first = !onCancel;
  const { models, mine } = useMemo(() => groupPrinters(info.printers), [info.printers]);
  const current = info.printers.find((p) => p.id === info.printer.id) ?? info.printers[0];
  // The model choice is a model name, or "mine:<id>" for one of the user's presets.
  const [model, setModel] = useState(current?.custom ? `mine:${current.id}` : current?.model ?? '');
  const [nozzle, setNozzle] = useState(current?.nozzle ?? 0.4);
  const [filaments, setFilaments] = useState(info.printer.filaments);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(!first, () => onCancel?.());
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus();
  }, []);

  const nozzles = models.find((m) => m.model === model)?.list ?? [];
  // A model without the nozzle picked before gets its 0.4 (or its first).
  const chosen: Printer | undefined = model.startsWith('mine:')
    ? mine.find((p) => `mine:${p.id}` === model)
    : nozzles.find((p) => p.nozzle === nozzle) ?? nozzles.find((p) => p.nozzle === 0.4) ?? nozzles[0];

  const save = async () => {
    if (!chosen) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ printerId: chosen.id, filaments });
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={first ? undefined : onCancel}>
      <div className="modal printer-dialog" role="dialog" aria-modal="true" aria-labelledby="printer-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="printer-title">{first ? 'Which printer do you have?' : 'Printer'}</h3>
        <p>{first
          ? 'Designs are made for it: what fits its bed, which details its nozzle can print, and the Bambu Studio project it exports. You can change it later in the Print tab.'
          : 'Every design follows it: the plate, the checks, the AI\'s instructions and the Bambu Studio project.'}</p>
        <div className="printer-fields">
          <label>
            <span>Printer</span>
            <select aria-label="Printer" value={model} onChange={(e) => setModel(e.target.value)} autoFocus>
              <optgroup label="Bambu Lab">
                {models.map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
              </optgroup>
              {mine.length > 0 && (
                <optgroup label="Your Bambu Studio presets">
                  {mine.map((p) => <option key={p.id} value={`mine:${p.id}`}>{p.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          {!model.startsWith('mine:') && (
            <label>
              <span>Nozzle</span>
              <select aria-label="Nozzle" value={chosen?.nozzle ?? 0.4} onChange={(e) => setNozzle(Number(e.target.value))} disabled={nozzles.length < 2}>
                {nozzles.map((p) => <option key={p.id} value={p.nozzle}>{p.nozzle} mm</option>)}
              </select>
            </label>
          )}
          <label>
            <span>Filaments it loads at once</span>
            <select aria-label="Filaments it loads at once" value={filaments} onChange={(e) => setFilaments(Number(e.target.value))}>
              {Array.from({ length: MAX_FILAMENTS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{filamentsLabel(n)}</option>)}
            </select>
          </label>
        </div>
        {chosen && (
          <p className="dim small printer-summary">
            {chosen.bed[0]} × {chosen.bed[1]} × {chosen.height} mm, {chosen.nozzle} mm nozzle, {chosen.structure === 'bedslinger' ? 'bed-slinger' : 'CoreXY'}
            {chosen.extruders > 1 && <><br />Two nozzles: no Bambu Studio project for it yet, so it exports a plain 3MF (no print settings or cost).</>}
            {!chosen.presets && <><br />Bambu Studio isn't installed here, so there is no Bambu Studio project or cost.</>}
          </p>
        )}
        {mine.length === 0 && (
          <p className="dim small">Your own printer presets from Bambu Studio show up here too. In Docker, mount Bambu Studio's user folder first (see docker-compose.yml).</p>
        )}
        {error && <p className="small warn-note" role="alert">{error}</p>}
        <div className="modal-actions">
          {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
          <button className="btn primary" disabled={!chosen || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
