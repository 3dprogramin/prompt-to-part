// "Export project…": what goes into a design's project folder and its README (projectExport.ts
// makes and writes the files). Pure, so it is tested without a browser.
import type { ParamDef, ParamValues, Vec3 } from '../../shared/types';
import { describeSetting, effectiveSettings, SETTING_LABELS, type PrintProfile, type PrintSettings } from '../../shared/print';
import { SOURCE_KINDS, type DimensionSource } from '../../shared/sources';
import type { MeshEntry } from '../../shared/meshes';

/** Names Windows keeps for devices: a file or folder can't be called that, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A design's name as a folder or file name that works on Windows, macOS and Linux. */
export function safeName(name: string, fallback = 'Untitled design'): string {
  let s = name.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    // No leading dot (a hidden file) and no trailing dot or space (Windows drops them).
    .replace(/^[.\s]+|[.\s]+$/g, '');
  // At most 80 characters (whole ones: an emoji is two UTF-16 units).
  const chars = Array.from(s);
  if (chars.length > 80) s = chars.slice(0, 80).join('').replace(/[.\s]+$/, '');
  if (RESERVED.test(s)) s = `${s}-design`;
  return s || fallback;
}

export type FileKind = 'model' | 'values' | 'design' | 'stl' | '3mf' | 'blend' | 'image' | 'picture' | 'mesh' | 'readme';

export interface PlannedFile {
  /** Path inside the project folder. */
  path: string;
  kind: FileKind;
  /** What the progress says while it is made ("Exporting project… 3MF"). */
  label: string;
  /** image, mesh: the stored file's name; picture: the LayerTone or lithophane picture's name. */
  source?: string;
}

/**
 * The files of a project, in the order they are made (the README last: it says what worked).
 * `base` names the model files (as Export STL names its file); `blend` when Blender can be used.
 */
export function planProject(o: { base: string; blend: boolean; images: string[]; meshes: string[]; pictures: string[] }): PlannedFile[] {
  const files: PlannedFile[] = [
    { path: 'model.js', kind: 'model', label: 'script' },
    { path: 'values.json', kind: 'values', label: 'values' },
    { path: 'design.jig.json', kind: 'design', label: 'design' },
    { path: `${o.base}.stl`, kind: 'stl', label: 'STL' },
  ];
  // Before the 3MF: its worker borrows the meshes while it runs.
  if (o.blend) files.push({ path: `${o.base}.blend`, kind: 'blend', label: '.blend' });
  files.push({ path: `${o.base}.3mf`, kind: '3mf', label: '3MF' });
  for (const n of o.images) files.push({ path: `images/${n}`, kind: 'image', label: 'pictures', source: n });
  const taken = new Set<string>();
  for (const n of o.pictures) {
    let file = `picture-${safeName(n, 'picture')}`;
    for (let i = 2; taken.has(file.toLowerCase()); i++) file = `picture-${safeName(n, 'picture')}-${i}`;
    taken.add(file.toLowerCase());
    files.push({ path: `images/${file}.png`, kind: 'picture', label: 'pictures', source: n });
  }
  for (const n of o.meshes) files.push({ path: `meshes/${n}`, kind: 'mesh', label: 'meshes', source: n });
  files.push({ path: 'README.md', kind: 'readme', label: 'README' });
  return files;
}

export interface Row { label: string; value: string; group?: string }

const fmt = (n: number) => String(+n.toFixed(4));

/** The model's parameters with their current values, as the side panel shows them. */
export function paramRows(params: Record<string, ParamDef>, values: ParamValues): Row[] {
  return Object.entries(params).filter(([k]) => !k.startsWith('$')).map(([k, def]) => {
    const v = values[k] ?? def.value;
    const value = def.type === 'boolean' ? (v ? 'on' : 'off')
      : def.type === 'select' ? def.options.find((o) => o.value === v)?.label ?? String(v)
        : def.type === 'text' ? `"${String(v)}"`
          : `${typeof v === 'number' ? fmt(v) : String(v)}${def.unit ? ` ${def.unit}` : ''}`;
    return { label: def.label ?? k, value, ...(def.group ? { group: def.group } : {}) };
  });
}

export interface PrintRow { label: string; value: string; /** The profile's value (for a part: the model's). */ was: string; part?: string }

/** Print settings that differ from the profile, for the whole model, then per part (from the model's). */
export function printRows(ai: PrintProfile, user: PrintProfile, base: Required<PrintSettings>, parts: string[]): PrintRow[] {
  const keys = Object.keys(base) as (keyof PrintSettings)[];
  const model = effectiveSettings(ai, user, undefined, base);
  const rows: PrintRow[] = keys.filter((k) => model[k] !== base[k])
    .map((k) => ({ label: SETTING_LABELS[k], value: describeSetting(k, model[k]), was: describeSetting(k, base[k]) }));
  for (const part of parts) {
    const s = effectiveSettings(ai, user, part, base);
    for (const k of keys) if (s[k] !== model[k]) rows.push({ part, label: SETTING_LABELS[k], value: describeSetting(k, s[k]), was: describeSetting(k, model[k]) });
  }
  return rows;
}

