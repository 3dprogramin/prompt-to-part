// Builds Bambu projects (toBambuProject) for checking the print settings against the real Bambu Studio
// command line; scripts/slice-check.sh runs them in the container's slicer and compares the G-code.
//
//   node --import tsx scripts/slice-check.ts <out-dir> <template.json>
//
// Writes <name>.3mf per case and cases.txt ("<name> <base>" per line: a case is compared with its base).
//
// Scope Bambu Studio 2.8 (the container's bambustudio) accepted per new key, checked 2026-11-18
// (53 projects, 6 slicings each; "differs" = no G-code of the case equals any of its base's):
//   model-wide and on a part:   infill_direction, ironing_speed, ironing_flow, ironing_spacing
//   model-wide and on the object, not on a part (kept in OBJECT_ONLY; on a part these change nothing):
//     xy_hole_compensation, xy_contour_compensation, elefant_foot_compensation, top_one_wall_type, wall_generator
//   model-wide (supports are set per object, so only checked model-wide; OBJECT_ONLY too):
//     support_threshold_angle, support_top_z_distance, support_interface_top_layers, support_style
//   model-wide only:            spiral_mode (no sparse infill, no support in the G-code), and only for one part:
//                              two objects ("spiral-two-parts") are refused (return code -51, "Please select "By
//                              object" print sequence to print multiple objects in spiral vase mode."), one object
//                              of two parts in two colours ("spiral-two-colours") too (-51, "The spiral vase mode
//                              does not work when an object contains more than one materials."). So toBambuProject
//                              leaves it off with more than one part: both now write their base's project (only the
//                              title differs; the two-colour one still "differs" as that model slices in 4+ variants).
//   seam_slope_type:           model-wide only. Needs override_filament_scarf_seam_setting "1" in the project
//                              (template: "0"; with it off the value changes nothing, model-wide or on the object).
//                              With it on, a real scarf: outer-wall moves carry a Z ramp (Z .837 .855 .872 with a
//                              growing E) on the cylinder ("scarf-model"); "all" (outline and holes) prints the same
//                              as "external" (outline) there, as it has no hole; a box (sharp corners) gets none, as
//                              Bambu's seam_slope_conditional wants smooth corners. A value on a part only split the
//                              wall per part, not a scarf, so the app keeps it for the whole model.
//   xy_hole_compensation sign:  positive makes holes bigger, moving each edge by the value. First layer of the ring,
//                              hole's innermost wall loop, X extent: 6.65 mm at 0, 7.05 at +0.2, 6.25 at -0.2.
//   infill_direction on top:   the topmost layer's top surface lines of a 60 x 20 mm plaque run at the value + 90
//                              with 10 layers (0: along Y, 90: along X, 45: at 135) and at the value with 11 layers
//                              (0: along X, 90: along Y, 45: at 45): the direction depends on the layer count.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toBambuProject } from '../src/lib/bambu3mf';
import type { BambuTemplate } from '../shared/api';
import type { PrintSettings } from '../shared/print';
import type { PartMesh } from '../shared/types';

type V = [number, number, number];
const COLOUR = '#d9a441';

function mesh(name: string, v: V[], f: number[][]): PartMesh {
  const min = [0, 1, 2].map((k) => Math.min(...v.map((p) => p[k]))), max = [0, 1, 2].map((k) => Math.max(...v.map((p) => p[k])));
  let vol = 0, area = 0;
  for (const [a, b, c] of f) {
    const [p, q, r] = [v[a], v[b], v[c]];
    vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
  }
  return { name, color: COLOUR, positions: new Float32Array(v.flat()), indices: new Uint32Array(f.flat()), bbox: { min, max } as PartMesh['bbox'], volume: vol, surfaceArea: area, triCount: f.length, genus: 0, components: 1 };
}

