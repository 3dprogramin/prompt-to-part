# Jig

AI-powered parametric CAD for 3D printing. Describe an object (and/or attach photos, SVG drawings or OpenSCAD files). Claude writes a parametric model with sliders and dimension callouts, checks it, looks at renders of it, and stress-tests the sliders' extremes. You tweak it live, add text or logos, check that it prints, see what it costs to print, and export STL, a Bambu Studio project or a Blender file.

Jig runs Claude through the Claude Agent SDK with an Anthropic API key (`ANTHROPIC_API_KEY`). See [Claude account or API key](#claude-account-or-api-key).

## Run

```sh
npm install
npm run dev          # http://localhost:5173  (API on :8787)
npm run dev:watch    # same, but the API server restarts on code changes (kills running generations)
# or
npm run build && npm start   # single server on http://127.0.0.1:8787
npm test             # unit and API tests (about 5 s)
npm run typecheck
```

Requires Node 22.12+ (developed on Node 26; `nvm use` picks it from `.nvmrc`) and an Anthropic API key in `ANTHROPIC_API_KEY` (copy `.env.sample` to `.env` and fill it in). `npm run build` needs the dev dependencies (`npm install` installs them). `npm start` serves whatever is in `dist/`; it warns when `dist/` is missing or older than the source code.

Optional:
- **Bambu Studio** (2.x) for Bambu project 3MF export.
- **Blender 4.1 or newer** for `.blend` export.

Both are found on `PATH` and in their default install folders on macOS (`/Applications`) and Windows (`Program Files`). Otherwise set `BAMBU_STUDIO_PATH` / `BLENDER_PATH`. Jig is developed and tested on Linux.

`npm run dev` does not restart the API server when its code changes, because a restart kills every running generation. Restart it yourself once nothing is generating.

## How it works

- **Geometry**: [manifold-3d](https://github.com/elalish/manifold) (WASM), which gives robust booleans and watertight STL. Model scripts are plain JS (`meta`, `params`, `build(p)`). They are evaluated in a Web Worker for the live preview, and in a separate Node process for Claude's checks and renders.
  - Every WASM object a build creates is freed afterwards.
  - If the WASM instance crashes, the worker is replaced and the job runs once more. A model that runs out of memory is reported as such and is not retried.
  - The server starts a fresh worker every 300 jobs; the browser restarts its worker after a big export or validation.
  - The browser worker also prepares what the viewer draws, so big models don't freeze the page. A slow preview is abandoned when you move the slider again.
- **Sandbox**: model scripts are untrusted code (Claude writes them from your prompts, photos and web pages), so they never run with the app's privileges:
  - each script runs in an [SES](https://github.com/endojs/endo/tree/master/packages/ses) Compartment (`shared/sandbox.ts`) that holds only `Manifold`, `CrossSection`, `H`, `quality` and `console`: no `process`, `require`, `import()`, `fetch`, timers, network or app API. The `constructor` escape routes are disarmed, and the classes and prototypes scripts get are frozen, so one design can't change what the next one runs;
  - a name that is used but never declared (a typo) is an error with its line number, not a silent `undefined`;
  - a script that rewrites a Manifold object's internals (its heap pointer) is stopped and its worker replaced, so one design can't corrupt another's geometry. A WebAssembly crash is noticed even if the script catches it;
  - what a script can send back to Claude is capped (console output, errors, warnings, labels, parameters, the whole report);
  - on the server that happens in its own Node process under the permission model. It may only read `node_modules`, can't write files or start processes, has no network access and gets no environment variables (`server/geometry.ts`, `server/geometry-worker.ts`);
  - the API only answers Jig's own pages: requests must name Jig's host (against DNS rebinding) and come from Jig's own origin, and writes need an `X-Jig` header. The dev server answers no cross-origin requests and never serves `data/`.
- **Agent loop** (`server/agent.ts`, `server/cadTools.ts`): Claude can only Read/Write/Edit one file (`data/workspaces/<id>/model.js`), optionally search the web, and call three tools:
  - `evaluate_model`: errors with line numbers, bounding boxes, volumes, disconnected-piece and build-plate checks
  - `render_model`: a software-rendered ISO/front/right/top sheet with a mm grid, so Claude can compare against your photos
  - `submit_model`: requires a render of the current script first and the sources of the real-world dimensions it uses (see *Dimension sources*), then evaluates the defaults and a stress test at draft quality:
    - all sliders at their minimum, then all at their maximum
    - each slider alone at its minimum and maximum
    - each switch flipped, and up to 6 options of each select

    It rejects the model if a case fails, unless Claude says the failure is unavoidable. Cases that don't fit the 20 s budget are skipped, and mixed combinations (one slider low, another high) aren't tried. Multi-part designs also need an assembly sequence and assembly pictures.
- **Web search** (the globe button next to the effort picker, on for every design; turning it off lasts for that design until you reload): Claude may search the web and read public pages to find exact dimensions of products you name. It puts them into parameters and tells you its sources and which numbers are estimates. Addresses on your computer or local network (localhost, private IP ranges, `.local` names, and public names that point there) are refused. A page Claude reads could still try to steer it, so turn web search off for designs you want to keep private. With it off, Claude says which dimensions come from memory.
- **Dimension sources:** when a design has to fit a real product, Claude reports where each fit-critical dimension came from: *official* (manufacturer drawing or datasheet), *distributor*, *from you*, *community* (forums, wikis, other people's models), *social media*, *Claude's memory* or *estimate*. The *Model* section (Code tab) lists them with links, most trustworthy first, and marks pages Claude cited without opening; the chat shows a one-line summary coloured by the weakest source. Claude prefers official sources and adds clearances for parts that must fit (pockets, port openings, screw holes; see `server/systemPrompt.ts`).
- **Dictation** (the microphone button next to *Update*): speak instead of typing. The languages come from `ELEVENLABS_LANGUAGE` and `ELEVENLABS_SECONDARY_LANGUAGES` (English with Romanian in `.env.sample`); without them the language is detected. The words appear in the chat box as you speak, after anything you typed. Enter, Esc or the microphone button stops listening and keeps the text, so you can check it; the next Enter sends it. *Update* while listening stops and sends. Audio goes from the browser to ElevenLabs' realtime speech-to-text (Scribe v2 Realtime) with a single-use token from Jig's server, so your API key stays on the server. Needs `ELEVENLABS_API_KEY`.
- **Model and effort** start at Opus / High (Medium, High, X-High or Max) for every new design; a change applies to that design until you reload.
- **Follow-ups** resume the same Claude session and send what you are looking at: a screenshot of the viewer and a four-view render with your current slider values, scale, text and SVG drawings, plus a note if you restored an older version or edited the code.
- **System prompt**: `server/systemPrompt.ts` covers conventions (mm, Z-up, on the bed), the API reference, the helper library, printability rules, where to take real-world dimensions from and the clearances for parts that must fit purchased ones, and print-setting suggestions (with your Bambu Studio profile as the baseline).
- **Helpers** (`shared/helpers.ts`): helical sweep (springs, corkscrews), ISO threads and threaded-hole cutters, radial surfaces (knurling), sweeps/tubes, lofts, rounded boxes, arrays, text, and SVG drawings attached in the chat (`H.svg`).
- **Designs** are saved as JSON in `data/designs/`, with chat history, versions and slider values. Chat images (your photos, renders, assembly pictures) are stored once each in `data/designs/<id>/`.

## Designs and versions

- **Tabs:** designs you open appear as tabs in the top bar, so parallel generations are one click apart. A spinner marks designs Claude is working on, and a dot marks ones that finished while you were looking at another. *Close all* closes every tab except designs Claude is working on (nothing is deleted). Every saved design is in *Designs*. Right-click the logo to start a new design in a new browser tab.
- **Versions:** click *v2 of 5* in the top bar to jump to any version. Gold versions are Claude's or your own code edits, blue ones are settings you saved. A design has one chat and one Claude session: after you jump back, Claude is told which version you are on and works from it, and its new version is added at the end. To start over from a version without that history, use the branch button next to it (*New design from vN*): a new design with that version's script and settings, an empty chat and its own Claude session (handy for product variants). The original design stays as it is.
- **Code (Code tab):** edit `model.js` by hand and *Apply* it (Ctrl+S) to make a new version. Edits you haven't applied stay there while you look at other tabs or designs.
- **Saved settings:** when your sliders, scale, text, SVG drawings or print overrides differ from the current version, *Save as vN* appears next to it and stores them as a new version. Restoring a version brings its settings back; switching versions with unsaved changes asks whether to save them, discard them or cancel.
- **Autosave:** every change is saved to `data/designs/<id>.json` about half a second later, even if you open another design right away. There is one file per design, overwritten; autosave never creates versions.
  - If a save fails, *Not saved – retry* appears in the top bar. The unsaved copy stays in memory if you open another design, so coming back and retrying saves your changes.
  - Closing the page with unsaved changes, or while Claude is working, asks first. Closing it stops the generation.
  - Each save is numbered (`rev`). If another tab or window saved the design since this one last did, that newer copy is shown instead of being overwritten (while Claude works on the design here, Claude's copy wins).
  - A design deleted in one tab closes in the others, and nothing saves it back.
- **Messages while Claude works:** type and press Enter (or *Send*, next to *Stop*) and the message is queued; it goes out once Claude's reply is done, several queued messages together as one. If the reply is stopped or fails, the queue waits for *Send now*. Queued messages show above the chat box, each with a × to drop it.
- **Questions:** ask Claude something about the design and the reply starts with the short answer, then the explanation; the model is only changed when you ask for a change.

## Side panel

Four tabs, each with two sections one under the other (click a section's title to fold it):

- **Object:** *Parts* and *Parameters*. *Parts* lists the model's parts as a tree: show or hide each part (hidden parts stay out of the view, the exports, validation and the cost, and stay hidden with the design), select one to highlight it in the view, export one part as STL, and switch the text and SVG drawings placed on it on and off. *Parameters* has the overall size and the sliders. A slider whose parts are all hidden is greyed out: Jig measures which parts each parameter changes (building the model once per parameter with its value nudged), and Claude can name them with `part` / `parts`.
- **Text & SVG:** the text and SVG tools.
- **Print:** print settings and the cost.
- **Code:** the model's measurements, dimension sources and console, and the script editor.

## Watching Claude work

The chat shows every step with its time while Claude works, and follows new output only while you are scrolled to the bottom. Hover the working line, click it to pin, or click *activity* on any reply to open the activity panel beside the chat. It shows:
- Claude's thinking and reply as they stream
- `model.js` as it is typed (edits as replace/with)
- each tool call with its result and render previews
- what Jig sent Claude (the full request text, your current view and the four-view render) and the full text Claude got back from every tool (measurements, file reads, web pages, OpenSCAD reports), under *Show the full text*

The panel follows the newest output unless you scroll up. Drag its header to move it anywhere (over the 3D view, say) and its corner to resize it; it remembers where you put it, and a double-click on the header puts it back beside the chat. Pinned on a reply Claude is working on, it follows Claude: it shows the live reply of whichever design you open, is hidden on designs where Claude isn't working, stays open on a reply that has just finished, and only its × stops this. On one design it keeps what it has shown: the next reply (a queued message, say) is added below, after a line with the message that started it. Thinking arrives as Claude Code's summaries, a few sentences at a time. The live transcript is kept in memory only; after a reload the panel is rebuilt from the saved steps.

## Viewer

- **Controls:** orbit/pan/zoom, a home view (`Home` key; `F` fits from the current angle), view presets and an ortho camera.
- **Overlays:** bounding-box dimensions, AI feature callouts, a click-to-measure tool with vertex snapping, a section plane, per-part visibility and a part-colour toggle.
- **Display:** fullscreen (`U` hides the controls there) and draft/normal/high preview quality.
- **Sidebars:** `T` and `N` hide the chat and parameter sidebars; drag their inner edge to resize them (double-click it for the default width).

The 256 × 256 mm Bambu Lab A1 plate is drawn. The printer is defined in `shared/printer.ts` (build volume, nozzle and Bambu Studio presets). The baseline print settings come from the template built from your Bambu Studio (`data/bambu/template.json`), with the Bambu Studio 2.8 values in `shared/print.ts` as the fallback.

**Editable dimensions:** double-click any X/Y/Z or callout label (or type in *Overall size*) and the app solves for the parameter value that produces exactly that size. Uniform *Scale %* is available too.

**Multi-part designs:** a layout bar switches between print, assembled and exploded layouts, and *Assemble* animates Claude's assembly sequence step by step. Replies include assembly pictures and instructions.

## Text and SVG

- **Text tool (Text & SVG tab):** raised or engraved text on any face or on a point you click. Text can lie flat or stand on a side, be straight, follow an arc, or wrap around a cylinder. You set letter height, depth, rotation, spacing and multi-line layout, and it sticks to the surface when sliders change.
- **SVG tool (Text & SVG tab):** import an SVG file (a logo, an icon, artwork) and raise or engrave it on the model like text: on a face or a clicked point, with height (the width keeps the proportions), depth, offsets, rotation, and optionally wrapped around a cylinder. It sticks to the surface when sliders change, and Claude is told about it in follow-ups. For drawings in several colours you choose which colours are raised (or engraved); shapes of other colours painted on top cut through them, as they cover them in the drawing (white lettering on a red disc becomes a disc with the lettering cut out, or just the lettering). White-ish colours are left out by default, as they are usually the background. Filled shapes are imported (paths, rectangles, circles, ellipses, polygons and `<use>` copies, with their transforms and fill rules); strokes, text and embedded pictures are reported and skipped, so convert them to paths first (Inkscape: *Path → Stroke to Path* / *Object to Path*). The drawing is stored with the design as polygons (`$svg`), simplified if it is very detailed.
- **SVG in the chat:** attach an SVG file to a message (the picture button, or drop it like a photo) and Claude gets both a picture of it and its exact shapes. Model scripts use those with `H.svg(name, { height, colors })`, which returns the drawing as a flat shape to extrude, cut out or outline, so a logo on a coaster or a badge comes out exactly as drawn rather than redrawn by eye. The colour choice works as in the SVG tool (e.g. a red disc with its white lettering cut out). Attached drawings are kept with the design (`$drawings`), so the preview, Claude's checks and the exports all use the same shapes.
- **OpenSCAD in the chat:** attach a `.scad` file (the same button, or drop it) and describe what you want from it. Jig renders it with OpenSCAD on the server, and Claude gets its source, its Customizer parameters, the sizes of its parts and a four-view picture. It then rebuilds it as a Jig script, keeping the parameters as sliders and each `color()` as its own part unless you say otherwise. While it works it can render the original at any parameter values (`render_scad`) to compare with its own. Files are kept in the design's workspace, so later messages can still use them. Libraries that come with OpenSCAD Playground (BOSL2, BOSL, MCAD, NopSCADlib and others) work in `include`/`use`; other included files don't. The engine is downloaded the first time it is needed (about 16 MB, into `node_modules/.cache/jig`).
- **Fonts:** bundled open-licence fonts (Roboto, Inter, Montserrat, Oswald, Bebas Neue, Black Ops One, Allerta Stencil, Pacifico, Lobster, Roboto Mono), plus every TTF/OTF font installed on the computer, shown with live previews. Installed fonts come from fontconfig on Linux and from the system font folders on macOS and Windows. A font that isn't available is reported, and the text uses Roboto Bold.
- **Through Claude:** `H.text`, `H.textSolid` and `H.wrapAroundZ`, plus `text` parameters, cover anything the tool can't do (twisted, tapered, stencil, per-letter effects).

## Print settings and validation

- **Print settings (Print tab):** layer height, walls, top/bottom layers, infill % and pattern, supports (and whether they may only stand on the plate), brim, wall order, seam, ironing and fuzzy skin, for the whole model or per part. The baseline is Bambu Lab A1, PLA, 0.20 mm Standard as your Bambu Studio defines it: once the 3MF template has been built from your install, the Print tab, Claude and the export all read their defaults from it (until then, the Bambu Studio 2.8 values). Claude suggests changes where the design needs them (e.g. more walls for a hook, supports for an overhang), and your overrides win.
- **Validate** (and automatically on every export) checks the high-resolution mesh of the parts being exported. It checks:
  - fit in the printer and contact with the plate
  - holes, non-manifold edges, flipped or inside-out faces
  - floating parts and pieces in mid-air (a sealed cavity is not one)
  - tall narrow parts, overhangs that need supports, walls too thin for the nozzle
  - overlapping parts

  Supports and brim from the print settings are taken into account.

## Cost

The *Cost* section of the *Print* tab works out what a print costs, from Bambu Studio's own numbers:

- **Print time and filament:** the visible parts are built at export resolution, made into the same Bambu Studio project as the 3MF export (your print settings included) and sliced by your installed Bambu Studio (`server/slicer.ts`, with its own data folder in `data/bambu/slicer-data`, so your Bambu Studio settings are untouched). The time is Bambu Studio's estimate; the grams include supports, the prime tower and purge, per filament for multi-colour prints.
- **When:** opening the Cost section slices whatever is missing or out of date; later changes only mark the numbers as out of date until you press *Recalculate*. Each stage (building the model, preparing the project, slicing) is shown with its elapsed time, in the tab and in the viewer's status bar. Small models slice in a second or two; the first project needs the Bambu Studio template, which takes longer.
- **Filament cost:** grams × your price per 1 kg roll (RON).
- **Electricity:** only from your printer's **measured** average power (a plug-in meter: the kWh a print used ÷ its hours × 1000) and your price per kWh. The A1's 1300 W rating is its peak while the bed heats, so it is never used; without a measurement electricity is left out rather than guessed.
- **Selling price:** *Ask Claude* sends the costs, print time, size, parts and what the item is to Claude (Sonnet, one reply, no tools), which suggests a price, a range and its reasoning. It is shown as Claude's suggestion, not a calculation.

Your prices are kept in `data/cost.json`.

## Export

Exports contain the visible parts only; hide a part to leave it out (Object tab, or the part list in the view), or export a single part as STL from the Object tab. Every export rebuilds the model at high resolution and validates exactly that mesh. Problems are reported, not blocking. If the high-resolution build fails, nothing is exported and the error is shown.

- **STL** (default): a single mesh.
- **3MF:** one named object per part, positioned exactly as in the viewer and centred on the printer's bed. Options:
  - **Colours:** each part keeps its colour, and Bambu Studio maps the colours onto AMS filaments.
  - **Print settings:** a Bambu Studio project with the A1 / PLA / 0.20 mm profile and your print settings (model-wide and per part). Parts that touch become one object with the parts inside it. Each part keeps its own walls, infill and top/bottom layers. Supports and brim can only be set per object in Bambu Studio, so an object gets supports if any of its parts needs them, and the widest brim. The template is built from your own Bambu Studio install the first time and cached in `data/bambu/`; nothing from Bambu is bundled.
- **Blender (.blend):** built by your installed Blender (4.1 or newer) in the background. It has one object per part with materials, millimetre units, a *Dimensions* collection, parameter values as custom properties, and the model script embedded.

## Configuration

Set these in the environment, or in a `.env` file next to `package.json` (copy `.env.sample`; git ignores `.env`). Values already in the environment win. The API server reads `.env` only when it starts, so restart `npm run dev` after changing it (Vite restarting itself on a `.env` change doesn't restart the API server).

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | API server port |
| `ELEVENLABS_API_KEY` | | Turns on dictation (the microphone button) |
| `ELEVENLABS_LANGUAGE` | detected | Main dictation language (ISO 639 code, e.g. `en`) |
| `ELEVENLABS_SECONDARY_LANGUAGES` | | Other languages you may speak, comma-separated (e.g. `ro`) |
| `API_PORT` | `8787` | Where the Vite dev server proxies `/api` (set it with `PORT`) |
| `JIG_DATA` | `data/` in the Jig folder | Designs, chat images, workspaces, the Bambu template and slicer data, cost settings |
| `ANTHROPIC_API_KEY` | | Your Anthropic API key: needed for Claude (generations, price suggestions) |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | | Instead of the key: a token and base URL of an Anthropic-compatible provider |
| `JIG_AUTH` | `api-key` | `subscription` uses the Claude account the `claude` CLI is logged in with instead of a key, for your own use on your own computer only (see below) |
| `CLAUDE_PATH` | bundled | Claude Code executable for the Agent SDK |
| `BAMBU_STUDIO_PATH` | found on `PATH` or in the default install folder | Bambu Studio executable |
| `BLENDER_PATH` | found on `PATH` or in the default install folder | Blender executable |
| `NODE_ENV` | | `production` serves `dist/` too (as `npm start` does with `--production`) |
| `DEBUG_AGENT` | off | Print the Claude Code process's stderr |

## Claude account or API key

Jig needs an Anthropic API key: set `ANTHROPIC_API_KEY` in `.env` (or the environment). An Anthropic-compatible provider works too, through `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, with `ANTHROPIC_API_KEY` set but empty. For [OpenRouter](https://openrouter.ai/docs/guides/guides/claude-code-integration): `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, your OpenRouter key in `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY=` (see `.env.sample`). A design whose Claude session was started another way (on a subscription, say) can't continue it through a different provider: its next message starts a fresh session with a summary of the conversation, and later messages continue that one. Without either, Jig doesn't start Claude: the chat box says what is missing, and it never falls back to a Claude account logged in on the computer.

`JIG_AUTH=subscription` makes Jig use the Claude account the `claude` CLI is logged in with (`claude` → `/login`) instead of a key. That is meant only for running Jig yourself, on your own computer, with your own account. Anthropic's terms do not allow third-party developers to offer claude.ai login, or to route requests through Free, Pro or Max plan credentials on behalf of their users, without approval. See the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). If you share or host Jig for other people, use API keys.

## License

Copyright (C) 2026 3dprogramin.

Jig's own code is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), see [LICENSE](LICENSE). You may use, change and share it; if you share a changed Jig, or run a changed Jig as a service other people use over a network, you must offer them its source code under the same licence.

**Additional permission under AGPL-3.0 section 7:** if you modify Jig, or any covered work, by linking or combining it with `@anthropic-ai/claude-agent-sdk` or the Claude Code executable (or a modified version of either), containing parts covered by Anthropic's terms, the copyright holder grants you additional permission to convey the resulting work. The source for those parts is not required as part of Jig's Corresponding Source.

Other licences (for example for a hosted or closed-source use of Jig) can be had from the copyright holder: andrei@3dprogramin.io.

Jig depends on packages under their own licences:
- **`@anthropic-ai/claude-agent-sdk` and the Claude Code executable it installs** are proprietary and covered by [Anthropic's terms](https://www.anthropic.com/legal), not by Jig's licence. Install them with `npm install`; don't redistribute them (for example inside `node_modules` in an archive or image).
- **The packages bundled into the built app** (manifold-3d, SES, three.js, React and others) are MIT or Apache-2.0. `npm run build` writes their licences to `dist/THIRD_PARTY_NOTICES.md`; keep that file with any copy of `dist/`.
- **The bundled fonts** (`@fontsource`) are under the SIL Open Font License.
- **OpenSCAD** (for `.scad` files in the chat) is GPL-2.0-or-later and not part of Jig: Jig downloads the [OpenSCAD Playground](https://github.com/openscad/openscad-playground) WebAssembly build from npm on first use (pinned version, checked against its hash) and runs it as a separate program on the server only. Its source is at [github.com/openscad/openscad](https://github.com/openscad/openscad); the libraries it comes with have their own licences.

Jig is an independent project. It is not affiliated with or endorsed by Anthropic, Bambu Lab or the Blender Foundation. Claude, Bambu Lab, Bambu Studio and Blender are trademarks of their respective owners.
