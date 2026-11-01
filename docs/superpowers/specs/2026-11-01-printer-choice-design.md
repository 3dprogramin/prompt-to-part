# Printer choice (Bambu Lab printers)

Date: 2026-11-01. Status: implemented on branch printer-choice.

## Why

Jig is built around one printer, the Bambu Lab A1 with a 0.4 mm nozzle. Its bed, nozzle, Bambu Studio
presets, AMS lite and "bed-slinger" behaviour are assumed throughout the app and the AI instructions.
Jig is going open source, and people with other printers need it to design for *their* printer: the
right plate, the right fit and wall checks, the right advice from the AI, and a print project and
cost estimate built from their printer's own presets. The owner also wants to switch nozzles on their
own A1 (for example a 0.2 nozzle for fine detail).

## Goals

- The user picks their printer once, on Jig's first start, and Jig remembers it.
- The Print tab shows the current printer and lets the user change it at any time. The choice holds
  until changed again.
- The printer list covers every Bambu Lab printer and nozzle that the user's Bambu Studio knows,
  plus the user's **own printer presets saved in Bambu Studio** ("set up your custom printer in
  Bambu Studio and Jig picks it up"). This is how people add a printer Jig doesn't list.
- The user also sets **how many filaments the printer can load at once** (default 4: one AMS or AMS
  lite; 1 means no AMS). Asked on first start next to the printer, changeable in the Print tab.
- Everything that today reads the A1 follows the chosen printer:
  - viewer plate size and label
  - fit check ("Too big for…", "Fits …" row), bed centring in both 3MF exporters
  - thin-wall limits (from the nozzle)
  - tall-and-narrow wobble warning (only for bed-slingers)
  - the AI's system prompt and mode prompts (printer name, build volume, nozzle, bed-slinger or
    CoreXY advice, filament count)
  - largest split piece / line-art bed / LayerTone and lithophane size advice (from the bed)
  - filament limits for coloured meshes, LayerTone, artwork and line art (from the filament count)
  - the Bambu Studio presets the project template and the cost slicing start from
  - the baseline print settings (from that printer's default process preset)
  - the layer heights offered (sensible for the nozzle)
- Switching printers back and forth is instant once each printer's template has been built.

## Non-goals

- Printers from other brands (Prusa, Creality, Voron…) and other slicers (OrcaSlicer, PrusaSlicer).
  Later, maybe; the design should not make them harder, but builds nothing for them now.
- A printer per design. One printer for the whole Jig install.
- Editing printer presets inside Jig. Custom printers are made in Bambu Studio.
- Choosing a different process or filament preset than the printer's defaults (Jig's own print
  settings still override on top, as today).
- Re-measuring the A1-measured numbers (prime tower size, filament change time and purge, the 1300 W
  power note) for every printer. They stay as estimates; only their "A1" wording is generalised.

## Anti-goals (would make this a failure even if it works)

- Jig writes to, moves or changes anything in the user's Bambu Studio folders. Read only, always.
- Bambu Lab files get bundled into Jig. Presets are read from the user's install (or the Bambu Studio
  in the Docker image), as today.
- An existing A1 user notices any difference after upgrading, other than the new printer choice.
  Existing installs with no saved printer default to "Bambu Lab A1 0.4 nozzle", 4 filaments, and the
  first-start question is not shown to them (decide how to detect an existing install: e.g. designs
  or a template cache already in `data/`).
- Jig stalls or breaks when Bambu Studio isn't installed. It falls back to a small built-in list.

## What exists today (where the A1 lives)

- `shared/printer.ts`: the `PRINTER` constant (name, bed 256×256, height 256, nozzle 0.4, the three
  Bambu Studio preset names) and `bedShift`, `plateBounds`, `fitProblem`. Imported by about 15 files,
  client and server, mostly synchronously (validation, viewer stage, 3MF export, prompts).
- `server/bambu.ts`: finds Bambu Studio, reads `resources/profiles/BBL/{machine,process,filament}`
  (from the AppImage or install dir), resolves `inherits`, builds a project template by running the
  Bambu Studio CLI on a cube, caches it in `data/bambu/template.json` (one printer only, keyed by
  Bambu Studio version).
