# Printer Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick their Bambu Lab printer (any model and nozzle Bambu Studio knows, plus their own Bambu Studio presets) and how many filaments it loads, and make everything that assumes the A1 0.4 follow that choice.

**Architecture:** `shared/printer.ts` becomes the printer model plus a "current printer" holder (`printer()` / `setPrinter()`), set on the server from `data/printer.json` and on the client from `GET /api/printer`, and passed into both geometry workers with every job. The server scans Bambu Studio's BBL machine presets (and the user's own presets) into a printer list; the Bambu Studio template is built and cached per printer. All code that read the `PRINTER` constant or hard-coded 256 / 250 / 4 / "A1" reads `printer()` instead.

**Tech Stack:** TypeScript, React, Express, Node 26, `node --test` with tsx, Bambu Studio CLI.

**Spec:** `docs/superpowers/specs/2026-11-01-printer-choice-design.md`

## Global Constraints

- Bambu Lab printers only. Only BBL system profiles are scanned; user presets count only when their `inherits` chain reaches a BBL machine preset.
- Never write to, move or change anything in the user's Bambu Studio folders. Read only.
- Default (no saved setting): printer id `Bambu Lab A1 0.4 nozzle`, filaments 4. An existing install (designs in `data/designs` or `data/bambu/template.json` present) gets the default saved silently and no first-start question.
- A1 0.4 users see no change: name "Bambu Lab A1", presets "Bambu Lab A1 0.4 nozzle" / "0.20mm Standard @BBL A1" / "Bambu PLA Basic @BBL A1", same prompt text, same layer heights.
- Display name: model name when the nozzle is 0.4, else `<model> (<nozzle> nozzle)`, e.g. "Bambu Lab A1 (0.2 nozzle)". Custom presets show their saved name.
- Filament count: integer 1 to 16, default 4. It is the "prints by itself" limit. Coloured meshes keep a hard max of 4 (`MAX_MESH_COLORS`) and use min(count, 4). LayerTone hard max = max(8, count). Saved designs are never trimmed when the count drops; only warnings change.
- Layer heights per nozzle (from Bambu Studio 2.8 process presets): 0.2 → 0.06, 0.08, 0.10, 0.12, 0.14; 0.4 → 0.08, 0.12, 0.16, 0.20, 0.24, 0.28; 0.6 → 0.18, 0.24, 0.30, 0.36, 0.42; 0.8 → 0.24, 0.32, 0.40, 0.48, 0.56. Any other nozzle uses the nearest of these four.
- Bed-slinger text and the wobble warning only when `printer_structure` is "i3".
- `litho/` shop widget is out of scope (only its "A1" comment is reworded).
- No en dash or em dash characters in any new text (code, comments, UI, prompts, commits); plain hyphen or rephrase.
- User-facing text says "Jig", never "Claude".
- Commits: conventional `feat(scope): …`, no Co-Authored-By line. Do not push; do not bump the version (that happens at push time).
- Edits only while no generation is running in the user's Jig (check before restarting anything); rebuild Docker Jig with `npm run rebuild`.
- Tests stay light: unit tests with `node --test`; no new headless-browser tests. Final UI check is manual in the browser.

## Review Focus

1. **Printer switched while a design is open:** plate, fit error, "Fits …" row, wall checks and the Cost tab result must all update without a reload; a cost result from the old printer must show as out of date (cost key includes the printer id). Test in Task 5.
2. **Model scripts in workers use the stale default printer:** line art split and `H.lineart` "bigger than the bed" text run in the client web worker and the server geometry process; both must use the chosen bed. Test in Task 5 (job payload carries the printer).
3. **A user preset that inherits a preset missing from the install** (made in a newer Bambu Studio, or a non-BBL parent): skipped, no crash, the rest of the list still loads. Test in Task 2.
4. **Bambu Studio not installed / AppImage extract fails:** `GET /api/printer` still answers with the built-in list and the saved or default printer. Test in Task 3.
5. **Saved printer id no longer in the list** (preset deleted in Bambu Studio, Bambu Studio uninstalled): fall back to the default printer for this run without overwriting the saved choice, and say so in the Print tab. Test in Task 3.

---

## File Structure

