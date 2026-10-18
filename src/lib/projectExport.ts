// "Export project…": everything about one design in one folder. Chrome and Edge write it into a
// folder the user picks; other browsers download it as one zip (built in the export worker). One
// piece failing (Blender, say) doesn't lose the rest: the README says what is missing and why.
import { strToU8 } from 'fflate';
import type { Design, EvalResult, PartMesh, Vec3 } from '../../shared/types';
import type { BambuTemplate } from '../../shared/api';
import type { PrintProfile, PrintSettings } from '../../shared/print';
import { LAYERTONE_IMAGES_KEY, parseLayerToneImages } from '../../shared/layertone';
import { MESHES_KEY, parseMeshes } from '../../shared/meshes';
import { api, request } from './api';
import { exportParts, toBlend } from './export';
import { toBinaryStl } from './files';
import { layerToneImageToDataUrl } from './layerToneImage';
import { zipFiles, type ZipFiles } from './projects';
import { paramRows, planProject, printRows, projectReadme, safeName, type PlannedFile } from './project';

type DirectoryPicker = (o?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
const picker = () => (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

/** Where a project goes: a folder the user picked (Chrome, Edge), or a zip download. */
export type ProjectTarget = { kind: 'folder'; dir: FileSystemDirectoryHandle } | { kind: 'zip' };

/**
 * Asks where to put the project; call it first thing in the click (the browser only shows the
 * picker for a user's action). A zip where there is no folder picker. Throws AbortError when the
 * user cancels.
 */
export async function chooseTarget(): Promise<ProjectTarget> {
  const pick = picker();
  if (!pick) return { kind: 'zip' };
  return { kind: 'folder', dir: await pick({ id: 'jig-projects', mode: 'readwrite' }) };
}

export interface ProjectSource {
  design: Design;
  /** design.jig.json: the design as the server stores it (what Import designs… reads). */
  designJson: string;
  /** The model built at export resolution, and its visible parts. */
  result: EvalResult;
  parts: PartMesh[];
  /** The model's name (names the model files, as in Export STL). */
  title: string;
  base: string;
  print: { ai: PrintProfile; user: PrintProfile; base: Required<PrintSettings> };
  /** Bambu Studio is installed (the 3MF can be a Bambu project). */
  bambu: boolean;
  /** Blender is usable, or why not (null: not installed). */
  blender: { ok: true } | { ok: false; why: string | null };
  /** The validation of the exported mesh. */
  check?: string;
  onTemplate?: (tpl: BambuTemplate) => void;
}

export interface ProjectOutcome {
  /** The folder's name (or the zip's, without .zip). */
  name: string;
  files: string[];
  problems: string[];
}

/** Pictures, 3MF and GLB are compressed already. */
const STORED = /\.(png|jpe?g|webp|gif|3mf|glb)$/i;

interface Sink {
  put(path: string, data: Blob | string): Promise<void>;
  /** After the last file: the zip is built and downloaded. */
  finish(): Promise<void>;
}

async function folderSink(dir: FileSystemDirectoryHandle, want: string): Promise<{ name: string; sink: Sink }> {
  // A new folder each time: an earlier export of the same design is never overwritten.
  let folder: FileSystemDirectoryHandle, name: string;
  for (let n = 1; ; n++) {
    if (n > 999) throw new Error(`There are too many folders called "${want}" there`);
    name = n === 1 ? want : `${want} (${n})`;
    try {
      await dir.getDirectoryHandle(name);
      continue; // taken
    } catch (e) {
      const why = (e as DOMException).name;
      if (why === 'TypeMismatchError') continue; // a file has that name
      if (why !== 'NotFoundError') throw e;
    }
    folder = await dir.getDirectoryHandle(name, { create: true });
    break;
  }
  const subs = new Map<string, FileSystemDirectoryHandle>();
  return {
    name,
    sink: {
      async put(path, data) {
        const parts = path.split('/');
        let d = folder;
        if (parts.length > 1) {
          d = subs.get(parts[0]) ?? await folder.getDirectoryHandle(parts[0], { create: true });
          subs.set(parts[0], d);
        }
        const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
        try {
          await w.write(data);
          await w.close();
        } catch (e) {
          await w.abort().catch(() => {});
          throw e;
        }
      },
      async finish() {},
    },
  };
}

function zipSink(name: string, download: (b: Blob, file: string) => void): Sink {
  const files: ZipFiles = {};
  return {
    async put(path, data) {
      files[`${name}/${path}`] = { data: typeof data === 'string' ? strToU8(data) : new Uint8Array(await data.arrayBuffer()), compress: !STORED.test(path) };
    },
    async finish() {
      download(await zipFiles(files), `${name}.zip`);
    },
  };
}

const sizeOf = (parts: PartMesh[]): Vec3 | null => (parts.length
  ? [0, 1, 2].map((k) => Math.max(...parts.map((p) => p.bbox.max[k])) - Math.min(...parts.map((p) => p.bbox.min[k]))) as Vec3
  : null);

/**
 * Makes the project's files and writes them to the target. `onStage` gets what is being made
 * ("3MF"). Throws only when the folder or zip itself can't be written; a piece that fails is
 * left out and listed in the README and the outcome.
 */
export async function exportProject(src: ProjectSource, target: ProjectTarget, onStage: (what: string) => void,
  download: (b: Blob, file: string) => void): Promise<ProjectOutcome> {
  const { design, result: r, parts, title } = src;
  const want = safeName(design.name);
  const problems: string[] = [], notes: string[] = [];

  onStage('pictures');
  const stored = await api.designFiles(design.id).catch((e: Error) => {
    problems.push(`The pictures and meshes: ${e.message}`);
    return { images: [], meshes: [] };
  });
  const pictures = parseLayerToneImages(design.values[LAYERTONE_IMAGES_KEY]);
  if (!src.blender.ok) notes.push(`No \`.blend\` file: ${src.blender.why ?? 'Blender is not installed on the computer Jig runs on'}.`);
  if (!src.bambu) notes.push('The 3MF has no print settings: Bambu Studio is not installed on the computer Jig runs on.');
  const plan = planProject({ base: src.base, blend: src.blender.ok, images: stored.images, meshes: stored.meshes, pictures: Object.keys(pictures) });

  const { name, sink } = target.kind === 'folder' ? await folderSink(target.dir, want) : { name: want, sink: zipSink(want, download) };
  let bambuProject = false;
  const make = async (f: PlannedFile): Promise<Blob | string> => {
    switch (f.kind) {
      case 'model': return design.code;
      case 'values': return `${JSON.stringify(Object.fromEntries(Object.entries(r.values).filter(([k]) => !k.startsWith('$'))), null, 2)}\n`;
      case 'design': return src.designJson;
      case 'stl': return toBinaryStl(parts, title);
      case 'blend': return toBlend(r, parts, title, design.code);
      case '3mf': {
        if (src.bambu) {
          try {
            const blob = await exportParts('3mf', r, parts, title, design.code, { colours: true, print: { ai: src.print.ai, user: src.print.user }, onTemplate: src.onTemplate });
            bambuProject = true;
            return blob;
          } catch (e) {
            notes.push(`The 3MF has no print settings: the Bambu Studio project could not be made (${(e as Error).message}).`);
          }
        }
        return exportParts('3mf', r, parts, title, design.code, { colours: true, print: null });
      }
      case 'image': return (await request(`/api/designs/${design.id}/images/${f.source}`)).blob();
      case 'mesh': return (await request(`/api/designs/${design.id}/meshes/${f.source}`)).blob();
      case 'picture': return (await fetch(layerToneImageToDataUrl(pictures[f.source!]))).blob();
      case 'readme': throw new Error('the README is written last');
    }
  };

  const written: string[] = [];
  for (const f of plan) {
    if (f.kind === 'readme') continue;
    onStage(f.label);
    let data: Blob | string;
    try {
      data = await make(f);
    } catch (e) {
      problems.push(`\`${f.path}\`: ${(e as Error).message}`);
      continue;
    }
    await sink.put(f.path, data);
    written.push(f.path);
  }

  onStage('README');
  const v = design.versions[design.currentVersion];
  const readme = projectReadme({
    name: design.name.trim() || title, date: new Date(), version: import.meta.env.VITE_APP_VERSION ?? '',
    versionNo: design.currentVersion + 1, versions: design.versions.length, summary: v?.summary,
    size: sizeOf(parts), parts: parts.map((p) => p.name),
    params: paramRows(r.params, r.values), print: printRows(src.print.ai, src.print.user, src.print.base, parts.map((p) => p.name)),
    sources: v?.sources ?? [], meshes: parseMeshes(design.values[MESHES_KEY]), check: src.check, bambuProject,
    files: [...written, 'README.md'], notes, problems,
  });
  await sink.put('README.md', readme);
  written.push('README.md');
  if (target.kind === 'zip') onStage('zip');
  await sink.finish();
  return { name, files: written, problems };
}
