// Builds 3MF files off the page's main thread: a big model (a 250 mm HueForge print has millions of
// vertices) is written out as XML and zipped, which would freeze the page for seconds.
import { toBambuProject } from './bambu3mf';
import { to3mf } from './export';
import type { ProjectJob } from './projects';

self.onmessage = async (e: MessageEvent<ProjectJob & { id: number }>) => {
  const { id, ...job } = e.data;
  try {
    const blob = job.kind === 'bambu'
      ? toBambuProject(job.parts, job.title, job.tpl, job.opts)
      : to3mf(job.parts, job.title, job.colours);
    const buf = await blob.arrayBuffer();
    (self as unknown as Worker).postMessage({ id, buf }, [buf]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
