// The chat's picture mode per design, kept for this browser: reopening a design (after a reload
// too) brings back the mode, 3D figure colour and line art style it was last used with. A design
// without one (made before, or in another browser) starts in its kind's mode (designKind).
import type { GenerateRequest } from '../../shared/api';
import { isLineArtStyle, type LineArtStyle } from '../../shared/lineart';
import { load, store } from './storage';

export interface ChatMode { imageMode: NonNullable<GenerateRequest['imageMode']>; figureColor?: boolean; lineArtStyle?: LineArtStyle }
/** As stored: when it was last set, so the oldest go first. */
type Stored = ChatMode & { at: number };

const KEY = 'chatModes';
const IMAGE_MODES = new Set<string>(['off', 'artwork', 'layertone', 'lithophane', 'lineart', 'figure']);
/** Most designs remembered. */
export const MAX_CHAT_MODES = 300;

/** A stored mode, checked (anything unknown is dropped), or null. */
export function cleanChatMode(raw: unknown): ChatMode | null {
  const o = raw as Partial<ChatMode> | null;
  if (!o || typeof o !== 'object' || typeof o.imageMode !== 'string' || !IMAGE_MODES.has(o.imageMode)) return null;
  return {
    imageMode: o.imageMode,
    ...(typeof o.figureColor === 'boolean' && { figureColor: o.figureColor }),
    ...(isLineArtStyle(o.lineArtStyle) && { lineArtStyle: o.lineArtStyle }),
  };
}

/** `all` with the design's mode set, keeping the `max` set most recently. */
export function withChatMode(all: Record<string, Stored>, id: string, mode: ChatMode, at: number, max = MAX_CHAT_MODES): Record<string, Stored> {
  const out = { ...all, [id]: { ...mode, at } };
  const ids = Object.keys(out);
  return ids.length <= max ? out : Object.fromEntries(Object.entries(out).sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0)).slice(0, max));
}

/** What is stored, if it is an object (a mode is checked as it is read). */
function stored(): Record<string, Stored> {
  const o = load<unknown>(KEY, {});
  return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, Stored> : {};
}

/** Every remembered mode (design id → mode), checked. */
export function loadChatModes(): Record<string, ChatMode> {
  const out: Record<string, ChatMode> = {};
  for (const [id, raw] of Object.entries(stored())) {
    const m = cleanChatMode(raw);
    if (m) out[id] = m;
  }
  return out;
}

export function storeChatMode(id: string, mode: ChatMode) {
  store(KEY, withChatMode(stored(), id, cleanChatMode(mode) ?? { imageMode: 'off' }, Date.now()));
}

/** A deleted design's mode goes too. */
export function forgetChatMode(id: string) {
  const all = stored();
  if (!(id in all)) return;
  delete all[id];
  store(KEY, all);
}
