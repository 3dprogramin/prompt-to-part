// Builds 3MF files and project zips off the page's main thread: a big model (a 250 mm LayerTone
// print has millions of vertices) is written out as XML and zipped, which would freeze the page for seconds.
import { buildJob } from './projectBuild';
import type { WorkerJob } from './projects';

/** The meshes the page lent (positions, indices per part), handed back with the file. */
const lent = (parts: WorkerJob['parts']) => parts.map((p) => [p.positions, p.indices] as [Float32Array, Uint32Array]);

self.onmessage = async (e: MessageEvent<WorkerJob & { id: number }>) => {
  const { id, ...job } = e.data;
  try {
    const buf = await buildJob(job);
    (self as unknown as Worker).postMessage({ id, buf, meshes: lent(job.parts) }, [buf, ...lent(job.parts).flat().map((a) => a.buffer)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message, meshes: lent(job.parts) }, lent(job.parts).flat().map((a) => a.buffer));
  }
};