/** A box (outward-facing triangles). */
export function box(name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): PartMesh {
  const v: V[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return mesh(name, v, [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]);
}

/** A 10 mm square post leaning 45 degrees (an overhang that supports start from at the default angle of 30). */
export function lean(name: string): PartMesh {
  const v: V[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [14, 0, 14], [24, 0, 14], [24, 10, 14], [14, 10, 14]];
  return mesh(name, v, [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]);
}

/** A square plate with a square hole through it (the hole's wall faces inward). */
export function ring(name: string, x0: number, size: number, hole: number, h: number): PartMesh {
  const o = [[0, 0], [size, 0], [size, size], [0, size]], m = (size - hole) / 2;
  const i = [[m, m], [size - m, m], [size - m, size - m], [m, size - m]];
  // vertices: 0-3 outer bottom, 4-7 inner bottom, 8-11 outer top, 12-15 inner top
  const v: V[] = [...o.map(([x, y]): V => [x + x0, y, 0]), ...i.map(([x, y]): V => [x + x0, y, 0]), ...o.map(([x, y]): V => [x + x0, y, h]), ...i.map(([x, y]): V => [x + x0, y, h])];
  const f: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const n = (k + 1) % 4;
    f.push([k, 4 + k, 4 + n], [k, 4 + n, n]); // bottom ring, facing down (outer ccw seen from above, so reversed)
    f.push([8 + k, 8 + n, 12 + n], [8 + k, 12 + n, 12 + k]); // top ring, facing up
    f.push([k, n, 8 + n], [k, 8 + n, 8 + k]); // outer wall
    f.push([4 + k, 12 + n, 4 + n], [4 + k, 12 + k, 12 + n]); // hole wall, facing the hole
  }
  return mesh(name, v, f);
}

/** A solid cylinder standing on the plate (its left edge at x0). */
export function cylinder(name: string, r: number, h: number, seg = 32, x0 = 0): PartMesh {
  const v: V[] = [[x0 + r, r, 0], [x0 + r, r, h]];
  for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; v.push([x0 + r + r * Math.cos(a), r + r * Math.sin(a), 0], [x0 + r + r * Math.cos(a), r + r * Math.sin(a), h]); }
  const f: number[][] = [];
  for (let k = 0; k < seg; k++) {
    const b = 2 + k * 2, nb = 2 + ((k + 1) % seg) * 2;
    f.push([0, nb, b], [1, b + 1, nb + 1], [b, nb, nb + 1], [b, nb + 1, b + 1]);
  }
  return mesh(name, v, f);
}

const boxes = (): PartMesh[] => [box('Body', 0, 20, 0, 20, 0, 2), box('Lid', 20, 40, 0, 20, 0, 2)]; // touching: one object, two parts
const plates = (): PartMesh[] => [ring('Body', 0, 20, 6, 2), ring('Lid', 40, 20, 6, 2)]; // apart: two objects
const rings = (): PartMesh[] => [ring('Body', 0, 20, 6, 2), ring('Lid', 20, 20, 6, 2)];
// A T lying on its stem: the bar overhangs on both sides (supports are needed under it).
const tee = (): PartMesh[] => [box('Body', 7, 13, 0, 6, 0, 14), box('Lid', 0, 20, 0, 6, 14, 18)];
const slope = (): PartMesh[] => [lean('Body')];
const cyl = (): PartMesh[] => [cylinder('Body', 10, 20)];
const cyls = (): PartMesh[] => [cylinder('Body', 10, 20), cylinder('Lid', 10, 20, 32, 40)]; // apart: two objects
// One object of two touching parts in two colours (exported without one colour).
const stack = (): PartMesh[] => [cylinder('Body', 10, 10), { ...box('Lid', 2, 18, 2, 18, 10, 20), color: '#3a6ea5' }];
const plaque = (): PartMesh[] => [box('Body', 0, 60, 0, 20, 0, 2)]; // 10 layers
const plaqueOdd = (): PartMesh[] => [box('Body', 0, 60, 0, 20, 0, 2.2)]; // 11 layers: the same top lines?

/** colours: exported with one filament per colour (no oneColour). */
interface Case { name: string; base: string; meshes: PartMesh[]; user: PrintSettings & { parts?: Record<string, PrintSettings> }; colours?: boolean }
const bases: Record<string, { meshes: () => PartMesh[]; user: PrintSettings; colours?: boolean }> = {
  base: { meshes: boxes, user: {} },
  'base-ring': { meshes: rings, user: {} },
  'base-apart': { meshes: plates, user: {} },
  'base-iron': { meshes: boxes, user: { ironing: 'top' } },
  'base-normal': { meshes: tee, user: { supports: 'normal' } },
  'base-lean': { meshes: slope, user: { supports: 'normal' } },
  'base-tree': { meshes: tee, user: { supports: 'tree' } },
  'base-cyl': { meshes: cyl, user: {} },
  'base-cyls': { meshes: cyls, user: {} },
  'base-stack': { meshes: stack, user: {}, colours: true },
  'base-plaque': { meshes: plaque, user: {} },
  'base-plaque-odd': { meshes: plaqueOdd, user: {} },
};
const cases: Case[] = [];
const add = (name: string, base: string, extra: PrintSettings, scope: 'model' | 'part' = 'model') => {
  const b = bases[base];
  cases.push({ name, base, meshes: b.meshes(), user: scope === 'model' ? { ...b.user, ...extra } : { ...b.user, parts: { Lid: extra } }, colours: b.colours });
};
for (const [name, b] of Object.entries(bases)) cases.push({ name, base: name, meshes: b.meshes(), user: b.user, colours: b.colours });

