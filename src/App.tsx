import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Design, DesignSummary, DimTarget, EvalResult, ParamValue, ParamValues, Quality, SolveResult, Vec3 } from '../shared/types';
import { SCALE_KEY } from '../shared/params';
import { DRAWINGS_KEY } from '../shared/svgFeatures';
import { LAYERTONE_IMAGES_KEY } from '../shared/layertone';
import { CONCEPTS_KEY, MESHES_KEY, parseMeshes, rehomeConcepts, rehomeMeshes } from '../shared/meshes';
import type { MeshyBalance } from '../shared/api';
import type { FontEntry } from './lib/api';
import { api } from './lib/api';
import type { AutoBuild } from './lib/autoBuild';
import { describeSettings, settingsChanged } from './lib/settings';
import { GeometryClient } from './geometry/client';
import { ChatPanel } from './components/ChatPanel';
import { ViewerPanel } from './components/ViewerPanel';
import { SidePanel } from './components/SidePanel';
import { Icon } from './components/Icon';
import type { DesignTab } from './components/DesignTabs';
import { TopBar } from './components/TopBar';
import { LayoutTabs } from './components/LayoutTabs';
import { RestoreDialog } from './components/RestoreDialog';
import { LineArtEditor } from './components/LineArtEditor';
import { PhotosPanel, usePhotoJobs, type SizeShot } from './components/PhotosPanel';
import { useEscape } from './components/useEscape';
import { useDesignSaving } from './hooks/useDesignSaving';
import { useCrossTabSync } from './hooks/useCrossTabSync';
import { useLiveModel } from './hooks/useLiveModel';
import { useRepaint } from './hooks/useRepaint';
import { STAGE_TEXT, useCost } from './hooks/useCost';
import { useSizes, visibleSize } from './hooks/useSizes';
import { sizeText } from '../shared/sizes';
import { load, store } from './lib/storage';
import type { PhotoView, PlaybackStep, ViewerOptions } from './viewer/Viewer';
import type { TrueScale } from '../shared/photos';
import type { ValidationState } from './components/ValidationPanel';
import { A1_DEFAULTS, defaultsFromTemplate, type PrintSettings } from '../shared/print';
import { oneColourFilament } from './lib/bambu3mf';
import { DEFAULT_LINE_ART_STYLE } from '../shared/lineart';
import { forgetChatMode } from './lib/chatModes';
import { cleanTags } from '../shared/tags';
import { newDesign, keepAppValues, UNTITLED, withLayerToneImage, withMesh } from './app/designValues';
import type { Notice } from './app/notice';
import { useDesignTabs } from './app/useDesignTabs';
import { useSidebars } from './app/useSidebars';
import { useHiddenParts } from './app/useHiddenParts';
import { useChatOptions } from './app/useChatOptions';
import { useLayoutPanels } from './app/useLayoutPanels';
import { useDesignEdits } from './app/useDesignEdits';
import { useReplies } from './app/useReplies';
import { usePrintSettings } from './app/usePrintSettings';
import { designExports } from './app/exports';
import { useDesignList } from './app/useDesignList';
import { useModelLayout } from './app/useModelLayout';
import { modelChecks } from './app/modelChecks';

const geo = new GeometryClient();

