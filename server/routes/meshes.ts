// Mesh files attached in the chat (for H.mesh), and the list of a design's stored files.
import express from 'express';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { geometry } from '../geometry';
import { copyMeshes, MAX_MESH_BYTES, MESH_FILE, meshDir, storeMesh } from '../meshes';
import { freeMeshName } from '../../shared/meshes';
import { meshFormat } from '../../shared/meshFormats';
import type { DesignFiles, MeshUpload } from '../../shared/api';
import { ID_RE, IMAGE_NAME, oneAtATime, type RouteContext } from './store';

export function registerMeshRoutes(app: express.Express, { json, imageDir, deleted, serially }: RouteContext) {
  // Mesh files (STL, OBJ, GLB/glTF, 3MF) attached in the chat: parsed, repaired and made a solid in
  // the locked-down geometry worker, then stored with the design for H.mesh (server/meshes.ts).
  app.post('/api/designs/:id/meshes',
    // The chat uploads every attached file at once and shows four, so allow four: a body can be hundreds of MB.
    oneAtATime('Busy importing other meshes. Try again in a moment.', 4),
    express.raw({ type: 'application/octet-stream', limit: MAX_MESH_BYTES }), async (req, res) => {
    const { id } = req.params;
    const filename = String(req.query.name ?? '').replace(/[/\\]/g, '_').slice(0, 200);
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    if (!meshFormat(filename)) return void res.status(400).json({ error: 'Send an STL, OBJ, GLB/glTF or 3MF file (?name= its file name)' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: 'Send the file as the body (application/octet-stream)' });
    if (deleted.has(id)) return void res.status(410).json({ error: 'This design was deleted' });
    const bytes = new Uint8Array(req.body);
    let imported;
    try {
      imported = await geometry.importMesh(bytes, filename);
    } catch (e) {
      return void res.status(422).json({ error: `${filename}: ${(e as Error).message}` });
    }
    // The import takes seconds; only the writes wait in the design's queue (saves go on meanwhile).
    const entry = await storeMesh(id, imported, { bytes, filename }, { source: 'upload' }, (fn) => serially(id, async () => (deleted.has(id) ? null : fn())));
    if (!entry) return void res.status(410).json({ error: 'This design was deleted' });
    res.json({ name: freeMeshName(filename, {}), entry, report: imported.report } satisfies MeshUpload);
  });

  app.get('/api/designs/:id/meshes/:name', (req, res) => {
    const { id, name } = req.params;
    if (!ID_RE.test(id) || !MESH_FILE.test(name)) return void res.status(400).json({ error: 'bad mesh file' });
    // Named by content, like the images.
    res.sendFile(path.join(meshDir(id), name), { headers: { 'Cache-Control': 'max-age=31536000, immutable', ...(name.endsWith('.bin') ? { 'Content-Type': 'application/octet-stream' } : {}) } }, (e) => {
      if (e && !res.headersSent) res.set('Cache-Control', 'no-store').status(404).json({ error: 'not found' });
    });
  });

  // The images and mesh files stored with a design (what a backup holds of it), for "Export project…".
  app.get('/api/designs/:id/files', async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return void res.status(400).json({ error: 'bad id' });
    const list = async (dir: string, re: RegExp) => (await readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n)).sort();
    res.json({ images: await list(imageDir(id), IMAGE_NAME), meshes: await list(meshDir(id), MESH_FILE) } satisfies DesignFiles);
  });

  // A design started from a version of another one gets copies of that design's mesh files.
  app.post('/api/designs/:id/meshes/copy', json('1kb'), async (req, res) => {
    const { id } = req.params;
    const from = String((req.body as { from?: unknown })?.from ?? '');
    if (!ID_RE.test(id) || !ID_RE.test(from) || id === from) return void res.status(400).json({ error: 'bad id' });
    const copied = await serially(id, async () => (deleted.has(id) ? null : copyMeshes(from, id)));
    if (copied == null) return void res.status(410).json({ error: 'This design was deleted' });
    res.json({ copied });
  });
}
