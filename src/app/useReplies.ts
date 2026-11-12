// Talking to the AI: a message sent (with what the user sees), its reply followed to its end, the
// answers to its questions, messages queued while it works, the concept pictures' countdown and
// a reply still under way on the server caught up with.
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ChatMessage, Design, ParamValues } from '../../shared/types';
import { resolveValues, SCALE_KEY } from '../../shared/params';
import { MAX_SCAD_FILES, type ScadFile } from '../../shared/scad';
import { DRAWINGS_KEY, parseDrawings, type SvgDrawing, type SvgFeature } from '../../shared/svgFeatures';
import type { TextFeature } from '../../shared/textFeatures';
import { LAYERTONE_KEY } from '../../shared/layertone';
import { DEFAULT_LINE_ART_STYLE, LINEART_EDITS_KEY, parseLineArtEdits } from '../../shared/lineart';
import { CONCEPTS_KEY, freeMeshName, MESHES_KEY, parseMeshes, withConcept } from '../../shared/meshes';
import type { GenerateRequest, MeshUpload } from '../../shared/api';
import { answerText } from '../../shared/questions';
import { formatReset } from '../../shared/usage';
import { generate, resumeReply, steer, type AgentEvent, type ReplyEnd } from '../lib/api';
import { addStep, applyBlock } from '../lib/activity';
import { approvalText, autoBuildAfter, withView, type AutoBuild, type DrawnConcept } from '../lib/autoBuild';
import { playCue } from '../lib/sounds';
import { dataUrlToImage, uid } from '../lib/files';
import { tell } from '../lib/tabs';
import type { useDesignSaving } from '../hooks/useDesignSaving';
import type { useCrossTabSync } from '../hooks/useCrossTabSync';
import type { useLiveModel } from '../hooks/useLiveModel';
import { describeSvg, describeText } from './describe';
import { pictureValues, withDrawings, withLayerToneImage, withMesh } from './designValues';
import { editorEditsSince } from '../lib/pictureEdit';
import { addReplyEdit, replyModel, withPictureEdited, type PendingEdit } from './replyVersion';
import { useLinesUp } from './useLinesUp';
import type { ChatOptions } from './useChatOptions';

/** A message written while Claude was working, sent after its reply. */
interface QueuedMessage { text: string; images: string[]; drawings: SvgDrawing[]; scad: ScadFile[]; meshes: MeshUpload[] }