- `server/slicer.ts`: slices a project for the Cost tab; the printer comes from the project itself.
- `shared/print.ts`: `A1_DEFAULTS` fallback baseline, `LAYER_HEIGHTS` (0.08 to 0.28), mapping of Jig
  settings to Bambu keys.
- `src/lib/bambu3mf.ts`: bed size already read from the template's `printable_area`; prime tower
  footprint measured on the A1.
- Written straight into the code instead of reading `PRINTER`:
  - bed: `shared/lineart/build.ts` (`BED = 256`), `shared/split.ts` (`MAX_PIECE = 250`),
    `server/prompt/layerTone.ts` (250 × 250), `server/prompt/lithophane.ts`, `litho/src/config.ts`
  - AMS lite / 4 filaments: `shared/meshColors.ts` (`MAX_MESH_COLORS`), `shared/layertone.ts`,
    `src/components/LayerTonePanel.tsx` (`AMS_SLOTS`), `shared/modelWarnings.ts`,
    `server/prompt/{artwork,layerTone,meshes}.ts`, `server/tools/{meshy,pictures}.ts`
  - "A1" in wording: `server/pricing.ts`, `shared/lineart/{build,depth}.ts`, `shared/cost.ts`,
    `src/components/CostPanel.tsx`, `server/prompt/lineArt.ts` (filament change cost)
  - Not printer related despite the name: line-art piece labels "A1, A2, B1" and the "A1 poster"
    photo scale reference. Leave them.
- Persistence pattern for install-wide settings: JSON files in `DATA_DIR` with GET/PUT routes (e.g.
  `data/cost.json` in `server/routes/cost.ts`, `/api/filaments/mine`). `/api/capabilities` delivers
  Bambu version and print defaults to the client on load.

## What Bambu Studio provides (checked on Bambu Studio 2.8 profiles)

- `profiles/BBL/machine/` has 14 Bambu printers, each with 0.2 / 0.4 / 0.6 / 0.8 nozzle presets:
  A1, A1 mini, A2L, P1P, P1S, P2S, X1, X1 Carbon, X1E, X2D, H2C, H2D, H2D Pro, H2S. Also non-printer
  files (`fdm_*` bases, "… template …gcode" snippets, a bare "Bambu Lab A1.json" model file) that must
  be filtered out: a selectable printer is a machine preset with a `nozzle_diameter`, a
  `printer_model` and (after resolving `inherits`) a `printable_area`.
- After resolving `inherits`, each nozzle preset gives: `printer_model`, `nozzle_diameter`,
  `printable_area`, `printable_height`, `printer_structure` ("i3" = bed-slinger, "corexy"),
  `default_print_profile` and `default_filament_profile` (e.g. A1 0.2: "0.10mm Standard @BBL A1 0.2
  nozzle", "Bambu PLA Basic @BBL A1 0.2 nozzle").
- The default filament preset is Bambu PLA Basic for that printer. Jig prints PLA, so use it.
- No field says how many filaments can be loaded (only `default_ams_type` on a few), hence the
  user setting.
- User presets live in the Bambu Studio config folder: `user/<account id or "default">/machine/*.json`
  (Linux: `~/.config/BambuStudio`; Windows `%APPDATA%\BambuStudio`; macOS
  `~/Library/Application Support/BambuStudio`). They `inherit` from a system preset, so resolving them
  needs the system profile directory as well. The same folder also holds `system/BBL/`, an updated
  copy of the system profiles, which may be newer than the install's `resources/`.

## Decided

- Bambu Lab printers only, read from Bambu Studio.
- First start asks for the printer and the filament count; the Print tab can change both later.
- One printer for the whole install, stored server side next to Jig's other settings in `data/`.
- Custom printers = machine presets the user saved in Bambu Studio, listed alongside the built-in ones.
- Filament count default 4.
- Nozzle choice comes for free: each nozzle size is its own entry in the list (A1 0.2, A1 0.4…).
- **What the filament count means:** it is the "prints by itself" limit everywhere: the AI's colour
  budget in every mode, the model warnings, and LayerTone's automatic-slot limit (today `AMS_SLOTS`;
  above it, manual swaps as today). Range 1 to 16 (four AMS units chained).
  - At 1 (no AMS) every colour feature stays available, with a warning that each extra colour means
    swapping filament by hand.
  - Coloured figures (meshes) keep their hard maximum of 4 colours (`MAX_MESH_COLORS`, the Meshy
    palette, k-means); they use min(count, 4) as their default and budget.
  - LayerTone's hard maximum stays 8, or the count when that is higher.
  - Saved designs are never trimmed: lowering the count only adds warnings, it never cuts a stored
    palette or filament list on load.

