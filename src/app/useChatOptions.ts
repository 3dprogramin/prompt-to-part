// The chat's options per design (model, effort, web search, picture mode) and the switches kept
// for this browser (Wait for my OK, Send my view, Ask first, Sounds).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Design } from '../../shared/types';
import { DRAWINGS_KEY } from '../../shared/svgFeatures';
import { LAYERTONE_IMAGES_KEY } from '../../shared/layertone';
import { MESHES_KEY } from '../../shared/meshes';
import type { LineArtStyle } from '../../shared/lineart';
import { designKind, kindImageMode } from '../../shared/designKind';
import type { ImageMode } from '../components/ChatPanel';
import { loadChatModes, storeChatMode } from '../lib/chatModes';
import { unlockSounds } from '../lib/sounds';
import { load, store } from '../lib/storage';

export interface ChatOptions { model: string; effort: string; webSearch: boolean; imageMode: ImageMode; figureColor?: boolean; lineArtStyle?: LineArtStyle }
const DEFAULT_CHAT: ChatOptions = { model: 'fable', effort: 'high', webSearch: true, imageMode: 'off' };

export function useChatOptions(design: Design) {
  // Model, effort and web search per design, in memory only: every new design (and every reload)
  // starts with Fable 5.2, High effort and web search on.
  const [chatOpts, setChatOpts] = useState<Record<string, ChatOptions>>({});
  // The starting model and effort come from the server's settings (PTP_MODEL, PTP_EFFORT).
  const [chatDefaults, setChatDefaults] = useState<ChatOptions>(DEFAULT_CHAT);
  // What kind of design it is (line art, LayerTone…), from its code: shown by its name.
  const kind = useMemo(() => designKind(design.code, design.values),
    [design.code, design.values[LAYERTONE_IMAGES_KEY], design.values[MESHES_KEY], design.values[DRAWINGS_KEY]]);
  // The picture mode each design was last used with, kept for this browser (read once: this tab's
  // changes are in chatOpts); a design without one starts in its kind's mode.
  const [chatModes] = useState(loadChatModes);
  const chatStart: ChatOptions = { ...chatDefaults, ...(chatModes[design.id] ?? { imageMode: kindImageMode(kind) }) };
  const chat = chatOpts[design.id] ?? chatStart;
  const setChat = (patch: Partial<ChatOptions>) => {
    if ('imageMode' in patch || 'figureColor' in patch || 'lineArtStyle' in patch) storeChatMode(design.id, { ...chat, ...patch });
    setChatOpts((o) => ({ ...o, [design.id]: { ...(o[design.id] ?? chatStart), ...patch } }));
  };
  // Chat switches kept for this browser: "Wait for my OK" (3D figure mode: you approve each concept
  // picture; off, it is built after a countdown) and "Send my view" (follow-ups bring the AI your view).
  const [waitForOk, setWaitForOk] = useState<boolean>(() => load('waitForOk', true));
  useEffect(() => store('waitForOk', waitForOk), [waitForOk]);
  const waitForOkRef = useRef(waitForOk);
  waitForOkRef.current = waitForOk;
  const [sendView, setSendView] = useState<boolean>(() => load('sendView', true));
  useEffect(() => store('sendView', sendView), [sendView]);
  // "Ask first": the AI asks the few questions it can't answer itself before it builds (all modes).
  const [askFirst, setAskFirst] = useState<boolean>(() => load('askFirst', true));
  useEffect(() => store('askFirst', askFirst), [askFirst]);
  const [sounds, setSounds] = useState<boolean>(() => load('sounds', true));
  useEffect(() => store('sounds', sounds), [sounds]);
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;
  useEffect(() => unlockSounds(), []);
  return { chatDefaults, setChatDefaults, kind, chat, setChat, waitForOk, setWaitForOk, waitForOkRef, sendView, setSendView, askFirst, setAskFirst, sounds, setSounds, soundsRef };
}
