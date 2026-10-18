// Builds 3MF files and project zips off the page's main thread: a big model (a 250 mm LayerTone
// print has millions of vertices) is written out as XML and zipped, which would freeze the page for seconds.
import { zipSync, type Zippable } from 'fflate';
import { toBambuProject } from './bambu3mf';
import { to3mf } from './export';
import type { WorkerJob } from './projects';

/** The meshes the page lent (positions, indices per part), handed back with the file. */
const lent = (parts: WorkerJob['parts']) => parts.map((p) => [p.positions, p.indices] as [Float32Array, Uint32Array]);

self.onmessage = async (e: MessageEvent<WorkerJob & { id: number }>) => {
  const { id, ...job } = e.data;
  try {
    let buf: ArrayBuffer;
    if (job.kind === 'zip') {
      const files: Zippable = {};
      for (const [name, f] of Object.entries(job.files)) files[name] = [f.data, { level: f.compress ? 6 : 0 }];
      // zipSync's output fills its buffer exactly: sent as it is, without a copy.
      buf = zipSync(files).buffer as ArrayBuffer;
    } else {
      buf = await (job.kind === 'bambu'
        ? toBambuProject(job.parts, job.title, job.tpl, job.opts)
        : to3mf(job.parts, job.title, job.colours)).arrayBuffer();
    }
    (self as unknown as Worker).postMessage({ id, buf, meshes: lent(job.parts) }, [buf, ...lent(job.parts).flat().map((a) => a.buffer)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message, meshes: lent(job.parts) }, lent(job.parts).flat().map((a) => a.buffer));
  }
};
