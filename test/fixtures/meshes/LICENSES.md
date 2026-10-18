# Test meshes and their licences

Small models for the mesh import tests and the mock Meshy server (`server/meshyMock.ts`). Every one is CC0 (public domain dedication) or made from a CC0 model. The `.glb` files hold the geometry only: Jig's test-fixture script copied each model's positions and triangles into a plain GLB and left out textures, materials, normals and UVs (to keep them small). They stay Y-up and unit-less, like Meshy's models.

| File | What | Author | Licence | Source |
|---|---|---|---|---|
| `figurine.glb` | "character-female-a" from Mini Characters, geometry only | Kenney (www.kenney.nl) | CC0 1.0 ("License: Creative Commons CC0" on the pack's page; its `License.txt`: "License: (Creative Commons Zero, CC0)") | https://kenney.nl/assets/mini-characters |
| `fox.glb`, `fox.obj` | "animal-fox" from Cube Pets (the OBJ as distributed; it refers to a `.mtl` that isn't included) | Kenney | CC0 1.0 (the pack's `License.txt`) | https://kenney.nl/assets/cube-pets |
| `dog.glb` | "animal-dog" from Cube Pets, geometry only | Kenney | CC0 1.0 (the pack's `License.txt`) | https://kenney.nl/assets/cube-pets |
| `cat.glb` | Cat, geometry only (bind pose; the animations left out) | Quaternius | CC0 1.0 ("Public Domain (CC0)" on the model's page) | https://poly.pizza/m/2f54vbV0In |
| `fish.glb` | Fish, geometry only | Quaternius | CC0 1.0 ("Public Domain (CC0)" on the model's page) | https://poly.pizza/m/XWl86YFtpF |
| `pug.stl` | Pug, converted to a binary STL in millimetres (Z up, 60 mm long) | Quaternius | CC0 1.0 ("Public Domain (CC0)" on the model's page) | https://poly.pizza/m/1gXKv15ik8 |

Not every Quaternius model on poly.pizza is CC0 (some are CC-BY 3.0), so each one's own page was checked.

Made by Jig (CC0 as well):

| File | What |
|---|---|
| `colour-figure.glb` | A figure turned on a lathe, with UVs and an embedded 64 × 64 PNG base colour texture in four bands (hair, skin, shirt with two tiny buttons, trousers), made by `make-colour-figure.ts`; the mock serves it for textured (coloured) models |

Broken variants for the repair tests, made by Jig's fixture script from the models above (CC0 as well):

| File | Made from | What is wrong with it |
|---|---|---|
| `broken-holes.glb` | `cat.glb` | 6 % of the triangles missing (holes) and 15 % flipped; the mock serves it for prompts with `BROKEN` |
| `broken-holes.stl` | `pug.stl` | Three patches of triangles cut out |
| `broken-flipped.obj` | `dog.glb` | About two thirds of the triangles flipped (inconsistent winding, mostly inside out) |
| `broken-soup.stl` | `fish.glb` (ASCII STL, 70 mm) | Duplicate, degenerate and back-to-back triangles, and a vertex that is `nan` |
| `broken-nonmanifold.obj` | hand-made | Two cubes sharing only an edge, a third touching at a corner, and a dangling fin |
| `broken-shells.3mf` | `fox.glb` and a ball | Overlapping shells as separate objects, in centimetres, with component and build transforms |
| `open-sheet.stl` | hand-made | A single open, wavy sheet: nothing to make solid (the import refuses it) |
