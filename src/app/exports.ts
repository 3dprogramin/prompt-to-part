// Exporting the design: a file of the model (or one part) and the whole project, each built and
// checked at high resolution first.
import type { Dispatch, SetStateAction } from 'react';
import type { Design, ParamValues } from '../../shared/types';
import { defaultsFromTemplate, type PrintProfile, type PrintSettings } from '../../shared/print';
import { api } from '../lib/api';
import { download, slug } from '../lib/files';
import { exportParts, type ExportFormat } from '../lib/export';
import type { GlbOptions } from '../lib/glb';
import { chooseTarget, exportProject, type ProjectTarget } from '../lib/projectExport';
import { oneColourFilament } from '../lib/bambu3mf';
import { exportedParts } from '../geometry/parts';
import type { GeometryClient } from '../geometry/client';
import { summarize, type ValidationState } from '../components/ValidationPanel';
import type { useDesignSaving } from '../hooks/useDesignSaving';
import type { Notice } from './notice';
import type { usePrintSettings } from './usePrintSettings';

type PrintState = ReturnType<typeof usePrintSettings>;

/** Export and Export project… for the design as it is now (App makes them each render). */
export function designExports({ design, geo, hiddenParts, fullValues, layoutValue, printHints, oneColour, userPrint, printBase, setPrintBase, threeMf, bambu, blender,
  setExporting, setExportError, setExportStage, setNotice, setValidation, setValidationOpen, isUnsaved, saveNow }: {
  design: Design; geo: GeometryClient; hiddenParts: string[]; fullValues: () => ParamValues;
  /** The layout the model is shown in, for validation. */
  layoutValue: string | undefined;
  printHints: PrintState['printHints']; oneColour: PrintState['oneColour']; userPrint: PrintProfile;
  printBase: Required<PrintSettings>; setPrintBase: Dispatch<SetStateAction<Required<PrintSettings>>>;
  threeMf: { print: boolean }; bambu: string | null; blender: { version: string; problem: string | null } | null;
  setExporting: Dispatch<SetStateAction<boolean>>; setExportError: Dispatch<SetStateAction<string | null>>; setExportStage: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<Notice | null>>;
  setValidation: Dispatch<SetStateAction<ValidationState | null>>; setValidationOpen: Dispatch<SetStateAction<boolean>>;
  isUnsaved: ReturnType<typeof useDesignSaving>['isUnsaved']; saveNow: ReturnType<typeof useDesignSaving>['saveNow'];
}) {
  const onExport = async (format: ExportFormat, partName?: string, glb?: GlbOptions) => {
    if (!design.code) return;
    setExporting(true);
    setExportError(null);
    try {
      // Re-evaluate at high resolution for the exported mesh, and validate exactly that mesh (only
      // the parts being exported). If that fails, nothing is exported: the preview mesh is coarser
      // or may be from other settings, and the file would not be what the user expects.
      const choice = { exclude: hiddenParts, only: partName };
      const o = await geo.evaluate(design.code, fullValues(), 'high', { validate: { layoutValue, ...choice, ...printHints() } });
      if (!o.result) {
        setNotice({ text: `Not exported: the high-resolution model failed – ${o.error.message}${o.error.line ? ` (line ${o.error.line})` : ''}`, level: 'error', details: false });
        return;
      }
      const r = o.result;
      const parts = exportedParts(r, choice);
      if (!parts.length) {
        setNotice({ text: partName ? `Not exported: the model has no part "${partName}" any more.` : 'Not exported: every part is hidden in the viewer.', level: 'warning', details: false });
        return;
      }
      const name = slug(r.meta.name || design.name) + (partName ? `-${slug(partName)}` : '');
      const file = `${name}.${format}`;
      const blob = await exportParts(format, r, parts, r.meta.name || design.name, design.code, {
        oneColour: oneColour ? oneColourFilament(parts, oneColour).colour : null,
        print: threeMf.print && bambu ? { ai: r.print, user: userPrint } : null,
        // The template's profile becomes the baseline shown in the Print tab.
        onTemplate: (tpl) => setPrintBase(defaultsFromTemplate(tpl.settings)),
        glb,
      });
      download(blob, file); // always export – problems are reported, not blocking
      // A shop's 3D view loads on phones: say when the file is heavy.
      const mb = blob.size / 1048576;
      const heavy = format === 'glb' && mb > 15 ? ` · ${mb.toFixed(0)} MB, heavy for a shop's 3D view on phones` : '';
      if (o.report) {
        const report = o.report;
        const sum = summarize(report.issues);
        setValidation({ report, label: `Exported ${file}` });
        setValidationOpen(false);
        setNotice(sum.level === 'ok'
          ? { text: `Exported ${file} · checked, no problems found${heavy}`, level: heavy ? 'warning' : 'ok', details: true }
          : { text: `Exported ${file} · ${sum.text} found${heavy}`, level: sum.level === 'error' ? 'error' : 'warning', details: true });
      } else {
        setNotice({ text: `Exported ${file} · could not validate${heavy}`, level: 'warning', details: false });
      }
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  // Everything about the design in one folder or zip (lib/projectExport.ts).
  const onExportProject = async () => {
    if (!design.code) return;
    // The folder picker first: the browser only shows it right after the click.
    let target: ProjectTarget;
    try {
      target = await chooseTarget();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setExportError(`Project not exported: ${(e as Error).message}`);
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportStage('model');
    try {
      // Built and validated at high resolution, like any export.
      const choice = { exclude: hiddenParts };
      const o = await geo.evaluate(design.code, fullValues(), 'high', { validate: { layoutValue, ...choice, ...printHints() } });
      if (!o.result) {
        setNotice({ text: `Not exported: the high-resolution model failed – ${o.error.message}${o.error.line ? ` (line ${o.error.line})` : ''}`, level: 'error', details: false });
        return;
      }
      const r = o.result;
      const parts = exportedParts(r, choice);
      if (!parts.length) {
        setNotice({ text: 'Not exported: every part is hidden in the viewer.', level: 'warning', details: false });
        return;
      }
      // design.ptp.json is the design as the server stores it (what Import designs… reads): the
      // latest changes are saved first. Should that fail, this tab's copy is written instead.
      setExportStage('design');
      if (isUnsaved(design.id)) await saveNow(design).catch(() => {});
      const stored = await api.getDesign(design.id).catch(() => null);
      const designJson = JSON.stringify(stored ?? design, (k, v) => (k === 'activity' ? undefined : v));
      const sum = o.report ? summarize(o.report.issues) : null;
      const title = r.meta.name || design.name;
      const out = await exportProject({
        design, designJson, result: r, parts, title, base: slug(title),
        print: { ai: r.print, user: userPrint, base: printBase }, bambu: !!bambu,
        oneColour: oneColour ? oneColourFilament(parts, oneColour) : null,
        blender: blender && !blender.problem ? { ok: true } : { ok: false, why: blender?.problem ?? null },
        check: sum ? sum.text : 'could not validate',
        onTemplate: (tpl) => setPrintBase(defaultsFromTemplate(tpl.settings)),
      }, target, setExportStage, download);
      const where = target.kind === 'folder' ? `the folder "${out.name}"` : `${out.name}.zip`;
      if (o.report) {
        setValidation({ report: o.report, label: `Exported ${where}` });
        setValidationOpen(false);
      }
      if (out.problems.length) {
        setNotice({ text: `Exported ${where}, without ${out.problems.length === 1 ? 'one file' : `${out.problems.length} files`} (see its README): ${out.problems[0].replace(/`/g, '')}`, level: 'warning', details: !!o.report });
      } else {
        setNotice(!sum || sum.level !== 'ok'
          ? { text: `Exported ${where} · ${sum ? `${sum.text} found` : 'could not validate'}`, level: sum?.level === 'error' ? 'error' : 'warning', details: !!o.report }
          : { text: `Exported ${where} · checked, no problems found`, level: 'ok', details: true });
      }
    } catch (e) {
      setExportError(`Project not exported: ${(e as Error).message}`);
    } finally {
      setExporting(false);
      setExportStage(null);
    }
  };
  return { onExport, onExportProject };
}
