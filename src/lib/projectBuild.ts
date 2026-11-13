// What the project worker does with a job, kept apart from the worker's message plumbing so it can run (and be tested) anywhere.
import { zipSync, type Zippable } from 'fflate';
import { setPrinter } from '../../shared/printer';
import { toBambuProject } from './bambu3mf';
import { to3mf } from './export';
import type { WorkerJob } from './projects';

/** Builds the file for a job. The worker's printer is the job's: its module state is never the page's. */
export async function buildJob(job: WorkerJob): Promise<ArrayBuffer> {
  setPrinter(job.printer);
  if (job.kind === 'zip') {
    const files: Zippable = {};
    for (const [name, f] of Object.entries(job.files)) files[name] = [f.data, { level: f.compress ? 6 : 0 }];
    // zipSync's output fills its buffer exactly: sent as it is, without a copy.
    return zipSync(files).buffer as ArrayBuffer;
  }
  return (job.kind === 'bambu'
    ? toBambuProject(job.parts, job.title, job.tpl, job.opts)
    : to3mf(job.parts, job.title, job.oneColour)).arrayBuffer();
}
