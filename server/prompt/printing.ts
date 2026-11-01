// The system prompt's print settings and 3D-printing design rules, for the user's printer and profile.
import { printer } from '../../shared/printer';
import { describeSetting, SETTING_LABELS, type PrintSettings } from '../../shared/print';

/** "layer 0.20 mm, 2 walls, …" for the baseline profile. */
function describeBase(b: Required<PrintSettings>): string {
  const d = <K extends keyof PrintSettings>(k: K) => describeSetting(k, b[k]).toLowerCase();
  return `layer ${b.layerHeight.toFixed(2)} mm, ${b.walls} walls, ${b.topLayers} top / ${b.bottomLayers} bottom layers, ${b.infill} % ${d('infillPattern')} infill, supports ${d('supports')}${b.supportsOnPlate ? ' (from the build plate only)' : ''}, brim ${d('brim')}, ironing ${d('ironing')}, seam ${d('seam')}, ${SETTING_LABELS.wallOrder.toLowerCase()} ${d('wallOrder')}, fuzzy skin ${d('fuzzySkin')}`;
}

export function printingRules(printBase: Required<PrintSettings>): string {
  return `# Print settings (optional, return them from build())
The user prints in PLA on the ${printer().name} with the "${printer().presets!.process}" profile from their Bambu Studio: ${describeBase(printBase)}. When a design genuinely needs something different, return it from build() as \`print\` – ONLY the settings that differ:
\`\`\`js
print: {
  infill: 30, infillPattern: 'gyroid',            // model-wide
  parts: { 'Lead screw': { walls: 4, infill: 100 }, 'Cradle': { supports: 'tree', brim: 5 } },
}
\`\`\`
- Keys: layerHeight (mm, model-wide only: 0.08/0.12/0.16/0.20/0.24/0.28), firstLayerHeight (mm, model-wide only; H.layertone sets 0.16), walls, topLayers, bottomLayers, infill (%), infillPattern ('grid', 'gyroid', 'cubic', 'adaptivecubic', 'honeycomb', '3dhoneycomb', 'triangles', 'crosshatch', 'lightning', 'zig-zag', 'line', 'concentric'), supports ('off' | 'normal' | 'tree'), brim ('auto' | 'none' | width in mm), ironing ('off' | 'top' | 'topmost' | 'solid'), seam ('aligned' | 'nearest' | 'back' | 'random'), supportsOnPlate (true | false; per object), wallOrder ('inner-outer' | 'outer-inner' | 'inner-outer-inner'), fuzzySkin ('none' | 'external' | 'all').
- ironing 'top' (or 'topmost' for only the very top) on parts with large flat top faces that are seen or touched (lids, plaques, signs, nameplates); it is slow and does nothing for curved tops.
- seam 'back' to hide the seam on the back of visible round parts (figurines, vases, knobs); keep 'aligned' on functional parts; avoid 'random' where surfaces must fit.
- supportsOnPlate true when supports are needed but must not stand on the model itself (they would scar a visible or mating surface, or fill a thread or a hole).
- wallOrder 'outer-inner' when outside dimensions must be exact (press fits, snap fits, parts that slide into something); keep the default where overhangs matter more.
- fuzzySkin 'external' for grip surfaces (handles, knobs, tool grips) only: it adds about 0.3 mm, so never on mating or sliding surfaces; prefer a separate part or no fuzzy skin when only some faces should be rough.
- Keep layerHeight at 0.20 unless there is a clear reason (fine detail on small figurines → 0.12–0.16, big chunky functional parts → 0.24–0.28) and say why.
- Typical reasons: load-bearing / thin functional parts (screws, pins, hooks, clips) → 3–4 walls and 40–100 % infill; overhangs that cannot be designed away → supports 'tree' on that part; tall/narrow or small-footprint parts → a 5–8 mm brim; decorative parts → leave the defaults.
- Do not return print settings just to restate the defaults. The user can turn them off when exporting.

# 3D-printing design rules
- Every part (in 'print' layout, all parts together) must fit the ${printer().name} build volume: ${printer().bed[0]} × ${printer().bed[1]} × ${printer().height} mm. Keep slider max values within it too. If the object is genuinely larger, split it into parts with alignment pins/dovetails and say so.
- The ${printer().name} is a bed-slinger (the bed moves in Y): tall, thin parts wobble – prefer a stable print orientation (or lying down) with a flat contact area; do not add a base just for adhesion (the user adds a brim in the slicer).
- Minimum wall ≈ 1.2 mm (prefer 1.6–3 mm for strength); minimum feature ≈ 0.8 mm; minimum hole ≈ 2 mm.
- Clearances: sliding fit 0.3–0.4 mm, snug/press fit 0.1–0.2 mm, threads 0.3 mm (H.thread default). Make clearance a parameter when parts mate.
- Avoid overhangs > 45° and unsupported bridges > 20 mm where possible; prefer chamfers (45°) over fillets on downward-facing edges; a flat bottom face is essential.
- Small chamfer/rounding on the bottom edge (0.4–1 mm) reduces elephant's foot.
- Design for printing WITHOUT supports: pick the print orientation that leaves no overhang steeper than 45°, put 45° chamfers or slopes under overhanging features, give horizontal holes over ~6 mm a teardrop or diamond top, and split a part into pieces that pin, slide or glue together rather than one that needs supports. Use supports only when no design change avoids them, and say why.
- Strength follows the layers: a print is weakest across its layer lines (pulling layers apart in Z). Orient each functional part so its main loads run along the layers – hooks, clips, brackets, snap-fit arms and pins usually lying on their side, so a bending load doesn't split them between layers. When strength and support-free printing conflict for a functional part, choose strength, and mention the orientation and why in your message.
- Multi-part objects (printed as separate pieces that are put together afterwards – lids, hinge pins, knobs, mating halves, clips):
  - Return each part separately with a clear name ('Base', 'Lid', 'Hinge pin'…) and a distinct colour.
  - Add a select parameter \`layout\` with options ['print', 'assembled', 'exploded'] (default 'print'). 'print': every part in its best print orientation, flat on z = 0, side by side ≥ 5 mm apart. 'assembled': all parts in their final positions. 'exploded': the assembled arrangement with the parts pulled apart along the direction each one is inserted / mounted (≈ 20–40 % of the model size), so the picture alone shows how it goes together.
  - Render the assembled layout (render_model with values { layout: 'assembled' }) and check that mating parts really fit: pins in holes, lids on boxes, no gaps or collisions beyond the intended clearance.
  - build() must also return an assembly sequence (in every layout): assembly: [{ label: 'Insert the hinge pin', parts: ['Hinge pin'], from: [0, -40, 0] }, { label: 'Screw on the knob', parts: ['Knob'], from: [0, 0, 25], rotate: { axis: [0, 0, 1], degrees: 720 } }, …]. The app animates it on the assembled layout so the user can watch it being put together: each step's parts start at their assembled position + from (mm) and move into place, optionally turning by degrees around axis (through center, default the part's centre – for screws, knobs, bayonets). Parts in no step are the base and are already in place. Omit from to use the part's exploded-layout offset. Order the steps the way a person assembles it, one action per step, and make the labels match your numbered instructions.
  - Call submit_model with assembly: { layoutParam: 'layout', assembledValue: 'assembled', explodedValue: 'exploded' }. The app then shows the user an assembled and an exploded picture. Only if the parts are independent objects that never go together (e.g. a set of coasters) pass assembly: { independentParts: '<why>' } instead.
- Multi-colour single prints (coloured regions of ONE object printed together with the AMS – eyes, spots, a collar on a figurine, an inlaid logo): keep the coloured parts in place, touching/embedded in the main body, no layout parameter, and pass assembly: { singlePrint: true } – nothing needs assembling.
- Functional parts (corkscrews, hooks, clips) need strength: avoid thin necks, add fillets/gussets at stress points.`;
}
