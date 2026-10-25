// The system prompt's reference for the script's globals: the manifold-3d API, Jig's helpers (H),
// performance and debugging tips.

export const GEOMETRY_API = `# Geometry API (manifold-3d). All objects are immutable; every method returns a new object. Never call delete().
Manifold (3D):
- Manifold.cube([x, y, z], center = false)  – corner at origin unless center
- Manifold.cylinder(height, radiusLow, radiusHigh = radiusLow, circularSegments = 0 (auto), center = false)  – along +Z from z = 0 (cone if radii differ; radiusHigh 0 gives a point)
- Manifold.sphere(radius, circularSegments = 0)
- Manifold.union([a, b, ...]) / Manifold.difference([a, b, ...]) / Manifold.intersection([...]); also a.add(b), a.subtract(b), a.intersect(b)
- Manifold.hull([manifolds or [x,y,z] points]) and m.hull()
- m.translate([x, y, z]), m.rotate([xDeg, yDeg, zDeg]) (applied X then Y then Z, about the origin), m.scale([sx, sy, sz] | s), m.mirror([nx, ny, nz]) (plane normal through origin)
- m.warp((v) => { v[0] = ...; v[1] = ...; v[2] = ... })  – deform vertices in place (refine first for smooth bends: m.refineToLength(1))
- m.trimByPlane([nx, ny, nz], offset) – keep the side the normal points to; m.splitByPlane(normal, offset) → [a, b]
- m.slice(z) → CrossSection; m.project() → CrossSection outline
- m.boundingBox() → { min: [x,y,z], max: [x,y,z] }; m.volume(); m.surfaceArea(); m.isEmpty(); m.decompose() → Manifold[]
- m.smoothOut(minSharpAngleDeg = 60, minSmoothness = 0).refine(n) – rounds a coarse mesh (use sparingly)
- Manifold.levelSet / minkowskiSum exist but are slow – avoid.
CrossSection (2D, XY plane):
- CrossSection.square([w, h], center = false), CrossSection.circle(r, segments = 0)
- new CrossSection([[x, y], ...]) or new CrossSection([outerPts, holePts, ...]) (polygons; overlapping regions are unioned, holes via opposite winding)
- cs.translate([x, y]), cs.rotate(deg), cs.scale([sx, sy]), cs.mirror([nx, ny])
- cs.offset(delta, 'Round' | 'Square' | 'Miter') – grow/shrink. 2D fillets: cs.offset(-r).offset(r, 'Round') rounds convex corners; cs.offset(r, 'Round').offset(-r, 'Round') rounds concave corners
- cs.add / subtract / intersect, CrossSection.union([...]), cs.hull(), CrossSection.hull([...])
- cs.extrude(height, nDivisions = 0, twistDegrees = 0, scaleTop = 1 | [sx, sy], center = false) → Manifold along +Z
- cs.revolve(segments = 0, degrees = 360) → Manifold. The 2D X axis becomes the radius and the 2D Y axis becomes Z. Profile must be at x ≥ 0.
- cs.bounds() → { min: [x, y], max: [x, y] }, cs.area()

# Helpers (H) – prefer these; they are fast and robust
- H.helicalSweep(profile, { pitch, turns, segmentsPerTurn?, startAngle?, z0?, leftHanded?, radiusFn?(t), scaleFn?(t) }) → Manifold. profile = closed polygon of [r, z] points in the radial half-plane (r > 0). Sweeps it around Z rising \`pitch\` per turn. t ∈ [0, 1] along the sweep: radiusFn adds a radial offset (e.g. taper a corkscrew tip), scaleFn scales the profile (e.g. sharpen the tip). Profile height must be < pitch. Ideal for springs, coils, corkscrews, worm gears.
  Example corkscrew wire: H.helicalSweep(H.circlePoints(wireD/2, 16).map(([x, y]) => [x + coilR, y]), { pitch, turns })
- H.thread({ diameter, pitch, length, external = true, clearance, leftHanded, chamfer = true }) → ISO 60° threaded rod from z = 0..length. external: false returns a cutter (with clearance, extends 0.5 mm past both ends) to subtract for a threaded hole. Use real metric sizes (M3×0.5, M4×0.7, M5×0.8, M6×1, M8×1.25, M10×1.5) or bottle caps (PCO-1881 ≈ 27.4 mm Ø, pitch 3.18). For printing, threads under M6 work poorly – prefer heat-set inserts or nut traps.
- H.radialSurface((thetaDeg, z) => r, { height, z0?, angularSegments?, zSegments? }) → solid around Z with radius as any function of angle & height: knurled grips, ribbed knobs, vases, bottle shapes, lofted round things. Must return r > 0.
- H.sweep(profile2d, path3d, { closed?, twist?, scaleFn?(t), up? }) → sweeps a closed 2D profile along a 3D polyline (rotation-minimising frames). Path curvature radius must exceed the profile size.
- H.tube(path3d, radius, { closed?, segments? }) → round pipe/wire along a path (handles, rings, hooks, wire forms).
- H.helixPath(radius, pitch, turns, segmentsPerTurn?, z0 = 0) → [x, y, z][] (use with H.tube for wire that needs a perpendicular cross-section).
- H.loft([{ z, points }, ...]) → solid through stacked closed 2D sections (point counts are resampled to match).
- H.roundedBox([x, y, z], radius, center = false), H.roundedRect(w, h, r) → centered CrossSection.
- H.polygon(points) → CrossSection; H.circlePoints(r, n?, phaseDeg?), H.ellipsePoints(rx, ry, n?), H.rectPoints(w, h), H.roundedRectPoints(w, h, r, segPerCorner?), H.resample(points, n)
- Text (fonts: 'Roboto Bold' (default), 'Roboto', 'Inter Bold', 'Montserrat Black', 'Oswald', 'Bebas Neue', 'Black Ops One', 'Allerta Stencil', 'Pacifico', 'Lobster', 'Roboto Mono Bold', or any font installed on the user's computer by family name, e.g. 'Bangers'):
  - H.text(str, { size = 8, font, letterSpacing = 0, lineHeight = 1.5, halign = 'center', valign = 'center', arcRadius }) → CrossSection in XY. size = capital-letter height in mm; '\\n' makes new lines; arcRadius bends the baseline along a circle (negative = the other way). Centered on the origin.
  - H.textSolid(str, { ...same, depth = 1 }) → text extruded from z = 0 up by depth.
  - Raised text: part.add(H.textSolid(...).translate([x, y, topZ - 0.3])) (sink 0.3 mm so it fuses). Engraved: part.subtract(H.textSolid(..., { depth: d + 0.5 }).translate([x, y, topZ - d])).
  - Standing text on a side face: .rotate([90, 0, 0]) turns XY text upright in the XZ plane, readable from the front (−Y), extruded toward −Y.
  - H.wrapAroundZ(shape, radius) bends a shape modelled flat (x = distance along the surface, z = height, −y = outward) onto a vertical cylinder around the Z axis, centered at the front (−Y). E.g. text on a mug.
  - Creative text is just geometry: cs.extrude(h, nDivisions, twistDegrees, scaleTop) for twisted/tapered letters, rotate/warp individual H.text calls, subtract text through a plate for stencils.
  - Expose user-facing text as a parameter with type 'text' (e.g. { label: 'Name', type: 'text', value: 'ANA' }) and a font choice as { type: 'text', font: true, value: 'Roboto Bold' } – the UI shows a text box / font picker.
  - Printability: letters ≥ 5 mm high (≥ 8 mm for script fonts), stroke ≥ 0.8 mm; raised 0.6–1.5 mm; engraved 0.6–1 mm deep. Text on the bottom face should be engraved and read correctly when viewed from below.
- H.svg(name, { height = 20, colors }) → CrossSection: an SVG drawing the user attached in the chat (listed by name in their message) or one made with generate_artwork, exactly as drawn, centred on the origin with y up, \`height\` mm high (the width keeps the proportions). \`colors\` picks the fill colours that form the shape (default: all but white-ish ones); colours painted on top of them cut through, as in the drawing – e.g. white lettering on a red disc: colors ['#f40009'] gives the disc with the lettering cut out, ['#ffffff'] only the lettering. Use it for logos, emblems, outlines and cut-outs: extrude it, subtract it, offset it for a border; never redraw an attached drawing by hand. Call it inside build().
- H.mesh(name, { height | width | depth | size | scale, rotate: [x, y, z], center = true }) → Manifold: a mesh the user attached (STL, OBJ, GLB, 3MF) or one made with generate_3d, already repaired into a watertight solid, Z up, standing on z = 0 and centred in X/Y, in mm. Give at most one of height (Z), width (X), depth (Y), size (longest side) or scale; rotate (degrees, applied first) fixes a model that lies on its side, then it is stood on the bed again (center: false keeps it where it is). See "Meshes" when there are any.
- H.polarArray(shape, count, totalDeg = 360) – copies rotated about Z, unioned; H.linearArray(shape, count, [dx, dy, dz])
- H.placeOnBed(shape, centerXY = true) – translate so min Z = 0 (and centered on XY)
- H.segments(radius) – the circle segment count for the current quality; H.clamp(v, lo, hi), H.lerp(a, b, t)
- Never name your own variables or parameters H, Manifold or CrossSection (e.g. a height \`H\`): that hides these and the script fails. Use height, h, totalH….

# Performance (sliders re-evaluate live)
- Target < 300 ms per evaluation at "normal" quality. Let circular segment counts default (they follow \`quality\`); never hardcode more than ~128 segments.
- Union many shapes in ONE Manifold.union([...]) call, not in a loop of .add().
- Build smooth organic shapes from revolve / loft / radialSurface / hull rather than thousands of booleans.

# Debugging tips
- Error messages include the model.js line number. console.log output is shown in evaluate_model results.
- "disconnected pieces" warning = shapes that should be joined do not overlap.
- A missing feature in the render usually means a wrong translate/rotate (remember rotate is about the origin) or a subtract that removed it.`;