## Calls made by the designer (check these)

- **Baseline process and filament:** the printer preset's `default_print_profile` and
  `default_filament_profile`. For the A1 0.4 these are "0.20mm Standard @BBL A1" and "Bambu PLA Basic
  @BBL A1", exactly today's presets, so A1 users see no change.
- **Template cache per printer:** keyed by preset name (and Bambu Studio version, as today), e.g.
  `data/bambu/templates/<slug>.json`. Existing `data/bambu/template.json` is reused as the A1 0.4
  entry rather than rebuilt.
- **Building a template still takes minutes** and is still never started implicitly; the existing
  "build it" flow in the Print/export path is reused, now for the chosen printer.
- **Fallback list without Bambu Studio:** a small built-in table (name, bed, height, nozzle,
  structure) for at least A1, A1 mini, P1S, X1 Carbon, H2D at 0.4 mm. No 3MF project or cost slicing
  then, as today without Bambu Studio.
- **Layer heights:** derived from the nozzle (roughly 25 % to 75 % of the nozzle diameter, in the
  steps Bambu's own process presets use). A saved per-design layer height that the new nozzle can't
  do is snapped to the nearest allowed one, not dropped.
- **Wobble warning and "bed-slinger" advice:** only when `printer_structure` is "i3". CoreXY printers
  get no bed-slinger text.
- **Existing designs after a switch:** they are not changed; their checks, plate and exports simply
  follow the new printer. Designs too big for the new bed show the usual "Too big" error.
- **Docker:** built-in printers come from the Bambu Studio in the image. Custom printers need an
  optional read-only bind mount of the host's Bambu Studio `user` folder, documented in
  `docker-compose.yml` like the existing fonts line, plus an env var for its path (e.g.
  `BAMBU_STUDIO_USER_DIR`).
- **Which custom presets count:** only user machine presets whose `inherits` chain resolves to a
  Bambu Lab (BBL) machine preset, e.g. an A1 preset with a tweaked bed or nozzle. User presets for
  other brands, or "Custom Printer" with no parent, are skipped (other brands are a non-goal). Only
  the BBL system profiles are scanned.
- **Printer name shown to users and the AI:** the model name, with the nozzle only when it isn't 0.4
  ("Bambu Lab A1", "Bambu Lab A1 (0.2 nozzle)"), so today's A1 text stays word for word. Custom
  presets show their saved name.
- **Lithophane shop widget (`litho/`)** is out of scope: it runs in a shop customer's browser with no
  Jig server. Only its "A1" comment is reworded; `MAX_SIDE_MM` stays.
- **A1-measured estimates** (prime tower, filament change cost, power note) stay, worded as estimates
  rather than "on the A1".

## Left to the builder

- How the printer reaches synchronous shared code (`fitProblem`, `bedShift`, validation, viewer,
  prompts): passing it as an argument everywhere vs. a "current printer" holder set on load on the
  client and per request on the server. Prefer whichever keeps tests simple and avoids stale values.
- The exact shape of the stored setting and its API routes.
- How the printer list is scanned and cached (the AppImage extract is slow: scan once per Bambu
  Studio version, not per request), and which of `resources/profiles` vs. the config folder's
  `system/BBL` wins when both exist.
- First-start UI and the Print tab control's look, following Jig's existing UI.
- Dual-nozzle printers (H2D, H2D Pro, H2C, X2D): checked with Bambu Studio 02.08.04.57. Their templates
  build, but slicing Jig's project fails even in one colour, so they are listed and marked as not yet
  supported for the Bambu Studio project (plain 3MF, no print settings or cost). Every single-nozzle
  printer tried (A1, A1 0.2, A1 mini, A2L, P1S, P2S, X1C, H2S) slices in two colours.
- Non-rectangular or offset `printable_area` (if any printer has one): use its bounding box for the
  fit check and plate, its origin for bed centring.
- Tests: follow the light-test rule (small models, few browser tests).
