// The system prompt's rules for the model script: conventions, its format and its parameters.

export const SCRIPT_RULES = `# Conventions
- Units: millimetres. Z is up. The build plate is the XY plane at z = 0.
- Every printable part must rest on z = 0 (min Z exactly 0) and be roughly centered on the XY origin, oriented in its best print orientation unless an "assembled" layout is chosen (see multi-part).
- Each part must be ONE connected solid unless intentionally separate parts. Sub-shapes you union must overlap by ≥ 0.05 mm; touching faces/edges do not fuse.
- When subtracting, make cutters extend ≥ 0.5 mm beyond the surfaces they cut (no coplanar faces).

# Script format
The file is plain JavaScript and runs in a sandbox (no imports, no async, no DOM, no Math.random, no Date; the sequences \`import(\`, \`eval(\`, \`<!--\` and \`-->\` are rejected, even in comments). A name that is used but never declared (e.g. a misspelled variable) is rejected before the script runs, with its line number. Globals available: \`Manifold\`, \`CrossSection\`, \`H\` (helpers), \`quality\` ('draft' | 'normal' | 'high'), \`console\`.

\`\`\`js
const meta = {
  name: 'Taper Candle Holder',
  description: 'Low dish with a tapered socket',
};

// Parameters → sliders/toggles in the UI. Keys are used as p.<key> in build().
const params = {
  candleD:   { label: 'Candle diameter', type: 'number', min: 6, max: 30, step: 0.1, value: 22, unit: 'mm', group: 'Candle' },
  clearance: { label: 'Clearance', type: 'number', min: 0.1, max: 1, step: 0.05, value: 0.3, unit: 'mm', group: 'Candle', description: 'Gap per side at the socket mouth' },
  dishD:     { label: 'Dish diameter', type: 'number', min: 40, max: 120, step: 1, value: 60, unit: 'mm', group: 'Dish', drives: 'x' },
  ribs:      { label: 'Grip ribs', type: 'integer', min: 0, max: 8, value: 4, group: 'Candle' },
  rim:       { label: 'Drip rim', type: 'boolean', value: true, group: 'Dish' },
  style:     { label: 'Dish style', type: 'select', options: ['round', 'hex'], value: 'round', group: 'Dish' },
};

function build(p) {
  // derive & clamp dependent values so EVERY slider combination produces valid geometry
  const socketD = p.candleD + 2 * p.clearance;
  const dishD = Math.max(p.dishD, socketD + 12);
  ...
  return {
    parts: [
      { name: 'Holder', shape: holder, color: '#c9a26b' },
    ],
    // 2–6 callouts of the most important feature dimensions (the app already shows the overall W×D×H).
    dimensions: [
      { label: 'Socket depth', from: [0, 0, top - socketDepth], to: [0, 0, top], offset: [dishD / 2 + 8, 0, 0] },
      { label: 'Socket', from: [-socketD / 2, 0, top], to: [socketD / 2, 0, top], param: 'candleD' },
    ],
  };
}
\`\`\`
- \`build(p)\` may also return just a Manifold, or an array of Manifolds / { name, shape, color } objects. Multi-part assemblies additionally return \`assembly: [...]\` (see multi-part rules).
- \`dimensions\`: from/to are [x, y, z] points on the actual geometry; offset (optional) shifts the drawn line away from the part for readability. The app measures and displays the length; label names it. Set \`param\` to the parameter key the callout represents – the user can double-click a callout and type a value, and the app adjusts that parameter until the callout measures exactly that.
- If the design holds a device or object (a phone stand, a holder), return \`loads: [{ name, mass, at: [x, y, z] }]\` so the app can check it will not tip. mass is in grams, \`at\` is the object's centre of mass in mm in the model frame. Compute \`at\` in build() from the parameters, so it moves with the sliders and poses: the held device's centre as it sits in the design, moved with the same rotate/translate as the part that holds it. Put the object's weight source in \`sources\` like any other fit-critical number.
- Top-level code runs on every evaluation; create geometry inside build().

# Parameters
- Expose 4–15 meaningful parameters: overall size(s), key functional dimensions (diameters, wall thickness, clearances/tolerances, counts, pitch, angles), and on/off features. Group them with \`group\`.
- When a parameter changes only one part (or a few) of a multi-part design, say so with part: 'Lid' (or parts: ['Lid', 'Hinge']), using the part names build() returns, so the app can grey it out while those parts are hidden.
- Defaults are YOUR best judgement of a realistic, well-proportioned, printable design (or the user's stated dimensions).
- Ranges must be sensible for the object AND produce valid geometry over the entire range, in every combination. Compute dependent dimensions inside build() and clamp them (e.g. inner radius ≤ outer radius − min wall). The stress test enforces this.
- Users can type the overall Width/Depth/Height directly. Mark the parameter that primarily sets the overall size along each axis with \`drives: 'x' | 'y' | 'z'\` (axes of the printed orientation) so that edit adjusts the right parameter.
- type 'integer' for counts; 'boolean' for optional features; 'select' with options for styles/variants; 'number' with unit 'mm' or '°'.
- When you submit, the app resets every slider to your new defaults. So when modifying an existing design, set each default to the user's current slider value (given in the request) unless the request asks to change it, and keep existing parameter keys stable.`;
