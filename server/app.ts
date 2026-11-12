// The HTTP API (and, with --production, the built app). server/index.ts starts it.
import express from 'express';
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { runGeneration } from './agent';
import { DATA_DIR, EXTRA_HOSTS, MAX_GENERATIONS, PASSWORD, PORT, PRODUCTION, ROOT } from './config';
import { HEALTH_PATH, requirePassword } from './auth';
import { suggestPrice } from './pricing';
import { writeScene } from './photoScene';
import { lookupFilament } from './filaments';
import { writeIdeas } from './ideas';
import { requestImage } from './artwork';
import { checkConnection } from './connection';
import { DESIGNS, TAGS_FILE, readTags, writeAtomically, type RouteContext } from './routes/store';
import { registerDesignRoutes } from './routes/designs';
import { registerImageRoutes } from './routes/images';
import { registerPictureEditRoutes } from './routes/pictureEdit';
import { registerMeshRoutes } from './routes/meshes';
import { registerPrintedRoutes } from './routes/printed';
import { PRINTED_JSON, readPrinted } from './printed';
import { registerSystemRoutes } from './routes/system';
import { openRouterModels } from './openRouterModels';
import { registerCostRoutes } from './routes/cost';
import { registerFilamentRoutes } from './routes/filaments';
import { registerIdeaRoutes } from './routes/ideas';
import { registerBackupRoutes } from './routes/backup';
import { registerExportRoutes } from './routes/exports';
import { registerGenerateRoutes } from './routes/generate';
import { registerPrinterRoutes } from './routes/printer';
import { loadPrinterSetting } from './printerSetting';

export { endGenerations } from './routes/generate';

export interface AppOptions {
  /** Port the server listens on: requests must name it in their Host header. */
  port?: number;
  /** Names it answers to besides localhost and 127.0.0.1 (PTP_HOSTS). */
  hosts?: string[];
  /** Runs a generation (tests pass a stand-in instead of Claude). */
  generate?: typeof runGeneration;
  /** Suggests a selling price (tests pass a stand-in instead of Claude). */
  suggest?: typeof suggestPrice;
  /** Writes a random sub-scene for a product photo (tests pass a stand-in instead of Claude). */
  sceneWriter?: typeof writeScene;
  /** Finds a filament's colour and TD (tests pass one with a stand-in for Claude). */
  lookup?: typeof lookupFilament;
  /** Writes new starter ideas (tests pass a stand-in instead of Claude). */
  ideas?: typeof writeIdeas;
  /** OpenRouter's models for the model menu (tests pass a stand-in instead of the network). */
  models?: typeof openRouterModels;
  /** Asks the image model for a picture (tests pass a stand-in). */
  image?: typeof requestImage;
  /** Checks what the app runs Claude on and its usage (tests pass a stand-in: the real one may start Claude Code). */
  connection?: typeof checkConnection;
  /** The password every request must carry (PTP_PASSWORD), or '' for none. */
  password?: string;
  /** Most replies at once, over all designs (PTP_MAX_GENERATIONS). */
  maxGenerations?: number;
}

