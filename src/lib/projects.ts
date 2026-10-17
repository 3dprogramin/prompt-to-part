// 3MF files built in a worker (projectWorker.ts), so exporting or pricing a big model doesn't
// freeze the page.
import type { BambuTemplate } from '../../shared/api';
import type { PartMesh } from '../../shared/types';
import type { toBambuProject } from './bambu3mf';

export type ProjectJob =
  | { kind: 'bambu'; parts: PartMesh[]; title: string; tpl: BambuTemplate; opts: Parameters<typeof toBambuProject>[3] }
  | { kind: '3mf'; parts: PartMesh[]; title: string; colours: boolean };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { parts: PartMesh[]; resolve: (b: Blob) => void; reject: (e: Error) => void }>();

/** The worker gets the meshes only: not the viewer's display data. */
const meshOnly = (parts: PartMesh[]): PartMesh[] => parts.map(({ display: _d, vertexColors: _v, ...p }) => p);

export function buildProject(job: ProjectJob): Promise<Blob> {
  if (!worker) {
    worker = new Worker(new URL('./projectWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; buf?: ArrayBuffer; error?: string; meshes: [Float32Array, Uint32Array][] }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      // The meshes come back as they were lent: put them back on the caller's parts.
      e.data.meshes.forEach(([positions, indices], i) => Object.assign(p.parts[i], { positions, indices }));
      if (e.data.buf) p.resolve(new Blob([e.data.buf], { type: 'model/3mf' }));
      else p.reject(new Error(e.data.error ?? 'Building the 3MF failed'));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'The 3MF worker stopped'));
      pending.clear();
      worker = null;
    };
  }
  const id = ++seq;
  // The meshes are lent to the worker without copying (tens of MB for a big print would block the
  // page while copied) and come back with the file.
  const parts = meshOnly(job.parts);
  const lent = parts.flatMap((q) => [q.positions.buffer, q.indices.buffer]).filter((b, i, all) => all.indexOf(b) === i);
  return new Promise((resolve, reject) => {
    pending.set(id, { parts: job.parts, resolve, reject });
    worker!.postMessage({ ...job, parts, id }, lent);
  });
}
