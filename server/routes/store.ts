// Where the designs, their images and the user's settings are stored, and what the route groups share.
import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { DATA_DIR } from '../config';
import type { Design } from '../../shared/types';
import { cleanTagMap } from '../../shared/tags';

export const DESIGNS = path.join(DATA_DIR, 'designs');
export const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
/** The starred designs' ids, apart from the designs so starring doesn't change one (or its place in the list). */
export const STARRED_FILE = path.join(DATA_DIR, 'starred.json');
export const cleanStarred = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))] : []);
export const readStarred = async () => cleanStarred((JSON.parse(await readFile(STARRED_FILE, 'utf8').catch(() => '{}')) as { ids?: unknown }).ids);
/** Each design's tags (shared/tags.ts) by id, apart from the designs for the same reason. */
export const TAGS_FILE = path.join(DATA_DIR, 'tags.json');
export const readTags = async () => cleanTagMap((JSON.parse(await readFile(TAGS_FILE, 'utf8').catch(() => '{}')) as { tags?: unknown }).tags, (id) => ID_RE.test(id));

/** The fields every saved design has; anything else would break the list or the app. */
export function isDesign(d: unknown): d is Design {
  const o = d as Design;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.code === 'string'
    && Number.isFinite(o.updatedAt) && Number.isFinite(o.createdAt) && Number.isInteger(o.currentVersion)
    && Array.isArray(o.messages) && Array.isArray(o.versions) && !!o.values && typeof o.values === 'object'
    && (o.rev === undefined || Number.isInteger(o.rev)) && (o.photos === undefined || Array.isArray(o.photos)) && (o.sizes === undefined || Array.isArray(o.sizes));
}

// Chat images (reference photos, renders, assembly pictures) are stored once per design, by
// content, instead of inside the design JSON that is rewritten on every autosave.
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const IMAGE_NAME = /^[0-9a-f]{32}\.(png|jpg|webp|gif)$/;

/** Write through a temp file and rename it into place, so readers see the old or the new file. */
export async function writeAtomically(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/**
 * Middleware for a heavy route (a slice, a .blend export) that admits one request running and one
 * waiting and answers 429 with `busy` beyond that. It runs before the body is read, so further
 * uploads of up to hundreds of MB are refused at once instead of piling up in memory; a request
 * counts until its response is finished or its connection drops.
 */
export function oneAtATime(busy: string, max = 2): express.RequestHandler {
  let inFlight = 0;
  return (_req, res, next) => {
    if (inFlight >= max) return void res.status(429).set('Retry-After', '10').json({ error: busy });
    inFlight++;
    res.once('close', () => { inFlight--; });
    next();
  };
}

/** What createApp's route groups share: the body parser, the designs' files and their queues. */
export interface RouteContext {
  /** express.json with a body size limit. */
  json: (limit: string) => ReturnType<typeof express.json>;
  designFile: (id: string) => string;
  imageDir: (id: string) => string;
  /** Designs with a reply under way. */
  generatingDesigns: Set<string>;
  /** Designs deleted while this server runs. */
  deleted: Set<string>;
  /** Runs `fn` after the design's earlier writes. */
  serially: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  /** Runs `change` on the stored tags (in the queue) and writes what it returns. */
  changeTags: (change: (all: Record<string, string[]>) => Promise<void> | void) => Promise<void>;
  /** Sets one design's tags in `all` (none: its entry goes). */
  putTags: (all: Record<string, string[]>, id: string, tags: string[]) => void;
}