export function createApp({ port = PORT, hosts = EXTRA_HOSTS, generate = runGeneration, suggest = suggestPrice, sceneWriter = writeScene, lookup = lookupFilament, ideas = writeIdeas, image = requestImage, connection = checkConnection, models = openRouterModels, password = PASSWORD, maxGenerations = MAX_GENERATIONS }: AppOptions = {}): express.Express {
  const app = express();

  // With PTP_PASSWORD, every page and API call needs it (HTTP Basic auth): the Host and Origin checks
  // below only stop browsers on other sites, not another device on the network calling the API.
  if (password) app.use(requirePassword(password));

  // Only the app's own pages may use the API. The Host check defeats DNS rebinding (a website whose
  // domain is re-pointed at 127.0.0.1), the Origin check refuses every other site, including pages
  // on other local ports, and requiring the X-PTP header on writes means a plain cross-site form or
  // beacon can never change anything. In development the Vite proxy (vite.config.ts) passes requests
  // from the app's own page on with the API's origin and leaves every other origin as it is.
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', ...hosts].map((h) => `${h}:${port}`));
  const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map((h) => `http://${h}`));
  app.use('/api', (req, res, next) => {
    if (!LOCAL_HOSTS.has(req.headers.host ?? '')) return void res.status(421).json({ error: 'Unexpected Host header' });
    const origin = req.headers.origin;
    if (origin && !LOCAL_ORIGINS.has(origin)) return void res.status(403).json({ error: 'Cross-origin request refused' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-ptp'] !== '1') return void res.status(403).json({ error: 'Missing X-PTP header' });
    next();
  });
  // Docker's healthcheck: only that the server answers (it needs no password).
  app.get(HEALTH_PATH, (_req, res) => void res.json({ ok: true }));
  // Body size limits per route: a design (its images are stored separately) or a generation request
  // with a few photos is small; a mesh sent for .blend export can be large.
  const json = (limit: string) => express.json({ limit });

  const designFile = (id: string) => path.join(DESIGNS, `${id}.json`);
  const imageDir = (id: string) => path.join(DESIGNS, id);
  // One generation per design at a time (each design has a single working file and session).
  const generatingDesigns = new Set<string>();

  // Writes to one design run one after another, each through its own temp file, so overlapping
  // saves (two tabs, an autosave racing a retry) can never interleave into a corrupt file.
  const writeQueues = new Map<string, Promise<unknown>>();
  // Designs deleted while this server runs: a late save (another tab, an upload still in flight)
  // must not bring one back.
  const deleted = new Set<string>();
  function serially<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (writeQueues.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    writeQueues.set(id, next);
    void next.finally(() => { if (writeQueues.get(id) === next) writeQueues.delete(id); }).catch(() => undefined);
    return next;
  }

  // Tags: one change at a time, like the stars. Only a saved design can be tagged (the page keeps a
  // new design's tags until its first save), so no tags are left behind for designs that never were.
  let tagging = Promise.resolve();
  /** Runs `change` on the stored tags (in the queue) and writes what it returns. */
  const changeTags = (change: (all: Record<string, string[]>) => Promise<void> | void) => {
    const next = tagging.then(async () => {
      const all = await readTags();
      await change(all);
      await mkdir(DATA_DIR, { recursive: true });
      await writeAtomically(TAGS_FILE, JSON.stringify({ tags: all }));
    });
    tagging = next.catch(() => undefined);
    return next;
  };
  /** Sets one design's tags in `all` (none: its entry goes). */
  const putTags = (all: Record<string, string[]>, id: string, tags: string[]) => { if (tags.length) all[id] = tags; else delete all[id]; };

  // Printed marks: one change at a time, like the tags.
  let printing = Promise.resolve();
  const changePrinted: RouteContext['changePrinted'] = (change) => {
    const next = printing.then(async () => {
      const all = await readPrinted();
      await change(all);
      await mkdir(DATA_DIR, { recursive: true });
      await writeAtomically(PRINTED_JSON, JSON.stringify({ printed: all }));
    });
    printing = next.catch(() => undefined);
    return next;
  };

  // The API's route groups (server/routes/), in the order Express matches them.
  const ctx: RouteContext = { json, designFile, imageDir, generatingDesigns, deleted, serially, changeTags, putTags, changePrinted };
  registerDesignRoutes(app, ctx);
  registerImageRoutes(app, ctx, { image, sceneWriter });
  registerPictureEditRoutes(app, ctx, { image });
  registerMeshRoutes(app, ctx);
  registerPrintedRoutes(app, ctx);
  registerSystemRoutes(app, { connection, models: () => models() });
  registerCostRoutes(app, ctx, { suggest });
  registerPrinterRoutes(app, ctx);
  // The saved printer becomes the server's current one (the AI's instructions, validation, templates).
  void loadPrinterSetting().catch((e) => console.error('Could not read the printer setting:', e));
  registerFilamentRoutes(app, ctx, { lookup });
  registerIdeaRoutes(app, ctx, { ideas });
  registerBackupRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerGenerateRoutes(app, ctx, { generate, maxGenerations });

  const dist = path.join(ROOT, 'dist');
  if (PRODUCTION) {
    if (!existsSync(path.join(dist, 'index.html'))) console.warn('[prompt-to-part] dist/ is missing: run `pnpm build` first; only the API is served.');
    else if (newestSource() > statSync(path.join(dist, 'index.html')).mtimeMs) console.warn('[prompt-to-part] dist/ is older than the source code: run `pnpm build` to serve the current app.');
    // Built files under assets/ have a content hash in their name: a new build gets new names.
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  return app;
}

/** Newest modification time of the files the browser app is built from. */
function newestSource(): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  for (const d of ['src', 'shared']) walk(path.join(ROOT, d));
  return Math.max(newest, ...['index.html', 'vite.config.ts', 'package.json'].map((f) => statSync(path.join(ROOT, f)).mtimeMs));
}