export interface ReadmeInfo {
  name: string;
  /** When it was exported, and by which Jig. */
  date: Date;
  version: string;
  /** The exported version (1-based) of how many, and its summary. */
  versionNo: number;
  versions: number;
  summary?: string;
  /** Overall size of the exported parts, mm. */
  size: Vec3 | null;
  parts: string[];
  params: Row[];
  print: PrintRow[];
  sources: DimensionSource[];
  meshes: Record<string, MeshEntry>;
  /** The 3MF is a Bambu Studio project (with the print settings), not a plain 3MF. */
  bambuProject: boolean;
  /** The validation of the exported mesh ("No problems found", "1 warning"). */
  check?: string;
  /** The files written (paths in the folder). */
  files: string[];
  /** What was left out or done differently on purpose (no Blender, no Bambu Studio). */
  notes: string[];
  /** What failed: "x.blend: Blender stopped". */
  problems: string[];
}

/** A Markdown table cell: no line breaks, pipes escaped. */
const cell = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
const pad = (n: number) => String(n).padStart(2, '0');

export function projectReadme(i: ReadmeInfo): string {
  const out: string[] = [`# ${i.name}`, ''];
  if (i.summary) out.push(i.summary.trim(), '');
  const when = `${i.date.getFullYear()}-${pad(i.date.getMonth() + 1)}-${pad(i.date.getDate())} ${pad(i.date.getHours())}:${pad(i.date.getMinutes())}`;
  out.push(`Exported from Jig ${i.version} on ${when}${i.versions > 0 ? ` (version ${i.versionNo} of ${i.versions})` : ''}.`, '');
  if (i.size) out.push(`**Size:** ${i.size.map((v) => v.toFixed(2)).join(' × ')} mm (W × D × H)`, '');
  if (i.parts.length > 1) out.push(`**Parts:** ${i.parts.join(', ')}`, '');
  if (i.check) out.push(`**Print check:** ${i.check}`, '');

  if (i.problems.length) {
    out.push('## Not exported', '', ...i.problems.map((p) => `- ${p}`), '');
  }

  if (i.params.length) {
    const grouped = i.params.some((r) => r.group);
    out.push('## Parameters', '', grouped ? '| Group | Parameter | Value |' : '| Parameter | Value |', grouped ? '| --- | --- | --- |' : '| --- | --- |');
    for (const r of i.params) out.push(grouped ? `| ${cell(r.group ?? '')} | ${cell(r.label)} | ${cell(r.value)} |` : `| ${cell(r.label)} | ${cell(r.value)} |`);
    out.push('', 'The same values are in `values.json`.', '');
  }

  out.push('## Print settings', '');
  if (i.print.length) {
    out.push('Bambu Lab A1, PLA, 0.20 mm Standard, with these changes:', '', '| Setting | Value | Default |', '| --- | --- | --- |');
    for (const r of i.print) out.push(`| ${cell(r.part ? `${r.part}: ${r.label}` : r.label)} | ${cell(r.value)} | ${cell(r.was)} |`);
  } else {
    out.push('Bambu Lab A1, PLA, 0.20 mm Standard, no changes.');
  }
  out.push('');

  if (i.sources.length) {
    out.push('## Where the dimensions come from', '');
    for (const s of i.sources) out.push(`- ${s.dimension}: ${s.value} (${SOURCE_KINDS[s.kind]?.label ?? s.kind}${s.url ? `, <${s.url}>` : ''})`);
    out.push('');
  }

  const meshes = Object.entries(i.meshes);
  if (meshes.length) {
    out.push('## Meshes', '');
    for (const [name, m] of meshes) {
      const from = m.source === 'meshy' ? 'made by Meshy' : m.original ? `from ${m.original}` : 'imported';
      out.push(`- ${name}: ${from}, ${m.size.map((v) => v.toFixed(1)).join(' × ')} mm, ${m.triangles.toLocaleString('en')} triangles (\`meshes/${m.file.split('/').pop()}\`)`);
    }
    out.push('', 'The `meshes` folder also has the original files and a picture of each.', '');
  }

  out.push('## Files', '');
  const about: Record<string, string> = {
    'model.js': 'the model script (JavaScript)',
    'values.json': 'the parameter values',
    'design.jig.json': 'the whole Jig design: chat, versions and values',
  };
  for (const f of i.files.filter((p) => !p.includes('/') && p !== 'README.md')) {
    const what = about[f] ?? (f.endsWith('.stl') ? `${i.parts.length > 1 ? 'all parts' : 'the model'} as one mesh`
      : f.endsWith('.3mf') ? (i.bambuProject ? 'a Bambu Studio project with the print settings and colours' : 'the parts with their colours, for any slicer')
        : f.endsWith('.blend') ? 'for Blender: one object per part, materials, dimensions' : '');
    out.push(`- \`${f}\`${what ? ` – ${what}` : ''}`);
  }
  const images = i.files.filter((p) => p.startsWith('images/')).length;
  const meshFiles = i.files.filter((p) => p.startsWith('meshes/')).length;
  if (images) out.push(`- \`images/\` – ${images} picture${images > 1 ? 's' : ''}: photos and drawings from the chat, Jig's renders and product photos${i.files.some((p) => p.startsWith('images/picture-')) ? '; `picture-…` are the LayerTone or lithophane pictures as the design holds them' : ''}`);
  if (meshFiles) out.push(`- \`meshes/\` – ${meshFiles} file${meshFiles > 1 ? 's' : ''}: the imported meshes`);
  out.push('');
  for (const n of i.notes) out.push(n, '');

  out.push('## Back into Jig', '',
    'Zip this folder (or use the zip Jig downloaded) and choose it in **Designs → Import designs…**. A design that is already in Jig is kept as it is: delete it there first to bring back this copy.', '');
  return out.join('\n');
}