export function useReplies({ design, setDesign, updateDesign, running, setRunning, remoteRunning, setUnseen, currentId, background, cancelPending, saveNow, result, lastGood, chat,
  textFeatures, svgFeatures, sendView, askFirst, imageTool, waitForOk, waitForOkRef, soundsRef, meshy, refreshMeshyCredits, autoBuild, setAutoBuild, claudeProblem, busy, snapshotRef, fullValues }: {
  design: Design; setDesign: Dispatch<SetStateAction<Design>>;
  /** Applies a change to a design whether it is open or generating in the background. */
  updateDesign: (id: string, fn: (d: Design) => Design) => void;
  running: Record<string, AbortController>; setRunning: Dispatch<SetStateAction<Record<string, AbortController>>>;
  remoteRunning: ReturnType<typeof useCrossTabSync>;
  setUnseen: Dispatch<SetStateAction<string[]>>;
  currentId: RefObject<string>;
  background: RefObject<Map<string, Design>>;
  cancelPending: ReturnType<typeof useDesignSaving>['cancelPending']; saveNow: ReturnType<typeof useDesignSaving>['saveNow'];
  result: ReturnType<typeof useLiveModel>['result']; lastGood: ReturnType<typeof useLiveModel>['lastGood'];
  chat: ChatOptions;
  textFeatures: TextFeature[]; svgFeatures: SvgFeature[];
  sendView: boolean; askFirst: boolean; imageTool: boolean; waitForOk: boolean; waitForOkRef: RefObject<boolean>; soundsRef: RefObject<boolean>;
  meshy: boolean; refreshMeshyCredits: () => void;
  autoBuild: AutoBuild | null; setAutoBuild: Dispatch<SetStateAction<AutoBuild | null>>;
  claudeProblem: string | null;
  /** The model is being rebuilt. */
  busy: boolean;
  snapshotRef: RefObject<(() => string | null) | null>;
  fullValues: () => ParamValues;
}) {
  // A version made by a reply that edited a picture: whether it lines up is measured on its build.
  const watchLinesUp = useLinesUp({ design, setDesign, result, busy });
  const resultRef = useRef(result);
  resultRef.current = result;
  /**
   * Follows the reply `asstId` on design `designId` to its end (`stream` starts it, or catches up
   * with one under way): its events update that design, even if another one is open by now.
   */
  const followReply = async (designId: string, asstId: string, stream: (onEvent: (ev: AgentEvent, seen: number) => void, signal: AbortSignal) => Promise<ReplyEnd>) => {
    // Updates always go to the design this generation belongs to, even if another one is open by now.
    const update = (fn: (d: Design) => Design) => updateDesign(designId, fn);
    const patchAsst = (fn: (m: ChatMessage) => ChatMessage) =>
      update((d) => ({ ...d, messages: d.messages.map((m) => (m.id === asstId ? fn(m) : m)) }));
    const abort = new AbortController();
    setRunning((r) => ({ ...r, [designId]: abort }));
    tell({ type: 'running', id: designId, on: true });
    let finished = false;
    // Messages queued meanwhile go out only after a reply that ended normally.
    let completed = false;
    // Meshy started a model in this reply: the credits changed.
    let usedMeshy = false;
    // Concept pictures drawn in this reply, and whether it failed (for the countdown).
    const drawn: DrawnConcept[] = [];
    let failed = false;
    // The AI asked questions in this reply (they wait for an answer).
    let asked = false;
    // Its picture edits (edit_picture) not yet in a version: they came from the version current as
    // it started (its build on screen then), or from the reply's last version (`parent` is set as
    // that version is made, before the next version's update reads it).
    const pending: PendingEdit = { edit: null, parent: design.currentVersion };
    let parentBox = result?.bbox ?? null, madeVersion = false;
    let end: ReplyEnd | undefined;
    try {
      end = await stream((ev, count) => {
        if (ev.type === 'session') update((d) => (d.sessionId === ev.sessionId ? d : { ...d, sessionId: ev.sessionId, sessionCostUsd: undefined }));
        else if (ev.type === 'lineArtEditsBaked') update((d) => {
          // A partial edit drew the hand edits into the drawing: they're part of it now (their colours stay, on it).
          const { [ev.name]: _baked, ...others } = parseLineArtEdits(d.values[LINEART_EDITS_KEY]);
          const rest = ev.kept ? { ...others, [ev.name]: ev.kept } : others;
          const values = { ...d.values };
          if (Object.keys(rest).length) values[LINEART_EDITS_KEY] = JSON.stringify(rest); else delete values[LINEART_EDITS_KEY];
          return { ...d, values };
        });
        else if (ev.type === 'drawing') update((d) => ({ ...d, values: { ...d.values, [DRAWINGS_KEY]: JSON.stringify({ ...parseDrawings(d.values[DRAWINGS_KEY]), [ev.name]: ev.drawing }) } }));
        else if (ev.type === 'layerToneImage') update((d) => withLayerToneImage(d, ev.name, ev.image));
        else if (ev.type === 'pictureEdited') {
          // The first edit after one of this reply's versions: that version's build is the one on screen.
          if (!pending.edit && madeVersion) parentBox = resultRef.current?.bbox ?? null;
          pending.edit = addReplyEdit(pending.edit, ev.info);
          update((d) => withPictureEdited(d, ev.set));
        }
        else if (ev.type === 'mesh') update((d) => withMesh(d, ev.name, ev.entry));
        else if (ev.type === 'concept') {
          drawn.push({ name: ev.name, color: !!ev.entry.color });
          update((d) => ({ ...d, values: { ...d.values, [CONCEPTS_KEY]: withConcept(d.values[CONCEPTS_KEY], ev.name, ev.entry) } }));
        }
        else if (ev.type === 'layerToneSetup') update((d) => {
          const { [LAYERTONE_KEY]: _old, ...rest } = d.values;
          return { ...d, values: ev.setup ? { ...rest, [LAYERTONE_KEY]: JSON.stringify(ev.setup) } : rest };
        });
        else if (ev.type === 'step') {
          // Meshy started a task (credits spent, even if it fails later).
          if (ev.step.text.startsWith('Meshy task ')) usedMeshy = true;
          patchAsst((m) => ({ ...m, steps: [...(m.steps ?? []), ev.step], activity: addStep(m.activity ?? [], ev.step) }));
        }
        else if (ev.type === 'questions') { asked = true; patchAsst((m) => ({ ...m, questions: ev.questions })); }
        else if (ev.type === 'live') patchAsst((m) => ({ ...m, live: ev.text }));
        else if (ev.type === 'block') patchAsst((m) => ({ ...m, activity: applyBlock(m.activity ?? [], ev) }));
        else if (ev.type === 'model') {
          // This version takes the edits so far; a later submit without a new edit records none.
          const e = pending.edit, box = parentBox;
          pending.edit = null;
          madeVersion = true;
          update((d) => {
            const r = replyModel(d, ev, asstId, { edit: e, parent: pending.parent });
            pending.parent = r.pending.parent;
            if (e) watchLinesUp({ designId: d.id, version: r.design.currentVersion, values: r.design.values, parentBox: box, masked: e.masked, outsideSame: e.outsideSame });
            return r.design;
          });
        } else if (ev.type === 'done') {
          finished = true; completed = true;
          patchAsst((m) => ({ ...m, text: ev.text, durationMs: ev.durationMs, ...(ev.costUsd !== undefined && { costUsd: ev.costUsd }) }));
          if (ev.sessionCostUsd !== undefined) update((d) => ({ ...d, sessionCostUsd: ev.sessionCostUsd }));
        }
        else if (ev.type === 'error') { finished = true; failed = true; patchAsst((m) => ({ ...m, error: ev.resetsAt ? `${ev.message} It resets ${formatReset(ev.resetsAt)}.` : ev.message })); }
        // How far this copy of the reply has got, so a page opened later can catch up with it.
        patchAsst((m) => ({ ...m, run: ev.type === 'run' ? { id: ev.runId, seen: count } : m.run && { ...m.run, seen: count } }));
      }, abort.signal);
      // Another page (or tab) follows the reply now and owns the design: its saves win over this note.
      if (end === 'moved') return void patchAsst((m) => ({ ...m, live: undefined, error: 'This reply carries on in another window: reload to see it here.' }));
      if (!finished) patchAsst((m) => ({ ...m, error: 'Connection to the server was lost before the reply finished (the server may have restarted). Send "continue" to pick up where it stopped.' }));
    } catch (e) {
      if (!abort.signal.aborted) patchAsst((m) => ({ ...m, error: (e as Error).message }));
      else patchAsst((m) => ({ ...m, error: 'Stopped.' }));
    } finally {
      if (end !== 'moved') patchAsst((m) => ({ ...m, live: undefined, pending: undefined, run: undefined }));
      // Stopped or failed: messages queued for after this reply wait for the user ("Send now").
      if (!completed) setQueues((s) => (s[designId]?.items.length ? { ...s, [designId]: { ...s[designId], paused: true } } : s));
      setRunning((r) => { const next = { ...r }; delete next[designId]; return next; });
      if (currentId.current !== designId) setUnseen((u) => (u.includes(designId) ? u : [...u, designId]));
      tell({ type: 'running', id: designId, on: false });
      if (usedMeshy && meshy) refreshMeshyCredits();
      // "Wait for my OK" off: new concept pictures on the design open here are built after a countdown.
      const next = autoBuildAfter({ designId, messageId: asstId, concepts: drawn, completed, error: failed, openDesignId: currentId.current,
        waitForOk: waitForOkRef.current, queued: !!queuesRef.current[designId]?.items.length, now: Date.now() });
      if (next) setAutoBuild(next);
      // A chime: the AI needs you (questions, concept pictures to approve, an error) or the reply is done.
      // Nothing when the user stopped it, or another window carries on with it.
      if (soundsRef.current && !abort.signal.aborted && (completed || failed)) playCue(failed || asked || drawn.length ? 'attention' : 'done');
      // A design that finished in the background is persisted, then dropped from memory (by
      // onSaved; a failed save keeps it, so "Retry" still has the changes).
      setTimeout(() => {
        const bg = background.current.get(designId);
        if (bg && currentId.current !== designId) {
          cancelPending(designId);
          saveNow(bg).catch(() => {});
        }
      }, 0);
    }
  };

  /** `approval`: the approval of concept pictures (the countdown or Build now), sent without the user's view. */
  const onSend = async (text: string, images: string[], attached: SvgDrawing[] = [], scad: ScadFile[] = [], meshUploads: MeshUpload[] = [], { approval = false } = {}) => {
    const now = Date.now();
    // Any message answers the concept pictures: no countdown any more.
    setAutoBuild(null);
    // Attached mesh files join the design's meshes (H.mesh), each under a name of its own.
    const meshes = parseMeshes(design.values[MESHES_KEY]);
    const meshNames = meshUploads.map((u) => {
      const same = Object.entries(meshes).find(([, m]) => m.file === u.entry.file)?.[0];
      const name = same ?? freeMeshName(u.name, meshes);
      meshes[name] = u.entry;
      return name;
    });
    const files = [...scad.map((f) => f.name), ...meshUploads.map((u) => u.entry.original ?? u.name)];
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, images, ...(files.length ? { files } : {}), createdAt: now };
    // Saved as it grows, marked pending until it ends (a reply still pending on load was interrupted).
    const asst: ChatMessage = { id: uid(), role: 'assistant', text: '', steps: [], createdAt: now, pending: true };
    const designId = design.id;
    // For follow-ups, capture exactly what the user is looking at before the chat changes anything
    // (unless "Send my view" is off, or this only approves concept pictures).
    const current = followUpContext(sendView && !approval);
    // Attached SVG drawings are kept with the design, so scripts can use them (H.svg) everywhere.
    const drawings = withDrawings(parseDrawings(design.values[DRAWINGS_KEY]), attached);
    const sentValues: ParamValues = {
      ...design.values,
      ...(attached.length ? { [DRAWINGS_KEY]: JSON.stringify(drawings) } : {}),
      ...(meshNames.length ? { [MESHES_KEY]: JSON.stringify(meshes) } : {}),
    };
    setDesign((d) => ({
      ...d, messages: [...d.messages, userMsg, asst], updatedAt: now,
      values: {
        ...d.values,
        ...(attached.length ? { [DRAWINGS_KEY]: JSON.stringify(drawings) } : {}),
        ...(meshNames.length ? { [MESHES_KEY]: JSON.stringify({ ...parseMeshes(d.values[MESHES_KEY]), ...Object.fromEntries(meshNames.map((n) => [n, meshes[n]])) }) } : {}),
      },
    }));
    const editorEdits = editorEditsSince(design.versions);
    await followReply(designId, asst.id, (onEvent, signal) => generate({
      designId: design.id,
      prompt: text,
      images: images.map(dataUrlToImage),
      code: design.code || undefined,
      values: (result ?? lastGood) ? resolveValues((result ?? lastGood)!.params, design.values) : undefined,
      textNote: [describeText(textFeatures), describeSvg(svgFeatures)].filter(Boolean).join('; ') || undefined,
      ...current,
      // The render Claude gets of the current model already has the newly attached meshes.
      ...(current.renderValues && meshNames.length ? { renderValues: { ...current.renderValues, [MESHES_KEY]: sentValues[MESHES_KEY] } } : {}),
      // Picture edits kept in the brush editor since the chat's last version.
      ...(editorEdits.length ? { pictureEdits: editorEdits } : {}),
      sessionId: design.sessionId,
      sessionCostUsd: design.sessionId ? design.sessionCostUsd : undefined,
      model: chat.model,
      effort: chat.effort,
      webSearch: chat.webSearch,
      // (An approval of concept pictures just goes ahead.)
      askFirst: askFirst && !approval,
      ...(imageTool ? {} : { imageTool: false }),
      imageMode: chat.imageMode,
      ...(chat.imageMode === 'figure' && chat.figureColor ? { figureColor: true } : {}),
      ...(chat.imageMode === 'lineart' ? { lineArtStyle: chat.lineArtStyle ?? DEFAULT_LINE_ART_STYLE } : {}),
      artwork: chat.imageMode === 'artwork',
      drawings: Object.keys(drawings).length ? drawings : undefined,
      // The design's pictures, meshes and LayerTone setup, so Claude has them even before a first version exists.
      pictures: pictureValues(sentValues),
      meshes: meshNames.length ? meshNames : undefined,
      scad: scad.length ? scad : undefined,
      // In case the session can't be continued: what was said, for a fresh one.
      // (A reply that asked questions brings them along.)
      history: design.messages.slice(-12).flatMap((m) => {
        const t = [m.text.trim(), m.questions ? `Asked: ${m.questions.map((q) => q.question).join(' ')}` : ''].filter(Boolean).join('\n');
        return t ? [{ role: m.role, text: t.slice(0, 1500) }] : [];
      }),
    }, onEvent, signal));
  };

  // "Ask first": the answers chosen on a question card go out as the user's message (with the
  // current toggles, as any other), and the card keeps them to show read-only.
  const onAnswer = (messageId: string, answers: string[][]) => {
    const m = design.messages.find((x) => x.id === messageId);
    if (!m?.questions) return;
    setDesign((d) => ({ ...d, messages: d.messages.map((x) => (x.id === messageId ? { ...x, answers } : x)) }));
    void onSend(answerText(m.questions, answers), []);
  };

  // ---- messages sent while Claude works: queued per design, sent together once the reply is done
  const [queues, setQueues] = useState<Record<string, { items: QueuedMessage[]; paused: boolean }>>({});
  const queue = queues[design.id];
  const queuesRef = useRef(queues);
  queuesRef.current = queues;
  // While Claude works, a message goes into the running reply (Claude reads it at its next step);
  // files Claude can only take with a new request, or a reply that has just ended, queue it instead.
  const steerOrQueue = async (text: string, images: string[], drawings: SvgDrawing[], scad: ScadFile[], meshes: MeshUpload[]) => {
    if (drawings.length || scad.length || meshes.length || !(await steer(design.id, text, images.map(dataUrlToImage)))) enqueue(text, images, drawings, scad, meshes);
  };
  const enqueue = (text: string, images: string[], drawings: SvgDrawing[], scad: ScadFile[], meshes: MeshUpload[] = []) =>
    setQueues((s) => ({ ...s, [design.id]: { items: [...(s[design.id]?.items ?? []), { text, images, drawings, scad, meshes }], paused: false } }));
  const removeQueued = (i: number) => setQueues((s) => {
    const items = (s[design.id]?.items ?? []).filter((_, j) => j !== i);
    const next = { ...s };
    if (items.length) next[design.id] = { ...s[design.id], items }; else delete next[design.id];
    return next;
  });
  const sendQueued = () => {
    const q = queues[design.id];
    if (!q?.items.length) return;
    setQueues((s) => { const next = { ...s }; delete next[design.id]; return next; });
    void onSend(q.items.map((m) => m.text).filter(Boolean).join('\n\n'), q.items.flatMap((m) => m.images).slice(0, 8), q.items.flatMap((m) => m.drawings), q.items.flatMap((m) => m.scad).slice(0, MAX_SCAD_FILES), q.items.flatMap((m) => m.meshes));
  };
  // The countdown ends (or Build now): the approval goes out as the user's message, only on the
  // design it was for, still open here and idle, with that reply still the last message.
  const buildConcepts = useRef(() => {});
  buildConcepts.current = () => {
    const a = autoBuild;
    setAutoBuild(null);
    if (!a || a.designId !== design.id || design.messages.at(-1)?.id !== a.messageId || running[design.id] || remoteRunning[design.id] != null || claudeProblem) return;
    void onSend(approvalText(a.concepts), [], [], [], [], { approval: true });
  };
  useEffect(() => {
    if (!autoBuild) return;
    const t = setTimeout(() => buildConcepts.current(), Math.max(0, autoBuild.until - Date.now()));
    return () => clearTimeout(t);
  }, [autoBuild]);
  // Opening another design, or turning "Wait for my OK" back on, ends the countdown.
  useEffect(() => { setAutoBuild((a) => (a && a.designId !== design.id ? null : a)); }, [design.id]);
  useEffect(() => { if (waitForOk) setAutoBuild(null); }, [waitForOk]);
  // When the open design's reply is done (and its new model is on screen), the queue goes out.
  useEffect(() => {
    if (queue?.items.length && !queue.paused && !running[design.id] && remoteRunning[design.id] == null && !busy) sendQueued();
  }, [queue, running, remoteRunning, busy, design.id]);

  // A reply the server is still working on when its design is opened (the page was reloaded, or
  // another device started it): catch up with it, unless another tab here follows it already.
  const resumeLast = useRef(() => {});
  resumeLast.current = () => {
    const m = design.messages.at(-1);
    const run = m?.pending && m.run;
    if (!m || !run || running[design.id] || remoteRunning[design.id] != null) return;
    void followReply(design.id, m.id, (onEvent, signal) => resumeReply(design.id, run, onEvent, signal));
  };
  const lastRun = design.messages.at(-1)?.run?.id;
  useEffect(() => {
    if (!lastRun) return;
    // Other tabs first say whether they follow it (they answer "hello" at once).
    const t = setTimeout(() => resumeLast.current(), 1500);
    return () => clearTimeout(t);
  }, [design.id, lastRun]);

  /** What Claude needs to see the model exactly as the user does (follow-ups only); `view`: with the screenshot and the four-view render. */
  const followUpContext = (view: boolean): Pick<GenerateRequest, 'currentView' | 'renderValues' | 'scale' | 'versionNote'> => {
    if (!design.code || !(result ?? lastGood)) return {};
    let currentView: { mediaType: string; data: string } | undefined;
    try {
      const shot = view ? snapshotRef.current?.() : null;
      if (shot) currentView = dataUrlToImage(shot);
    } catch { /* screenshot is optional */ }
    const renderValues: ParamValues = fullValues();
    const scale = Number(design.values[SCALE_KEY] ?? 1);
    const latest = design.versions.length - 1;
    const cur = design.versions[design.currentVersion];
    const versionNote = design.currentVersion >= 0 && design.currentVersion < latest
      ? `The user restored version ${design.currentVersion + 1} of ${latest + 1} ("${cur.summary}"). The current script is that version, not your latest one – work from it.`
      : cur?.source === 'manual' ? 'The user edited the script by hand after your last version – keep their edits.' : undefined;
    return withView({ currentView, renderValues, scale: scale !== 1 ? scale : undefined, versionNote }, view);
  };
  return { onSend, onAnswer, queue, steerOrQueue, enqueue, removeQueued, sendQueued, buildConcepts };
}