- `shared/printer.ts` (modify): `Printer`, `ActivePrinter`, `PrinterSetup` types, `DEFAULT_PRINTER`, `BUILTIN_PRINTERS`, `printer()`/`setPrinter()`, `printerName()`, `isBedSlinger()`, `layerHeights()`, `maxPiece()`, `fitProblem`/`bedShift` with an optional printer argument. Remove the `PRINTER` constant.
- `server/printers.ts` (create): scan Bambu Studio presets into `Printer[]`, find the user preset folders, cache the list per Bambu Studio version.
- `server/printerSetting.ts` (create): read/write `data/printer.json`, first-start detection, resolve the active printer, call `setPrinter` on the server.
- `server/routes/printer.ts` (create): `GET /api/printer`, `PUT /api/printer`.
- `server/bambu.ts` (modify): export `profilesDir`; `bambuTemplate(p)` / `cachedPrintDefaults(p)` per printer; resolve user presets.
- `src/components/PrinterPicker.tsx` (create): the printer + filament count form, used by the first-start dialog and the Print tab.
- Everything listed in the spec's "What exists today" (modify): read `printer()`.

---

### Task 1: Printer model and current-printer holder

**Files:**
- Modify: `shared/printer.ts`
- Modify: `shared/print.ts` (layer heights from the nozzle)
- Test: `test/printer.test.ts` (create), `test/print.test.ts` (update the `PRINTER` test)

