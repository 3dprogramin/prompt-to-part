// Builds 3MF files off the page's main thread: a big model (a 250 mm HueForge print has millions of
// vertices) is written out as XML and zipped, which would freeze the page for seconds.
import { toBambuProject } from './bambu3mf';
import { to3mf } from './export';
import type { ProjectJob } from './projects';

/** The meshes the page lent (positions, indices per part), handed back with the file. */
const lent = (parts: ProjectJob['parts']) => parts.map((p) => [p.positions, p.indices] as [Float32Array, Uint32Array]);

self.onmessage = async (e: MessageEvent<ProjectJob & { id: number }>) => {
  const { id, ...job } = e.data;
  try {
    const blob = job.kind === 'bambu'
      ? toBambuProject(job.parts, job.title, job.tpl, job.opts)
      : to3mf(job.parts, job.title, job.colours);
    const buf = await blob.arrayBuffer();
    (self as unknown as Worker).postMessage({ id, buf, meshes: lent(job.parts) }, [buf, ...lent(job.parts).flat().map((a) => a.buffer)]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message, meshes: lent(job.parts) }, lent(job.parts).flat().map((a) => a.buffer));
  }
};