// Model-wide: each new setting alone, on the model that shows it.
add('supportAngle', 'base-lean', { supportAngle: 60 });
add('supportGap', 'base-normal', { supportGap: 0.4 });
add('supportInterfaceLayers', 'base-normal', { supportInterfaceLayers: 4 });
add('supportStyle', 'base-normal', { supportStyle: 'snug' });
add('supportStyleTree', 'base-tree', { supportStyle: 'tree_strong' });
add('topOneWall', 'base', { topOneWall: 'off' });
add('infillDirection', 'base', { infillDirection: 0 });
add('wallGenerator', 'base', { wallGenerator: 'arachne' });
add('scarfSeam', 'base-cyl', { scarfSeam: 'external' });
add('scarf-model', 'base-cyl', { scarfSeam: 'external' });
cases.push({ name: 'scarf-model-all', base: 'scarf-model', meshes: cyl(), user: { scarfSeam: 'all' } }); // compared with 'external'
add('scarfSeamBox', 'base', { scarfSeam: 'external' });
add('scarfSeamAll', 'base-cyl', { scarfSeam: 'all' });
add('ironingSpeed', 'base-iron', { ironingSpeed: 60 });
add('ironingFlow', 'base-iron', { ironingFlow: 20 });
add('ironingSpacing', 'base-iron', { ironingSpacing: 0.25 });
add('holeCompensation', 'base-ring', { holeCompensation: 0.2 });
add('holeCompensationNeg', 'base-ring', { holeCompensation: -0.2 });
add('contourCompensation', 'base', { contourCompensation: 0.2 });
add('elephantFoot', 'base', { elephantFoot: 0.4 });
add('spiral', 'base-cyl', { spiralVase: true });
add('spiral-two-parts', 'base-cyls', { spiralVase: true });
add('spiral-two-colours', 'base-stack', { spiralVase: true });
// The top surface lines of a flat plaque (infill direction 45 is the baseline).
add('plaque-dir0', 'base-plaque', { infillDirection: 0 });
add('plaque-dir90', 'base-plaque', { infillDirection: 90 });
add('plaque-odd-dir0', 'base-plaque-odd', { infillDirection: 0 });
add('plaque-odd-dir90', 'base-plaque-odd', { infillDirection: 90 });
// Only on the part "Lid" of a two-part object.
add('part-topOneWall', 'base', { topOneWall: 'off' }, 'part');
add('part-infillDirection', 'base', { infillDirection: 0 }, 'part');
add('part-wallGenerator', 'base', { wallGenerator: 'arachne' }, 'part');
add('part-ironingSpeed', 'base-iron', { ironingSpeed: 60 }, 'part');
add('part-ironingFlow', 'base-iron', { ironingFlow: 20 }, 'part');
add('part-ironingSpacing', 'base-iron', { ironingSpacing: 0.25 }, 'part');
add('part-contourCompensation', 'base-ring', { contourCompensation: 0.2 }, 'part');
add('part-holeCompensation', 'base-ring', { holeCompensation: 0.2 }, 'part');
add('part-elephantFoot', 'base', { elephantFoot: 0.4 }, 'part');
// On the object "Lid" (a separate one-part object: its settings go on the object).
add('object-holeCompensation', 'base-apart', { holeCompensation: 0.2 }, 'part');
add('object-contourCompensation', 'base-apart', { contourCompensation: 0.2 }, 'part');
add('object-wallGenerator', 'base-apart', { wallGenerator: 'arachne' }, 'part');
add('object-topOneWall', 'base-apart', { topOneWall: 'off' }, 'part');
add('object-elephantFoot', 'base-apart', { elephantFoot: 0.4 }, 'part');

const [out, tplPath] = process.argv.slice(2);
if (!out || !tplPath) { console.error('usage: slice-check.ts <out-dir> <template.json>'); process.exit(2); }
const tpl = JSON.parse(readFileSync(tplPath, 'utf8')) as BambuTemplate;
mkdirSync(out, { recursive: true });
for (const c of cases) {
  const blob = toBambuProject(c.meshes, c.name, tpl, { oneColour: c.colours ? null : COLOUR, print: { ai: {}, user: c.user } });
  writeFileSync(path.join(out, `${c.name}.3mf`), Buffer.from(await blob.arrayBuffer()));
}
writeFileSync(path.join(out, 'cases.txt'), cases.map((c) => `${c.name} ${c.base}`).join('\n') + '\n');
console.log(`${cases.length} projects in ${out}`);