**Interfaces:**
- Produces:
  - `type Structure = 'bedslinger' | 'corexy'`
  - `interface Printer { id: string; name: string; model: string; nozzle: number; bed: [number, number]; origin: [number, number]; height: number; structure: Structure; presets: { machine: string; process: string; filament: string } | null; custom: boolean }` (`id` = machine preset name; `presets` null for built-in fallback entries; `origin` = printable area's min corner)
  - `interface PrinterSetup { printerId: string; filaments: number }`
  - `interface ActivePrinter extends Printer { filaments: number }`
  - `const DEFAULT_PRINTER: ActivePrinter` (A1 0.4: bed [256, 256], origin [0, 0], height 256, bedslinger, presets as in Global Constraints, filaments 4)
  - `const BUILTIN_PRINTERS: Printer[]`: A1 (256×256×256, bedslinger), A1 mini (180×180×180, bedslinger), P1S (256×256×250, corexy), X1 Carbon (256×256×250, corexy), H2D (350×320×325, corexy), all 0.4 nozzle, `presets: null`, `custom: false`, ids `Bambu Lab <model> 0.4 nozzle`
  - `printer(): ActivePrinter`, `setPrinter(p: ActivePrinter): void`
  - `printerName(model: string, nozzle: number): string`
  - `isBedSlinger(p?: Printer): boolean`
  - `layerHeights(nozzle: number): number[]`
  - `maxPiece(p?: Printer): number` = min(bed) - 6 (A1: 250)
  - `fitProblem(b: Box3 | null, p?: Printer)`, `bedShift(boxes: Box3[], p?: Printer)` (default `printer()`); `bedShift` centres on `origin + bed / 2`
  - `clampFilaments(n: unknown): number` (integer 1 to 16, default 4)

- [ ] **Step 1: Write the failing tests** in `test/printer.test.ts`:

```ts
test('printerName shows the nozzle only when it is not 0.4', () => {
  assert.equal(printerName('Bambu Lab A1', 0.4), 'Bambu Lab A1');
  assert.equal(printerName('Bambu Lab A1', 0.2), 'Bambu Lab A1 (0.2 nozzle)');
});
test('layerHeights follow the nozzle', () => {
  assert.deepEqual(layerHeights(0.4), [0.08, 0.12, 0.16, 0.2, 0.24, 0.28]);
  assert.deepEqual(layerHeights(0.2), [0.06, 0.08, 0.1, 0.12, 0.14]);
  assert.deepEqual(layerHeights(0.8), [0.24, 0.32, 0.4, 0.48, 0.56]);
  assert.deepEqual(layerHeights(0.5), layerHeights(0.4)); // nearest
});
test('setPrinter changes fitProblem, bedShift and maxPiece', () => {
  const mini = { ...DEFAULT_PRINTER, id: 'Bambu Lab A1 mini 0.4 nozzle', name: 'Bambu Lab A1 mini', bed: [180, 180] as [number, number], height: 180 };
  setPrinter(mini);
  try {
    assert.match(fitProblem({ min: [0, 0, 0], max: [200, 10, 10] })!, /A1 mini/);
    assert.equal(maxPiece(), 174);
    assert.deepEqual(bedShift([{ min: [0, 0, 0], max: [10, 10, 10] }]), [85, 85, 0]);
  } finally { setPrinter(DEFAULT_PRINTER); }
});
test('the default is the A1 0.4 with 4 filaments', () => {
  assert.equal(printer().name, 'Bambu Lab A1');
  assert.equal(maxPiece(), 250);
  assert.equal(printer().filaments, 4);
});
test('clampFilaments', () => {
  assert.equal(clampFilaments(0), 1); assert.equal(clampFilaments(40), 16); assert.equal(clampFilaments('x'), 4); assert.equal(clampFilaments(2.6), 3);
});
test('cleanSettings snaps layer height to the current nozzle', () => {
  setPrinter({ ...DEFAULT_PRINTER, nozzle: 0.2 });
  try { assert.equal(cleanSettings({ layerHeight: 0.2 }).layerHeight, 0.14); } finally { setPrinter(DEFAULT_PRINTER); }
});
```

In `test/print.test.ts`, change the `fitProblem and bedShift follow PRINTER` test to use `printer()` instead of `PRINTER`.

- [ ] **Step 2: Run** `npm test -- test/printer.test.ts test/print.test.ts`. Expected: FAIL (exports missing).

- [ ] **Step 3: Implement** the interfaces above in `shared/printer.ts`. In `shared/print.ts`, `cleanSettings` snaps `layerHeight` and `firstLayerHeight` to `layerHeights(printer().nozzle)`; delete `LAYER_HEIGHTS` and make its users (`src/components/PrintPanel.tsx`'s layer height choices) read `layerHeights(printer().nozzle)`. Tests that set `JIG_DATA` must set it before importing server modules (`DATA_DIR` is read at import). Remove the `PRINTER` export and fix every import the compiler reports by switching to `printer()` (mechanical replacement only; behaviour changes come in Tasks 6 and 7).

- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: all pass, no type errors.

- [ ] **Step 5: Commit** `feat(printer): printer model and current-printer holder`

---

### Task 2: Scan Bambu Studio printer presets

**Files:**
- Create: `server/printers.ts`
- Modify: `server/bambu.ts` (export `profilesDir`; export a `resolvePreset` that searches several dirs)
- Create: `test/fixtures/bambu-profiles/` (a tiny BBL tree: `machine/fdm_machine_common.json`, `machine/Bambu Lab A1 0.4 nozzle.json` with `inherits` to a common base, `machine/Bambu Lab A1 0.2 nozzle.json` inheriting the 0.4, `machine/Bambu Lab P1S 0.4 nozzle.json`, `machine/Bambu Lab A1.json` (model file, no nozzle), a `... template ... gcode.json` file; `user/default/machine/My A1.json` inheriting `Bambu Lab A1 0.4 nozzle` with `printable_height: "250"`; `user/default/machine/Ender.json` inheriting `Creality Ender-3 0.4 nozzle` (missing))
- Test: `test/printers.test.ts`

**Interfaces:**
- Consumes: `Printer`, `printerName`, `BUILTIN_PRINTERS` (Task 1)
- Produces:
  - `scanPrinters(systemDir: string, userDirs: string[]): Promise<Printer[]>`: built-in BBL presets first (sorted by model, then nozzle), then user presets (sorted by name)
  - `bambuUserDirs(): string[]`: `BAMBU_STUDIO_USER_DIR` if set, else every `<config>/user/*/machine` that exists (`<config>` = `~/.config/BambuStudio` on Linux, `%APPDATA%\BambuStudio` on Windows, `~/Library/Application Support/BambuStudio` on macOS)
  - `listPrinters(): Promise<Printer[]>`: scans once per `bambuVersion()` (extract the AppImage once, as `profilesDir` does), returns `BUILTIN_PRINTERS` when Bambu Studio is missing or the scan throws
  - `resolvePreset(dirs: string[], kind: string, name: string): Promise<Record<string, unknown>>` (first dir that has `<kind>/<name>.json`, `inherits` resolved across all dirs)

A machine preset is a printer when, after resolving, it has `nozzle_diameter`, `printer_model` and `printable_area`. Fields: `bed` and `origin` from the bounding box of `printable_area` ("XxY" strings), `height` from `printable_height`, `structure` "bedslinger" for "i3" else "corexy", `presets.process` = `default_print_profile`, `presets.filament` = first of `default_filament_profile`. A user preset is kept only if its chain reaches a file in the system dir whose name starts with "Bambu Lab "; `custom: true`, `name` = its own `name` field or file name.

- [ ] **Step 1: Write the failing tests:**

```ts
test('scanPrinters lists BBL nozzle presets and BBL-based user presets', async () => {
  const list = await scanPrinters(FIX, [path.join(FIX, 'user/default/machine')]);
  assert.deepEqual(list.map((p) => p.name), ['Bambu Lab A1 (0.2 nozzle)', 'Bambu Lab A1', 'Bambu Lab P1S', 'My A1']);
  const a1 = list.find((p) => p.id === 'Bambu Lab A1 0.4 nozzle')!;
  assert.deepEqual({ bed: a1.bed, height: a1.height, structure: a1.structure, presets: a1.presets },
    { bed: [256, 256], height: 256, structure: 'bedslinger', presets: { machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filament: 'Bambu PLA Basic @BBL A1' } });
  const mine = list.find((p) => p.name === 'My A1')!;
  assert.equal(mine.custom, true); assert.equal(mine.height, 250);
});
test('a user preset whose parent is missing is skipped, not fatal', async () => {
  const list = await scanPrinters(FIX, [path.join(FIX, 'user/default/machine')]);
  assert.ok(!list.some((p) => p.name === 'Ender'));
});
test('scanPrinters with a missing user dir still lists the built-in presets', async () => {
  assert.equal((await scanPrinters(FIX, ['/nonexistent'])).length, 3);
});
```

- [ ] **Step 2: Run** `npm test -- test/printers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `server/printers.ts` and the `server/bambu.ts` exports. `bambuTemplate` keeps working unchanged in this task.
- [ ] **Step 4: Run** `npm test -- test/printers.test.ts` and `npm run typecheck`. Expected: PASS. Then run once against the real install: `node --import tsx -e "import('./server/printers.ts').then(async m => console.log((await m.listPrinters()).map(p => p.name).join('\n')))"`. Expected: 56 Bambu printers (14 models × 4 nozzles), A1 0.4 shown as "Bambu Lab A1".
- [ ] **Step 5: Commit** `feat(printer): read Bambu printers and user presets from Bambu Studio`

---

### Task 3: Saved printer setting and API

**Files:**
- Create: `server/printerSetting.ts`, `server/routes/printer.ts`
- Modify: `server/app.ts` (register routes; call `loadPrinterSetting()` at startup), `shared/api.ts` (types), `src/lib/api.ts` (client calls), `server/routes/backup.ts` (`printer.json` in `BACKUP_SETTINGS`)
- Test: `test/printerSetting.test.ts`

**Interfaces:**
- Consumes: `listPrinters` (Task 2), `setPrinter`, `DEFAULT_PRINTER`, `clampFilaments` (Task 1)
- Produces:
  - `PRINTER_FILE = path.join(DATA_DIR, 'printer.json')` holding `PrinterSetup`
  - `activePrinter(setup: PrinterSetup | null, list: Printer[]): { printer: ActivePrinter; missing: boolean }` (pure: unknown id → `DEFAULT_PRINTER` with the saved filament count, `missing: true`; null setup → `DEFAULT_PRINTER`)
  - `loadPrinterSetting(): Promise<PrinterInfo>`: reads the file; if absent and the install is existing (any file in `data/designs` or `data/bambu/template.json` exists), writes the default setup; resolves and calls `setPrinter`
  - `savePrinterSetting(setup: PrinterSetup): Promise<PrinterInfo>` (400 on unknown id at the route)
  - In `shared/api.ts`: `interface PrinterInfo { printer: ActivePrinter; printers: Printer[]; firstStart: boolean; missing: boolean }` (`firstStart` = no saved setting)
  - Routes: `GET /api/printer` → `PrinterInfo`; `PUT /api/printer` body `PrinterSetup` → `PrinterInfo`
  - Client: `api.printer(): Promise<PrinterInfo>`, `api.setPrinter(s: PrinterSetup): Promise<PrinterInfo>`

- [ ] **Step 1: Write the failing tests** (pure function plus the file logic against a temp `JIG_DATA`):

```ts
test('activePrinter: saved id found', () => {
  const r = activePrinter({ printerId: 'Bambu Lab P1S 0.4 nozzle', filaments: 8 }, LIST);
  assert.equal(r.printer.name, 'Bambu Lab P1S'); assert.equal(r.printer.filaments, 8); assert.equal(r.missing, false);
});
test('activePrinter: unknown id falls back to the A1 and keeps the count', () => {
  const r = activePrinter({ printerId: 'Gone', filaments: 1 }, LIST);
  assert.equal(r.printer.id, DEFAULT_PRINTER.id); assert.equal(r.printer.filaments, 1); assert.equal(r.missing, true);
});
test('loadPrinterSetting: a fresh install is a first start, an existing one is not', async () => { /* temp DATA_DIR: empty → firstStart true and no file written; with data/designs/x.json → firstStart false and printer.json written with the default */ });
test('loadPrinterSetting works without Bambu Studio', async () => { /* BAMBU_STUDIO_PATH pointing nowhere → printers === BUILTIN_PRINTERS, printer is the default */ });
test('savePrinterSetting does not overwrite a missing saved id on load', async () => { /* write { printerId: 'Gone' } → load → file unchanged, missing true */ });
```

- [ ] **Step 2: Run** `npm test -- test/printerSetting.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow the `data/cost.json` pattern in `server/routes/cost.ts` (mkdir, JSON write). The server holds the current printer via `setPrinter` after load and after each PUT.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(printer): saved printer setting and /api/printer`

---

### Task 4: Bambu Studio template per printer

**Files:**
- Modify: `server/bambu.ts`, `server/routes/system.ts` (`printDefaults` and `/api/bambu/template` use `printer()`), `server/agent.ts` (`cachedPrintDefaults(printer())`)
- Test: `test/bambuTemplate.test.ts` (create)

**Interfaces:**
- Consumes: `printer()`, `Printer` (Task 1); `resolvePreset(dirs, …)`, `bambuUserDirs()` (Task 2)
- Produces:
  - `templateFile(p: Printer): string` = `data/bambu/templates/<slug>.json`, slug = id lowercased, non `[a-z0-9]` runs → `-`
  - `bambuTemplate(p: Printer = printer()): Promise<BambuTemplate>` (one pending build per printer id; presets from `p.presets`; user presets resolved with `[...bambuUserDirs(), systemDir]`; rejects with "Pick a Bambu Studio printer: <name> has no Bambu Studio presets" when `p.presets` is null)
  - `cachedPrintDefaults(p: Printer = printer()): Promise<Required<PrintSettings> | null>`
  - Migration: when `templateFile(A1 0.4)` is missing and the old `data/bambu/template.json` exists, it is read as the A1 0.4 entry (moved into place on first read).

- [ ] **Step 1: Write the failing tests** (no Bambu Studio run):

```ts
test('templateFile is per printer', () => {
  assert.match(templateFile(DEFAULT_PRINTER), /templates\/bambu-lab-a1-0-4-nozzle\.json$/);
});
test('the old single template becomes the A1 0.4 entry', async () => { /* temp DATA_DIR with bambu/template.json → cachedPrintDefaults(DEFAULT_PRINTER) returns its defaults; templates/bambu-lab-a1-0-4-nozzle.json now exists */ });
test('another printer has no cached defaults until built', async () => { /* same temp dir → cachedPrintDefaults(P1S) === null */ });
```

- [ ] **Step 2: Run** `npm test -- test/bambuTemplate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS. Then with the dev server (not the Docker one) build two templates for real: `curl -X PUT localhost:8787/api/printer -H 'content-type: application/json' -d '{"printerId":"Bambu Lab A1 0.2 nozzle","filaments":4}'` then `curl -X POST localhost:8787/api/bambu/template | head -c 300`. Expected: a template whose settings include `"nozzle_diameter":["0.2"]` and `"layer_height":"0.1"`. Repeat for `Bambu Lab H2D 0.4 nozzle`; if it fails to build or slice, record that in the spec's dual-nozzle note and make the Print tab say the 3MF project isn't supported yet for that printer (done in Task 8). Put the setting back to the A1 0.4 afterwards.
- [ ] **Step 5: Commit** `feat(bambu): build and cache the Bambu Studio template per printer`

---

### Task 5: Client and workers follow the chosen printer

**Files:**
- Modify: `src/App.tsx` (load `api.printer()` on start, `setPrinter`, keep it in state so the tree re-renders; reload `printBase` from `api.capabilities()` after a change), `src/geometry/client.ts` + `src/geometry/worker.ts` (every job carries `printer: ActivePrinter`; the worker calls `setPrinter` before running it), `server/geometry.ts` + `server/geometry-worker.ts` (same, with the server's `printer()`), `src/viewer/stage.ts` (`buildPlate(group, p: Printer)`; the viewer rebuilds the plate when `printer.id` changes), `shared/cost.ts` (`costKey(..., printerId: string)`), `src/hooks/useCost.ts`, `src/hooks/useSizes.ts` if it calls `costKey`
- Test: `test/cost.test.ts` (add), `test/printer.test.ts` (add)

**Interfaces:**
- Consumes: `PrinterInfo`, `api.printer`, `api.setPrinter` (Task 3); `printer`, `setPrinter`, `ActivePrinter` (Task 1)
- Produces: `costKey(code, values, hiddenParts, userPrint, oneColour, printerId: string): string`; worker job types gain `printer: ActivePrinter`; `App` exposes `printerInfo: PrinterInfo` and `onPrinter(s: PrinterSetup): Promise<void>` to `SidePanel` (used by Task 8)

- [ ] **Step 1: Write the failing tests:**

```ts
test('costKey changes with the printer', () => {
  assert.notEqual(costKey('c', {}, [], {}, null, 'Bambu Lab A1 0.4 nozzle'), costKey('c', {}, [], {}, null, 'Bambu Lab P1S 0.4 nozzle'));
});
test('a split line art uses the chosen bed', () => { /* setPrinter(mini); build a 300 mm wide H.lineart via the same helper test/lineart.test.ts uses with split auto → every piece ≤ maxPiece() (174); restore the default */ });
```

- [ ] **Step 2: Run** `npm test -- test/cost.test.ts test/printer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `shared/split.ts`: `MAX_PIECE` becomes `maxPiece()` at each use (`shared/lineart/build.ts`, `shared/lineart/pieces.ts`, `src/components/LineArtPanel.tsx`); `shared/lineart/build.ts` drops `BED = 256` for `printer().bed` and says "bigger than the <name>'s bed".
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(printer): the app, viewer, workers and cost follow the chosen printer`

---

### Task 6: Checks and AI instructions follow the printer

**Files:**
- Modify: `src/geometry/validate.ts` (wall limits from `printer().nozzle`; wobble warning only `isBedSlinger()`; names from `printer().name`), `shared/sizes.ts`, `server/geometry.ts` (`Print settings (differences from <process>…)`, split bed), `src/components/SidePanel.tsx`, `src/components/LineArtPanel.tsx` (drop the `replace(/^Bambu Lab /, '')` hack only if the result still reads well: "bigger than the A1 mini's bed"), `server/systemPrompt.ts`, `server/prompt/printing.ts`, `server/prompt/lineArt.ts`, `server/prompt/meshes.ts`, `server/prompt/layerTone.ts`, `server/prompt/lithophane.ts`, `server/pricing.ts`, comments in `shared/cost.ts`, `shared/lineart/depth.ts`, `src/components/CostPanel.tsx`, `litho/src/config.ts` (comment only), `shared/types.ts` (comment)
- Test: `test/systemPrompt.test.ts` (create), `test/print.test.ts` or the existing validate tests

**Interfaces:**
- Consumes: `printer()`, `isBedSlinger()`, `layerHeights()`, `maxPiece()` (Task 1); `printBase` as today
- Produces: prompt text rules:
  - Opening line: "The user's printer is a <name> (FDM <bed-slinger|CoreXY>, <nozzle> mm nozzle, PLA/PETG, build volume W × D × H mm)".
  - `printingRules`: profile name `printer().presets?.process ?? 'Bambu Studio default'`; layer height list from `layerHeights(nozzle)`; "Keep layerHeight at <base.layerHeight>" instead of the fixed 0.20; the bed-slinger bullet only when `isBedSlinger()`, otherwise: "The <name> is a CoreXY printer (the bed only moves in Z): tall, thin parts are steadier than on a bed-slinger, but still give them a flat contact area."
  - LayerTone / line art / lithophane sizes: `maxPiece()` instead of 250, `printer().bed` / `.height` instead of 256.
  - Filament change cost and prime tower wording: "about 1.6 min and 0.35 g of purge each (measured on an A1)".
  - Pricing: "Print time: … on the <name> (Bambu Studio estimate)".

- [ ] **Step 1: Write the failing tests:**

```ts
test('A1 prompt text is unchanged', () => {
  const p = buildSystemPrompt('w.js', false);
  assert.match(p, /The user's printer is a Bambu Lab A1 \(FDM bed-slinger, 0\.4 mm nozzle, PLA\/PETG, build volume 256 × 256 × 256 mm\)/);
  assert.match(p, /bed-slinger \(the bed moves in Y\)/);
  assert.match(p, /0\.08\/0\.12\/0\.16\/0\.20\/0\.24\/0\.28/);
});
test('a CoreXY printer gets no bed-slinger advice', () => {
  setPrinter({ ...DEFAULT_PRINTER, id: 'Bambu Lab P1S 0.4 nozzle', name: 'Bambu Lab P1S', height: 250, structure: 'corexy' });
  try {
    const p = buildSystemPrompt('w.js', false);
    assert.doesNotMatch(p, /bed-slinger \(the bed moves in Y\)/);
    assert.match(p, /256 × 256 × 250 mm/);
  } finally { setPrinter(DEFAULT_PRINTER); }
});
test('0.2 nozzle: layer heights and thin-wall limit follow it', () => { /* setPrinter nozzle 0.2 → prompt lists 0.06/0.08/0.10/0.12/0.14; validate a 0.3 mm wall → warning, not error */ });
test('wobble warning only on a bed-slinger', () => { /* tall 5×5×100 box: A1 → "Tall and narrow" warning; P1S → none */ });
```

The A1 test pins today's wording; capture the current strings by running the prompt once before changing it.

- [ ] **Step 2: Run** `npm test -- test/systemPrompt.test.ts`. Expected: FAIL on the CoreXY and 0.2 tests (the A1 one passes; it guards the refactor).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Then `git grep -n -E "\bA1\b|256|bed-slinger" -- server shared src` and check every remaining hit is either a line-art piece label, the "A1 poster" photo size, a printer-aware sentence, or an "(measured on an A1)" note. Expected: no other hits.
- [ ] **Step 5: Commit** `feat(printer): checks and AI instructions follow the chosen printer`

---

### Task 7: Filament count drives the colour limits

**Files:**
- Modify: `shared/meshColors.ts` (add `meshColorBudget(): number` = min(printer().filaments, MAX_MESH_COLORS)), `shared/modelWarnings.ts`, `shared/layertone.ts` (`maxLayerToneFilaments(): number` = max(8, printer().filaments), used where `MAX_LAYERTONE_FILAMENTS` caps input), `src/components/LayerTonePanel.tsx` (`AMS_SLOTS` → `printer().filaments`), `src/components/MeshColorsPanel.tsx` (default colours = `meshColorBudget()`), `server/tools/meshy.ts` (default and text use `meshColorBudget()`; the schema max stays `MAX_MESH_COLORS`), `server/tools/pictures.ts`, `server/prompt/artwork.ts`, `server/prompt/layerTone.ts`, `server/prompt/meshes.ts`, `shared/lineart/build.ts` (AMS wording)
- Test: `test/meshColors.test.ts`, `test/layertone.test.ts` (add)

**Interfaces:**
- Consumes: `printer()` (Task 1)
- Produces: `meshColorBudget()`, `maxLayerToneFilaments()`; warning text when a design needs more filaments than the count: "The design needs N filaments, but the <name> loads <count> at once: the rest are swapped by hand during the print." At count 1 every colour feature stays available with this warning.
- AI wording: "The user's printer loads <count> filament(s) at once (AMS)" replacing every "the A1's AMS lite holds 4"; at 1: "The user's printer has no AMS: every extra colour is a manual filament swap, so use colour only when the user asks for it."

- [ ] **Step 1: Write the failing tests:**

```ts
test('mesh colour budget is min(count, 4)', () => {
  for (const [n, want] of [[1, 1], [4, 4], [16, 4]]) { setPrinter({ ...DEFAULT_PRINTER, filaments: n }); assert.equal(meshColorBudget(), want); }
  setPrinter(DEFAULT_PRINTER);
});
test('a lower count warns but never trims a saved palette', () => {
  setPrinter({ ...DEFAULT_PRINTER, filaments: 2 });
  try {
    assert.equal(cleanPalette(FOUR_COLOUR_PALETTE).length, 4);
    assert.match(modelWarnings(FOUR_COLOUR_DESIGN).join('\n'), /loads 2 at once/);
  } finally { setPrinter(DEFAULT_PRINTER); }
});
test('LayerTone accepts up to max(8, count) filaments', () => {
  setPrinter({ ...DEFAULT_PRINTER, filaments: 12 });
  try { assert.equal(parseLayerToneFilaments(TWELVE).length, 12); } finally { setPrinter(DEFAULT_PRINTER); }
  assert.equal(parseLayerToneFilaments(TWELVE).length, 8);
});
```

Use the existing helpers and fixtures in `test/meshColors.test.ts` and `test/layertone.test.ts` for the palette, design and filament list; name the real functions there (the names above are the intent).

- [ ] **Step 2: Run** `npm test -- test/meshColors.test.ts test/layertone.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(printer): the filament count sets the colour limits`

---

### Task 8: First-start question and Print tab printer control

**Files:**
- Create: `src/components/PrinterPicker.tsx`
- Modify: `src/App.tsx` (first-start dialog when `printerInfo.firstStart`), `src/components/SidePanel.tsx`, `src/components/PrintPanel.tsx` (current printer line with "Change"), the stylesheet the Print tab uses
- Test: manual (light-tests rule)

**Interfaces:**
- Consumes: `PrinterInfo`, `PrinterSetup` (Task 3); `onPrinter` from `App` (Task 5)
- Produces: `PrinterPicker({ info, onSave, onCancel? }: { info: PrinterInfo; onSave: (s: PrinterSetup) => void; onCancel?: () => void })`

Behaviour:
- A printer list (select or searchable list) grouped "Bambu Lab" (by model, nozzle sizes together) and "Your Bambu Studio presets". Below it "Filaments it loads at once" (1 to 16, default 4, hint "4 = one AMS or AMS lite, 1 = no AMS").
- First start: a dialog in Jig's existing dialog style (see `RestoreDialog.tsx`), title "Which printer do you have?", the A1 0.4 preselected, one "Save" button; no cancel.
- Print tab: "Printer: <name> · <count> filaments · Change". With `missing` true: "Your saved printer wasn't found in Bambu Studio; using the Bambu Lab A1 until you pick another."
- When the chosen printer has no template yet, the existing "builds the Bambu Studio template" path runs on the next export or cost, as today. When `presets` is null (no Bambu Studio), the existing "Needs Bambu Studio installed" note covers it. A printer recorded in Task 4 as not building gets "The Bambu Studio project isn't supported for this printer yet."
- Docker note in the picker when the user list is empty and Jig runs in Docker: "Your own Bambu Studio printers show here once the Bambu Studio user folder is mounted (see docker-compose.yml)." Detect Docker with whatever `/api/capabilities` already exposes; if nothing does, skip the note.

- [ ] **Step 1: Implement** the component and wiring.
- [ ] **Step 2: Run** `npm run typecheck` and `npm test`. Expected: PASS.
- [ ] **Step 3: Manual check** with `npm run dev` and a fresh `JIG_DATA` temp dir: the first-start dialog shows; pick "Bambu Lab A1 mini", 4 → plate label "Bambu Lab A1 mini · 180 × 180 mm plate", a 200 mm box shows "Too big for the Bambu Lab A1 mini". Change to "Bambu Lab P1S" in the Print tab → plate 256 × 256, the tall-and-narrow warning disappears for a 5×5×100 box. With an existing `data/` (copy of the real one): no dialog, A1 shown. Close the browser after.
- [ ] **Step 4: Commit** `feat(ui): ask for the printer on first start, change it in the Print tab`

---

### Task 9: Docker, docs, final verification

**Files:**
- Modify: `docker-compose.yml` (commented read-only mount under the fonts line: `# - ~/.config/BambuStudio/user:/bambu-user:ro` plus `BAMBU_STUDIO_USER_DIR=/bambu-user` in `environment`, commented), `.env.sample` (`# BAMBU_STUDIO_USER_DIR=`, one line on what it's for), `README.md` (printer choice in a sentence or two: any Bambu printer and nozzle, your own Bambu Studio presets show up), `docs/superpowers/specs/2026-11-01-printer-choice-design.md` (status: implemented; dual-nozzle findings from Task 4)

- [ ] **Step 1: Edit the files.**
- [ ] **Step 2: Run** `npm run typecheck && npm test && npm run build`. Expected: all pass.
- [ ] **Step 3: Check** `git diff main --stat` touches no file under `~/.config/BambuStudio` and `git grep -nP "[\x{2013}\x{2014}]" $(git diff --name-only main)` shows no new en/em dashes in added lines (`git diff main | grep -P "^\+.*[\x{2013}\x{2014}]"` is empty).
- [ ] **Step 4: Confirm no generation is running in Docker Jig, then** `npm run rebuild`. Expected: Jig on :8000 starts, shows the A1 with no first-start dialog (existing data).
- [ ] **Step 5: Commit** `docs(printer): Docker mount for your own Bambu Studio printers`