export default function App() {
  const [design, setDesign] = useState<Design>(newDesign);
  // The browser tab names the open design.
  useEffect(() => { document.title = design.name.trim() ? `Jig - ${design.name.trim()}` : 'Jig'; }, [design.name]);
  const currentId = useRef(design.id);
  currentId.current = design.id;
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  // Generations started in this tab, per design (they keep running when another design is opened).
  const [running, setRunning] = useState<Record<string, AbortController>>({});
  const runningRef = useRef(running);
  runningRef.current = running;
  // The open design as last rendered, for handlers that run later (e.g. after a failed delete).
  const designRef = useRef(design);
  designRef.current = design;
  const { saveNow, saveSoon, saveErrors, clearSaveError, lastLoaded, adopted, stopSaving, cancelPending, isUnsaved } = useDesignSaving({
    setDesign, currentId, runningRef,
    onSaved: (saved) => {
      refreshList();
      // A design kept in memory only because it wasn't saved yet can go now.
      if (saved.id !== currentId.current && !runningRef.current[saved.id] && background.current.get(saved.id) === saved) background.current.delete(saved.id);
    },
    onAdopted: () => setNotice({ text: 'This design was changed in another tab or window – showing the newest version.', level: 'info', details: false }),
    onGone: (id) => forgetDesign(id),
  });
  // Designs generating in other tabs (id → last heartbeat); their saves replace the open copy.
  const remoteRunning = useCrossTabSync(runningRef, (saved) => setDesign((d) => {
    if (d.id !== saved.id || runningRef.current[d.id]) return d;
    // The other tab's copy is newer: an autosave of this one still waiting would undo it.
    cancelPending(d.id);
    lastLoaded.current = saved;
    return saved;
  }), (id) => {
    stopSaving(id);
    forgetDesign(id);
  });
  const generating = !!running[design.id];
  const { tabIds, setTabIds, unseen, setUnseen } = useDesignTabs({ design, currentId, runningRef });
  const busyElsewhere = !generating && remoteRunning[design.id] != null;
  const { leftOpen, setLeftOpen, rightOpen, setRightOpen, setUserWidths, widths, workspace, resize } = useSidebars();
  // Photos dropped anywhere go to the chat; the browser must never open a dropped file in place of
  // Jig (that would also stop a running generation).
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => { if (isFiles(e)) e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('jig-drop-files', { detail: [...e.dataTransfer!.files] }));
      setLeftOpen(true);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('dragover', onOver); window.removeEventListener('drop', onDrop); };
  }, []);
  const [exporting, setExporting] = useState(false);
  const [quality, setQuality] = useState<Quality>(() => load('quality', 'normal'));
  const { hiddenParts, setHiddenParts, toggleHidden, paramOwners, ownersKey } = useHiddenParts({ design, setDesign, geo });
  // The part selected in the Object tab, highlighted in the view.
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const { chatDefaults, setChatDefaults, kind, chat, setChat, waitForOk, setWaitForOk, waitForOkRef, sendView, setSendView, askFirst, setAskFirst, sounds, setSounds, soundsRef } = useChatOptions(design);
  // The countdown under a reply that ended with new concept pictures ("Wait for my OK" off).
  const [autoBuild, setAutoBuild] = useState<AutoBuild | null>(null);
  const [artworkModel, setArtworkModel] = useState<string | null>(null);
  const [meshy, setMeshy] = useState(false);
  // The Meshy account's credits, shown on the 3D figure button: asked when the mode is turned on and after a reply that used Meshy.
  const [meshyCredits, setMeshyCredits] = useState<MeshyBalance | null>(null);
  const refreshMeshyCredits = () => { api.meshyBalance().then(setMeshyCredits).catch(() => {}); };
  useEffect(() => { if (meshy && chat.imageMode === 'figure') refreshMeshyCredits(); }, [meshy, chat.imageMode]);
  const [viewOpts, setViewOpts] = useState<ViewerOptions>(() => ({
    showBBox: true, showAnnotations: true, showEdges: true, ortho: false, measure: false, hiddenParts: [],
    section: { enabled: false, axis: 'z', position: 0, flip: false },
    ...load<Partial<ViewerOptions>>('viewOpts', {}),
  }));
  const { result, lastGood, error, busy, resultCode } = useLiveModel(geo, design, quality);
  // Line art's joins of loose ends, shown in the 3D view while the Print tab's Line art section asks for them.
  const [showJoins, setShowJoins] = useState(false);
  const snapshotRef = useRef<(() => string | null) | null>(null);
  const photoRef = useRef<((view: PhotoView, aspect: number, result?: EvalResult, scale?: TrueScale) => string | null) | null>(null);
  const [playback, setPlayback] = useState<{ result: EvalResult; steps: PlaybackStep[] } | null>(null);
  const [playbackLoading, setPlaybackLoading] = useState(false);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  const [validationOpen, setValidationOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const switchNotice = useRef<Notice | null>(null);
  // In-memory copies of designs that are generating, or not saved yet, while another design is open.
  const background = useRef(new Map<string, Design>());
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [blender, setBlender] = useState<{ version: string; problem: string | null } | null>(null);
  const [bambu, setBambu] = useState<string | null>(null);
  // Export ▸ 3MF…: print settings in the 3MF or not (colours follow the design's "Print in one colour").
  const [threeMf, setThreeMf] = useState<{ print: boolean }>(() => ({ print: load('threeMf', { print: true }).print !== false }));
  useEffect(() => store('threeMf', threeMf), [threeMf]);
  const [exportError, setExportError] = useState<string | null>(null);
  // What "Export project…" is making ("3MF"), while it runs.
  const [exportStage, setExportStage] = useState<string | null>(null);
  const [dictation, setDictation] = useState(false);
  // Why Claude can't run (no API key and no subscription mode), from the server.
  const [claudeProblem, setClaudeProblem] = useState<string | null>(null);
  // The print baseline: the profile in the user's Bambu Studio template (what the 3MF starts from).
  const [printBase, setPrintBase] = useState<Required<PrintSettings>>(A1_DEFAULTS);
  useEffect(() => { api.capabilities().then((c) => { setBlender(c.blender ? { version: c.blender, problem: c.blenderProblem ?? null } : null); setBambu(c.bambu ?? null); setDictation(!!c.speech); if (c.printDefaults) setPrintBase(c.printDefaults); setClaudeProblem(c.claude ?? null);  setArtworkModel(c.artwork ?? null); setMeshy(!!c.meshy); if (c.model) setChatDefaults((d) => ({ ...d, model: c.model, effort: c.effort ?? d.effort })); }).catch(() => {}); }, []);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => { api.listFonts().then(setFonts).catch(() => {}); }, []);
  useEscape(!!picking, () => setPicking(null));

  // Repainting a coloured figure's patches by hand (Object tab ▸ Filament colours ▸ Repaint).
  const designMeshes = useMemo(() => parseMeshes(design.values[MESHES_KEY]), [design.values[MESHES_KEY]]);
  const repaint = useRepaint(designMeshes, (name, list) => setDesign((d) => {
    const meshes = parseMeshes(d.values[MESHES_KEY]);
    if (!meshes[name]) return d;
    const { repaint: _old, ...rest } = meshes[name];
    return { ...withMesh(d, name, list ? { ...rest, repaint: list } : rest), updatedAt: Date.now() };
  }));
  // Placing text and repainting both take the clicks on the model: one at a time.
  useEffect(() => { if (picking) repaint.stop(); }, [picking, repaint.stop]);
  useEffect(() => repaint.stop(), [design.id, repaint.stop]);

  const { layout, shownPanel, showPanel, shownTab, newModel } = useLayoutPanels({ design, picking });

  const { textFeatures, setTextFeatures, svgFeatures, setSvgFeatures, recolor, previewColors, setLayerTone, setLineArtEdits, setPartColor } = useDesignEdits({ design, setDesign, result, lastGood });
  const [editingLineArt, setEditingLineArt] = useState(false);
  useEffect(() => setEditingLineArt(false), [design.id]);

  const onPickSurface = (hit: { part: string; point: [number, number, number]; normal: [number, number, number] }) => {
    const r = result ?? lastGood;
    const part = r?.parts.find((p) => p.name === hit.part);
    if (!picking || !part) return;
    // Relative to the part without text or SVG, as placeOnSurface maps it back.
    const box = part.textBase ?? part.bbox;
    const anchor = [0, 1, 2].map((k) => {
      const span = box.max[k] - box.min[k];
      return span > 1e-6 ? (hit.point[k] - box.min[k]) / span : 0.5;
    }) as [number, number, number];
    const placed = { face: 'pick' as const, anchor, normal: hit.normal, part: hit.part, offset: [0, 0] as [number, number] };
    if (svgFeatures.some((f) => f.id === picking)) setSvgFeatures(svgFeatures.map((f) => (f.id === picking ? { ...f, ...placed } : f)));
    else setTextFeatures(textFeatures.map((f) => (f.id === picking ? { ...f, ...placed } : f)));
    setPicking(null);
  };
  const loaded = useRef(false);
  // A design named in the URL that couldn't be loaded because the server was down.
  const unreachable = useRef<string | null>(null);

  useEffect(() => store('quality', quality), [quality]);
  useEffect(() => {
    const { showBBox, showAnnotations, showEdges, ortho, colors } = viewOpts;
    store('viewOpts', { showBBox, showAnnotations, showEdges, ortho, colors });
  }, [viewOpts]);

  // Why the design list couldn't be loaded (the server is down), so the menu doesn't claim there are none.
  const [listError, setListError] = useState<string | null>(null);
  const refreshList = useCallback(() => {
    api.listDesigns().then((l) => { setDesigns(l); setListError(null); }, (e: Error) => setListError(e.message));
  }, []);

  /** Apply a change to a design whether it is open (React state) or generating in the background. */
  const updateDesign = useCallback((id: string, fn: (d: Design) => Design) => {
    setDesign((d) => {
      if (d.id === id) return fn(d);
      const bg = background.current.get(id);
      if (bg) {
        const next = fn(bg);
        background.current.set(id, next);
        saveSoon(next);
      }
      return d;
    });
  }, [saveSoon]);

  // Product photos: each lands in its own design, even when another one is open by then.
  const [photosOpen, setPhotosOpen] = useState(false);
  const photoJobs = usePhotoJobs((id, photo) => updateDesign(id, (d) => ({ ...d, photos: [...(d.photos ?? []), photo], updatedAt: Date.now() })));
  const deletePhotos = (urls: string[]) => setDesign((d) => ({ ...d, photos: d.photos?.filter((x) => !urls.includes(x.url)), updatedAt: Date.now() }));

  /** Switch the open design, keeping a still-generating or unsaved one alive in memory. */
  const switchTo = useCallback((next: Design) => {
    setDesign((cur) => {
      if (cur.id === next.id) return cur;
      // An unsaved copy (pending or failed save) is reopened from memory, not reloaded without its changes.
      if (runningRef.current[cur.id] || isUnsaved(cur.id)) background.current.set(cur.id, cur);
      const live = background.current.get(next.id);
      background.current.delete(next.id);
      // A background copy saves itself as it changes; a loaded one is saved already.
      lastLoaded.current = live ?? next;
      return live ?? next;
    });
    setViewOpts((o) => ({ ...o, measure: false }));
    setSelectedPart(null);
  }, []);

  // Open the last design on startup (guarded: hot reload re-runs effects).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // A bare URL (new tab) starts a fresh design; ?design=<id> reopens that one.
      const last = new URLSearchParams(location.search).get('design');
      if (last) {
        try {
          const d = await api.getDesign(last);
          if (d) { lastLoaded.current = d; setDesign(d); }
        } catch (e) {
          // Keep ?design= so a reload once the server is back opens it again.
          unreachable.current = last;
          setNotice({ text: `${(e as Error).message} Reload this page once it is running.`, level: 'error', details: false });
        }
      }
      loaded.current = true;
      refreshList();
    })();
  }, [refreshList]);

  // Keep the URL pointing at the open design so a reload reopens it.
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get('design') === design.id) return;
    if (!design.messages.length && !design.code) {
      if (unreachable.current) return; // the design in the URL couldn't be loaded yet
      url.searchParams.delete('design');
    } else {
      unreachable.current = null;
      url.searchParams.set('design', design.id);
    }
    history.replaceState(null, '', url);
  }, [design.id, design.messages.length, design.code]);

  // Autosave once the design has content. The timer belongs to the design, so opening another
  // design right after a change still saves it.
  useEffect(() => {
    if (!loaded.current || (!design.messages.length && !design.code)) return;
    if (design === lastLoaded.current) return; // as loaded from the server or another tab
    saveSoon(design);
  }, [design, saveSoon]);

  // Name untitled designs after the model.
  useEffect(() => {
    const name = result?.meta.name;
    if (name && design.name === UNTITLED && design.code && resultCode.current === design.code) setDesign((d) => ({ ...d, name }));
  }, [result?.meta.name, design.name, design.code]);

  // Sources of the dimensions the shown version was built around: those of Claude's version it is
  // (or that a manual edit or saved settings were based on).
  const dimensionSources = useMemo(() => {
    for (let i = design.currentVersion; i >= 0; i--) if (design.versions[i]?.source === 'ai') return design.versions[i].sources;
    return undefined;
  }, [design.versions, design.currentVersion]);

  /**
   * Everything needed to rebuild the model as the user has set it: the sliders as they are now
   * (not as last evaluated – a slow preview may still be running), uniform scale and text-tool text.
   */
  // The runtime resolves values against the script it actually runs (defaults for anything new),
  // so they are passed as they are, not resolved against a preview that may be of older code.
  const fullValues = (): ParamValues => ({ ...design.values });

  const { onSend, onAnswer, queue, steerOrQueue, enqueue, removeQueued, sendQueued, buildConcepts } = useReplies({ design, setDesign, updateDesign, running, setRunning, remoteRunning, setUnseen,
    currentId, background, cancelPending, saveNow, result, lastGood, chat, textFeatures, svgFeatures, sendView, askFirst, waitForOk, waitForOkRef, soundsRef, meshy, refreshMeshyCredits,
    autoBuild, setAutoBuild, claudeProblem, busy, snapshotRef, fullValues });

  const restore = (vi: number) => {
    const v = design.versions[vi];
    if (v) setDesign((d) => ({ ...d, code: v.code, currentVersion: vi, values: { ...v.values }, updatedAt: Date.now() }));
  };
  // Switching versions replaces the sliders with that version's settings: ask first if yours aren't saved.
  const [pendingRestore, setPendingRestore] = useState<number | null>(null);
  const onRestore = (vi: number) => {
    if (vi !== design.currentVersion && unsavedSettings) setPendingRestore(vi);
    else restore(vi);
  };

  const onApplyCode = (code: string) => {
    setDesign((d) => {
      const versions = [...d.versions, { code, summary: 'Manual code edit', createdAt: Date.now(), source: 'manual' as const, values: { ...d.values } }];
      return { ...d, code, versions, currentVersion: versions.length - 1, updatedAt: Date.now() };
    });
  };

  const { aiPrint, userPrint, setUserPrint, oneColour, setOneColour, printChanges, printHints } = usePrintSettings({ design, setDesign, result, lastGood, printBase });

  // ---- assembly animation ----
  const shown = result ?? lastGood;

  // ---- saving slider / scale / text / print settings as a version ----
  const unsavedSettings = !!shown && !!design.code && design.versions.length > 0 && !generating
    && settingsChanged(design.versions[design.currentVersion]?.values ?? {}, design.values, shown.params);
  const saveSettings = () => {
    if (!shown) return;
    setDesign((d) => {
      const base = d.versions[d.currentVersion]?.values ?? {};
      const versions = [...d.versions, { code: d.code, summary: describeSettings(base, d.values, shown.params), createdAt: Date.now(), source: 'settings' as const, values: { ...d.values } }];
      return { ...d, versions, currentVersion: versions.length - 1, updatedAt: Date.now() };
    });
  };
  const { shownLineArt, splitArt, editorPart, lineArtOriginal, layoutKey, fitKey, canAssemble, layoutDef, printLayout } = useModelLayout({ design, shown, editingLineArt, quality, geo });

  // ---- cost: slice the exported parts in Bambu Studio (the print layout, not an assembled view)
  const cost = useCost(geo, {
    design,
    values: printLayout && layoutKey ? { ...design.values, [layoutKey]: printLayout } : design.values,
    hiddenParts,
    userPrint,
    oneColour,
    onTemplate: (tpl) => setPrintBase(defaultsFromTemplate(tpl.settings)),
  });

  // ---- sale sizes (S / M / L): built, shown and sliced one at a time
  const sizes = useSizes(geo, {
    design, updateDesign, shown, quality, layoutKey, printLayout, hiddenParts, userPrint, oneColour,
    onTemplate: (tpl) => setPrintBase(defaultsFromTemplate(tpl.settings)),
  });
  /** A sale size's own render for a photo (the design's for null), whatever the view shows. */
  const sizeShot: SizeShot = async (sizeId, view, aspect, scale) => {
    const built = sizeId ? await sizes.buildOf(sizeId) : shown ?? { error: 'There is no model yet.' };
    if ('error' in built) return built;
    const dims = visibleSize(built, hiddenParts);
    const shot = dims && photoRef.current?.(view, aspect, built, scale);
    return shot && dims ? { shot, dims } : { error: 'Every part is hidden: show at least one to photograph it.' };
  };
  const designDims: Vec3 | null = shown ? visibleSize(shown, hiddenParts) : null;

  // Any change to the model ends the animation and makes validation results stale.
  useEffect(() => {
    if (design === adopted.current) { adopted.current = null; return; }
    setPlayback(null);
    setValidation(null);
    setValidationOpen(false);
    // A notice about the switch itself (e.g. the design was deleted elsewhere) outlives it.
    setNotice(switchNotice.current);
    switchNotice.current = null;
  }, [design.id, design.code, design.values]);

  // A clean result fades away by itself; problems stay until dismissed.
  useEffect(() => {
    if (!notice || notice.level !== 'ok') return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const layoutValue = layoutKey ? String(design.values[layoutKey] ?? shown?.values[layoutKey] ?? layoutDef?.value ?? '') : undefined;

  const { onValidate, startAssembly } = modelChecks({ design, shown, geo, quality, fullValues, hiddenParts, printHints, layoutKey, layoutDef, layoutValue,
    setValidating, setValidation, setValidationOpen, setNotice, setPlayback, setPlaybackLoading });

  const onEditDimension = async (target: DimTarget, goal: number): Promise<SolveResult | null> => {
    if (!design.code || !(result ?? lastGood)) return null;
    const r = await geo.solve(design.code, fullValues(), quality, target, goal);
    if (r.ok && r.key && r.value != null) {
      const v = +r.value.toFixed(4);
      setDesign((d) => ({ ...d, values: { ...d.values, [r.key!]: v } }));
    }
    return r;
  };

  const onScale = (factor: number) => setDesign((d) => {
    const values = { ...d.values };
    if (Math.abs(factor - 1) < 1e-9) delete values[SCALE_KEY]; else values[SCALE_KEY] = factor;
    return { ...d, values };
  });

  const onValue = (key: string, v: ParamValue) => setDesign((d) => ({ ...d, values: { ...d.values, [key]: v } }));

  const { onExport, onExportProject } = designExports({ design, geo, hiddenParts, fullValues, layoutValue, printHints, oneColour, userPrint, printBase, setPrintBase, threeMf, bambu, blender,
    setExporting, setExportError, setExportStage, setNotice, setValidation, setValidationOpen, isUnsaved, saveNow });

  const openDesign = async (id: string) => {
    if (id === design.id) return;
    try {
      const d = background.current.get(id) ?? (await api.getDesign(id));
      if (d) switchTo(d);
      else { setNotice({ text: 'That design no longer exists.', level: 'warning', details: false }); refreshList(); }
    } catch (e) {
      setNotice({ text: `Could not open the design: ${(e as Error).message}`, level: 'error', details: false });
    }
  };

  /** A new design; `tags` are given to it once it is saved (a new design in the Temp list is Temp). */
  const createNew = (tags?: string[]) => {
    const d = newDesign();
    switchTo(d);
    if (tags?.length) setNewTags((t) => ({ ...t, [d.id]: cleanTags(tags) }));
  };

  /**
   * A new design from one version: its script and settings (text, SVG, print, attached drawings)
   * as v1, with an empty chat and its own Claude session. The original design is unchanged.
   */
  const forkVersion = async (vi: number) => {
    const v = design.versions[vi];
    if (!v) return;
    const values: ParamValues = { ...v.values };
    // Drawings, pictures and meshes attached later in the chat may be what this version's script uses.
    if (!values[DRAWINGS_KEY] && design.values[DRAWINGS_KEY]) values[DRAWINGS_KEY] = design.values[DRAWINGS_KEY];
    if (!values[LAYERTONE_IMAGES_KEY] && design.values[LAYERTONE_IMAGES_KEY]) values[LAYERTONE_IMAGES_KEY] = design.values[LAYERTONE_IMAGES_KEY];
    if (!values[MESHES_KEY] && design.values[MESHES_KEY]) values[MESHES_KEY] = design.values[MESHES_KEY];
    if (!values[CONCEPTS_KEY] && design.values[CONCEPTS_KEY]) values[CONCEPTS_KEY] = design.values[CONCEPTS_KEY];
    const d = newDesign();
    // Mesh files (and concept pictures) live next to a design: the new one gets copies, so deleting either keeps the other whole.
    if (values[MESHES_KEY] || values[CONCEPTS_KEY]) {
      try {
        await api.copyMeshes(d.id, design.id);
      } catch (e) {
        setNotice({ text: `Could not copy the design's 3D models: ${(e as Error).message}`, level: 'error', details: false });
        return;
      }
      const moved = rehomeMeshes(values[MESHES_KEY], d.id);
      if (moved) values[MESHES_KEY] = moved; else delete values[MESHES_KEY];
      const concepts = rehomeConcepts(values[CONCEPTS_KEY], d.id);
      if (concepts) values[CONCEPTS_KEY] = concepts; else delete values[CONCEPTS_KEY];
    }
    const forked: Design = {
      ...d,
      name: `${design.name} (from v${vi + 1})`,
      code: v.code,
      values,
      versions: [{ ...v, values, summary: `From "${design.name}" v${vi + 1}: ${v.summary}`, createdAt: d.createdAt }],
      currentVersion: 0,
    };
    switchTo(forked);
    // Opened designs count as saved (switchTo); this one is new, so save it now.
    saveSoon(forked);
  };

  // The open design always has a tab (an empty new one only until another is opened).
  const designTabs: DesignTab[] = [...tabIds, ...(tabIds.includes(design.id) ? [] : [design.id])].flatMap((id) => {
    const name = id === design.id ? design.name : background.current.get(id)?.name ?? designs.find((d) => d.id === id)?.name;
    return name == null ? [] : [{ id, name, running: !!running[id] || remoteRunning[id] != null, unseen: unseen.includes(id) }];
  });

  // Forget tabs of designs that no longer exist (deleted, e.g. in another browser tab).
  useEffect(() => {
    if (!designs.length) return;
    setTabIds((t) => {
      const kept = t.filter((id) => id === currentId.current || runningRef.current[id] || designs.some((d) => d.id === id));
      return kept.length === t.length ? t : kept;
    });
  }, [designs]);

  const closeTab = (id: string) => {
    setTabIds((t) => t.filter((x) => x !== id));
    if (id !== design.id) return;
    const ids = designTabs.map((t) => t.id);
    const i = ids.indexOf(id);
    const next = ids[i + 1] ?? ids[i - 1];
    if (next) openDesign(next); else createNew();
  };

  /** Close every tab except designs Claude is working on; a closed open design becomes a new one. */
  const closeAllTabs = () => {
    const busy = (id: string) => !!running[id] || remoteRunning[id] != null;
    setTabIds((t) => t.filter(busy));
    if (!busy(design.id)) createNew();
  };

  const { deletingHere, deleteDesign, deleteDesigns, setNewTags, starDesigns, setDesignTags, tagDesigns, designTags } = useDesignList({ design, designs, setDesigns, running, remoteRunning,
    stopSaving, saveSoon, background, designRef, setNotice, forgetDesign, refreshList });

  /** Drop a deleted design from memory and the tabs; the open one is replaced by a new design. */
  function forgetDesign(id: string, refresh = true) {
    background.current.delete(id);
    forgetChatMode(id);
    clearSaveError(id);
    setTabIds((t) => t.filter((x) => x !== id));
    setUnseen((u) => u.filter((x) => x !== id));
    if (currentId.current === id) {
      const name = designRef.current.name;
      createNew();
      // Not after our own delete: only when it happened elsewhere.
      if (!deletingHere.current.has(id)) switchNotice.current = { text: `"${name}" was deleted in another tab or window.`, level: 'info', details: false };
    }
    deletingHere.current.delete(id);
    if (refresh) refreshList();
  }

  // The viewer shows the design's hidden parts and the Object tab's selection.
  // A print in one colour shows in its one filament (of the parts shown, as they would be exported).
  const viewParts = shown?.parts.filter((p) => !hiddenParts.includes(p.name)) ?? [];
  const viewColour = oneColour && viewParts.length ? oneColourFilament(viewParts, oneColour).colour : null;
  const viewerOptions: ViewerOptions = { ...viewOpts, hiddenParts, selectedPart, oneColour: viewColour, showJoins };

  return (
    <div className={`app layout-${layout}`}>
      <TopBar
        compact={layout === 'phone'}
        design={design}
        kind={kind}
        onRename={(name) => setDesign((d) => ({ ...d, name }))}
        onRestore={onRestore}
        onFork={(vi) => void forkVersion(vi)}
        unsavedSettings={unsavedSettings}
        onSaveSettings={saveSettings}
        saveError={saveErrors[design.id]}
        onRetrySave={() => saveNow(design).catch(() => {})}
        tabs={designTabs}
        onOpen={openDesign}
        onCloseTab={closeTab}
        onCloseAllTabs={closeAllTabs}
        onNew={createNew}
        tags={designTags}
        onSetTags={setDesignTags}
        onStar={starDesigns}
        onTag={tagDesigns}
        onDeleteMany={deleteDesigns}
        designs={designs}
        listError={listError}
        onRefreshList={refreshList}
        isRunning={(id) => !!running[id] || remoteRunning[id] != null}
        generating={Object.keys(running).length}
        onDelete={deleteDesign}
      />
      {/* On a small screen the sidebars' open/closed state and widths don't apply: the grid shows the
          picked panel (data-show) and hides the others, keeping their size (the 3D view's canvas
          never collapses) and their scroll position. */}
      <main ref={workspace} className={shownTab ? `workspace layout-${layout} ${layout === 'split' && !leftOpen ? 'pane-closed' : ''}` : `workspace ${leftOpen ? '' : 'left-closed'} ${rightOpen ? '' : 'right-closed'}`}
        data-show={shownTab ?? undefined}
        style={{ '--left-w': `${widths.left}px`, '--right-w': `${widths.right}px` } as React.CSSProperties}>
        {!shownTab && leftOpen && <div className="sidebar-resize left" role="separator" aria-orientation="vertical" aria-label="Resize the chat sidebar" title="Drag to resize · double-click for the default width" onPointerDown={resize('left')} onDoubleClick={() => setUserWidths(({ left: _l, ...u }) => u)} />}
        {!shownTab && rightOpen && <div className="sidebar-resize right" role="separator" aria-orientation="vertical" aria-label="Resize the parameters sidebar" title="Drag to resize · double-click for the default width" onPointerDown={resize('right')} onDoubleClick={() => setUserWidths(({ right: _r, ...u }) => u)} />}
        {shownTab && layout !== 'desktop' && (
          <LayoutTabs mode={layout} active={shownTab} onSelect={showPanel} working={generating || busyElsewhere} newModel={newModel} />
        )}
        <ChatPanel
          designId={design.id}
          messages={design.messages}
          versions={design.versions}
          currentVersion={design.currentVersion}
          generating={generating}
          busyElsewhere={busyElsewhere}
          onSend={onSend}
          onAnswer={onAnswer}
          onStop={() => running[design.id]?.abort()}
          queued={queue?.items ?? []}
          queuePaused={!!queue?.paused}
          onQueue={enqueue}
          onSteer={(text, images, drawings, scad, meshes) => void steerOrQueue(text, images, drawings, scad, meshes)}
          onRemoveQueued={removeQueued}
          onSendQueued={sendQueued}
          onRestore={onRestore}
          model={chat.model} onModel={(model) => setChat({ model })}
          effort={chat.effort} onEffort={(effort) => setChat({ effort })}
          webSearch={chat.webSearch}
          onWebSearch={(webSearch) => setChat({ webSearch })}
          imageMode={chat.imageMode}
          artworkModel={artworkModel}
          meshy={meshy}
          meshyCredits={meshy ? meshyCredits : null}
          onImageMode={(imageMode) => setChat({ imageMode })}
          figureColor={!!chat.figureColor}
          onFigureColor={(figureColor) => setChat({ figureColor })}
          lineArtStyle={chat.lineArtStyle ?? DEFAULT_LINE_ART_STYLE}
          onLineArtStyle={(lineArtStyle) => setChat({ lineArtStyle })}
          waitForOk={waitForOk}
          onWaitForOk={setWaitForOk}
          sendView={sendView}
          onSendView={setSendView}
          askFirst={askFirst}
          sounds={sounds}
          onSounds={setSounds}
          onAskFirst={setAskFirst}
          autoBuild={autoBuild && autoBuild.designId === design.id && design.messages.at(-1)?.id === autoBuild.messageId ? autoBuild : null}
          onBuildNow={() => buildConcepts.current()}
          onStopAutoBuild={() => setAutoBuild(null)}
          defaultModel={chatDefaults.model}
          hasModel={!!design.code}
          dictation={dictation}
          claudeProblem={claudeProblem}
        />
        <ViewerPanel
          costStatus={cost.running && { text: STAGE_TEXT[cost.running.stage], since: cost.running.since }}
          result={playback ? playback.result : sizes.viewResult ?? result ?? lastGood}
          banner={sizes.viewed && !playback ? <>
            <b>Size {sizes.viewed.label}</b>{' '}
            {sizes.viewResult && sizes.resolvedOf(sizes.viewed) ? <span className="mono">{sizeText(sizes.resolvedOf(sizes.viewed)!.size)}</span> : <><span className="spinner" /> building it…</>}
            <button className="link" onClick={() => sizes.view(null)}>Back to the design</button>
          </> : null}
          recolor={playback ? null : recolor}
          previewColors={previewColors}
          error={error}
          busy={busy}
          // Fits the camera to a sale size shown, and back to the design.
          fitKey={`${fitKey}:${sizes.viewResult ? sizes.viewed?.id : ''}`}
          options={picking ? { ...viewerOptions, pickText: true, measure: false } : repaint.view ? { ...viewerOptions, measure: false } : viewerOptions}
          onOptions={(o) => { if (o.hiddenParts !== viewerOptions.hiddenParts) setHiddenParts(o.hiddenParts); setViewOpts(o); }}
          quality={quality}
          onQuality={setQuality}
          onEditDimension={onEditDimension}
          onPickSurface={onPickSurface}
          repaint={playback ? null : repaint.view}
          onRepaintPick={repaint.pick}
          onRepaintStroke={repaint.stroke}
          paintRef={repaint.paintRef}
          snapshotRef={snapshotRef}
          photoRef={photoRef}
          photos={{
            open: photosOpen,
            onToggle: () => setPhotosOpen((o) => !o),
            busy: photoJobs.jobs.filter((j) => j.designId === design.id && !j.error).length,
            panel: (
              <PhotosPanel
                open={photosOpen}
                onClose={() => setPhotosOpen(false)}
                designId={design.id}
                designName={design.name}
                summary={design.versions[design.currentVersion]?.summary}
                result={sizes.viewResult ?? result ?? lastGood}
                hiddenParts={hiddenParts}
                oneColour={viewColour}
                photos={design.photos ?? []}
                sizes={sizes.sizes.map((s) => ({ id: s.id, label: s.label, mm: s.mm, axis: s.axis, dims: sizes.resolvedOf(s)?.size }))}
                viewedSize={sizes.viewResult ? sizes.viewed?.id ?? null : null}
                designDims={designDims}
                shape={sizes.shape}
                sizeShot={sizeShot}
                onStartSizes={(groups, more) => photoJobs.startSizes(design.id, groups, more)}
                onDelete={(url) => deletePhotos([url])}
                onDeleteMany={deletePhotos}
                capture={(view, aspect, scale) => photoRef.current?.(view, aspect, undefined, scale) ?? null}
                jobs={photoJobs.jobs}
                onStart={(r, more) => photoJobs.start(design.id, r, more)}
                onStartSet={(rs, more) => photoJobs.startSet(design.id, rs, more)}
                onRetry={photoJobs.retry}
                onDismiss={photoJobs.dismiss}
                imageModel={artworkModel}
                notAssembled={!!layoutKey && layoutValue !== 'assembled' && !playback}
              />
            ),
          }}
          canAssemble={canAssemble}
          assembly={playback?.steps ?? null}
          assemblyLoading={playbackLoading}
          onAssemble={startAssembly}
          onAssemblyClose={() => setPlayback(null)}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          // The split layout's pane (chat or panel) hides like the chat sidebar, for the whole width to the 3D view.
          onToggleLeft={layout === 'phone' ? undefined : () => setLeftOpen((o) => !o)}
          leftName={layout === 'split' ? (shownPanel.pane === 'chat' ? 'chat' : 'panel') : undefined}
          onToggleRight={shownTab ? undefined : () => setRightOpen((o) => !o)}
          validation={validation}
          validationOpen={validationOpen}
          onValidationClose={() => setValidationOpen(false)}
          notice={notice}
          onNoticeDetails={() => { setValidationOpen(true); setNotice(null); }}
          onNoticeClose={() => setNotice(null)}
          // A line art in one piece looks the same in every layout.
          layout={layoutKey && shown && layoutDef?.type === 'select' && (!shownLineArt || splitArt) ? {
            value: String(design.values[layoutKey] ?? shown.values[layoutKey] ?? layoutDef.value),
            options: layoutDef.options,
          } : null}
          onLayout={(v) => layoutKey && onValue(layoutKey, v)}
          emptyState={generating
            ? <div className="empty-inner"><span className="spinner big" /><p>Jig is designing your model…</p></div>
            : <div className="empty-inner"><Icon name="cube" size={44} /><p>Describe an object or drop reference photos in the chat to start.</p></div>}
        />
        <SidePanel
          designId={design.id}
          designName={design.name}
          summary={design.versions[design.currentVersion]?.summary}
          cost={cost}
          sources={dimensionSources}
          result={result}
          lastGood={lastGood}
          error={error}
          code={design.code}
          onValue={onValue}
          onResetValues={() => setDesign((d) => ({ ...d, values: keepAppValues(d.values) }))}
          values={design.values}
          onLayerTone={setLayerTone}
          onLineArtEdits={setLineArtEdits}
          onPartColor={setPartColor}
          onEditLineArt={() => setEditingLineArt(true)}
          onShowJoins={setShowJoins}
          onMeshPalette={(name, palette) => setDesign((d) => {
            const meshes = parseMeshes(d.values[MESHES_KEY]);
            if (!meshes[name]) return d;
            return { ...withMesh(d, name, { ...meshes[name], palette }), updatedAt: Date.now() };
          })}
          repaint={repaint}
          onRepaintStart={(name) => { setPicking(null); repaint.start(name); }}
          onLayerToneImage={(name, image) => setDesign((d) => ({ ...withLayerToneImage(d, name, image), updatedAt: Date.now() }))}
          onEditDimension={onEditDimension}
          textFeatures={textFeatures}
          onTextFeatures={setTextFeatures}
          svgFeatures={svgFeatures}
          onSvgFeatures={setSvgFeatures}
          fonts={fonts}
          picking={picking}
          onPick={setPicking}
          scale={Number(design.values[SCALE_KEY] ?? 1)}
          onScale={onScale}
          sizes={sizes}
          onApplyCode={onApplyCode}
          onExport={onExport}
          onExportProject={onExportProject}
          exportStage={exportStage}
          exporting={exporting}
          exportError={exportError}
          onValidate={onValidate}
          validating={validating}
          aiPrint={aiPrint}
          userPrint={userPrint}
          printBase={printBase}
          onUserPrint={setUserPrint}
          bambu={bambu}
          printChanges={printChanges}
          threeMf={threeMf}
          onThreeMf={setThreeMf}
          oneColour={oneColour}
          onOneColour={setOneColour}
          onExport3mf={() => onExport('3mf')}
          blender={blender}
          hiddenParts={hiddenParts}
          paramOwners={paramOwners?.key === ownersKey ? paramOwners.owners : undefined}
          onToggleHidden={toggleHidden}
          onHiddenParts={setHiddenParts}
          selectedPart={selectedPart}
          onSelectPart={setSelectedPart}
        />
      </main>
      {editingLineArt && editorPart && (
        <LineArtEditor
          part={editorPart}
          values={design.values}
          busy={busy}
          error={error?.message ?? null}
          onEdits={setLineArtEdits}
          onClose={() => setEditingLineArt(false)}
          original={lineArtOriginal}
        />
      )}
      {pendingRestore != null && (
        <RestoreDialog
          target={pendingRestore}
          nextVersion={design.versions.length + 1}
          onCancel={() => setPendingRestore(null)}
          onDiscard={() => { restore(pendingRestore); setPendingRestore(null); }}
          onSaveAndSwitch={() => { saveSettings(); restore(pendingRestore); setPendingRestore(null); }}
        />
      )}
    </div>
  );
}
