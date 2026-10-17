# Jig

AI-powered parametric CAD for 3D printing. Describe an object (and/or attach photos). Claude writes a parametric model with sliders and dimension callouts, checks it, looks at renders of it, and stress-tests the sliders' extremes. You tweak it live, check that it prints, and export STL, a Bambu Studio project or a Blender file.

Jig runs Claude through the Claude Agent SDK. By default it uses the Claude account the `claude` CLI is logged in with (your Claude plan); set `JIG_USE_API_KEY=1` to use `ANTHROPIC_API_KEY` instead. See [Claude account or API key](#claude-account-or-api-key) before sharing Jig with anyone.

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

Requires Node 22.12+ (developed on Node 26; `nvm use` picks it from `.nvmrc`) and a logged-in `claude` CLI (`claude` → `/login`). `npm run build` needs the dev dependencies (`npm install` installs them). `npm start` serves whatever is in `dist/`; it warns when `dist/` is missing or older than the source code.

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
  - on the server that happens in its own Node process under the permission model. It may only read `node_modules`, can't write files or start processes, has no network access and gets no environment variables (`server/geometry.ts`, `server/geometry-worker.ts`);
  - the API only answers Jig's own pages: requests must name Jig's host (against DNS rebinding) and come from Jig's own origin, and writes need an `X-Jig` header. The dev server answers no cross-origin requests and never serves `data/`.
- **Agent loop** (`server/agent.ts`, `server/cadTools.ts`): Claude can only Read/Write/Edit one file (`data/workspaces/<id>/model.js`), optionally search the web, and call three tools:
  - `evaluate_model`: errors with line numbers, bounding boxes, volumes, disconnected-piece and build-plate checks
  - `render_model`: a software-rendered ISO/front/right/top sheet with a mm grid, so Claude can compare against your photos
  - `submit_model`: requires a render of the current script first, then evaluates the defaults and a stress test at draft quality:
    - all sliders at their minimum, then all at their maximum
    - each slider alone at its minimum and maximum
    - each switch flipped, and up to 6 options of each select

    It rejects the model if a case fails, unless Claude says the failure is unavoidable. Cases that don't fit the 20 s budget are skipped, and mixed combinations (one slider low, another high) aren't tried. Multi-part designs also need an assembly sequence and assembly pictures.
- **Web search** (the globe button next to the effort picker, on for every design; turning it off lasts for that design until you reload): Claude may search the web and read public pages to find exact dimensions of products you name. It puts them into parameters and tells you its sources and which numbers are estimates. Addresses on your computer or local network (localhost, private IP ranges, `.local` names, and public names that point there) are refused. A page Claude reads could still try to steer it, so turn web search off for designs you want to keep private. With it off, Claude says which dimensions come from memory.
- **Dimension sources:** when a design has to fit a real product, Claude reports where each fit-critical dimension came from: *official* (manufacturer drawing or datasheet), *distributor*, *from you*, *community* (forums, wikis, other people's models), *social media*, *Claude's memory* or *estimate*. The Model tab lists them with links, most trustworthy first, and marks pages Claude cited without opening; the chat shows a one-line summary coloured by the weakest source. Claude prefers official sources and adds clearances for parts that must fit (pockets, port openings, screw holes; see `server/systemPrompt.ts`).
- **Dictation** (the microphone button next to *Update*): speak instead of typing. The languages come from `ELEVENLABS_LANGUAGE` and `ELEVENLABS_SECONDARY_LANGUAGES` (English with Romanian in `.env.sample`); without them the language is detected. The words appear in the chat box as you speak, after anything you typed. Enter, Esc or the microphone button stops listening and keeps the text, so you can check it; the next Enter sends it. *Update* while listening stops and sends. Audio goes from the browser to ElevenLabs' realtime speech-to-text (Scribe v2 Realtime) with a single-use token from Jig's server, so your API key stays on the server. Needs `ELEVENLABS_API_KEY`.
- **Model and effort** start at Opus / High (Medium, High, X-High or Max) for every new design; a change applies to that design until you reload.
- **Follow-ups** resume the same Claude session and send what you are looking at: a screenshot of the viewer and a four-view render with your current slider values, scale and text, plus a note if you restored an older version or edited the code.
- **System prompt**: `server/systemPrompt.ts` covers conventions (mm, Z-up, on the bed), the API reference, the helper library, printability rules and print-setting suggestions.
- **Helpers** (`shared/helpers.ts`): helical sweep (springs, corkscrews), ISO threads and threaded-hole cutters, radial surfaces (knurling), sweeps/tubes, lofts, rounded boxes, arrays, text.
- **Designs** are saved as JSON in `data/designs/`, with chat history, versions and slider values. Chat images (your photos, renders, assembly pictures) are stored once each in `data/designs/<id>/`.

## Designs and versions

- **Tabs:** designs you open appear as tabs in the top bar, so parallel generations are one click apart. A spinner marks designs Claude is working on, and a dot marks ones that finished while you were looking at another. *Close all* closes every tab except designs Claude is working on (nothing is deleted). Every saved design is in *Designs*. Right-click the logo to start a new design in a new browser tab.
- **Versions:** click *v2 of 5* in the top bar to jump to any version. Gold versions are Claude's or your own code edits, blue ones are settings you saved.
- **Code tab:** edit `model.js` by hand and *Apply* it (Ctrl+S) to make a new version. Edits you haven't applied stay there while you look at other tabs or designs.
- **Saved settings:** when your sliders, scale, text or print overrides differ from the current version, *Save as vN* appears next to it and stores them as a new version. Restoring a version brings its settings back; switching versions with unsaved changes asks whether to save them, discard them or cancel.
- **Autosave:** every change is saved to `data/designs/<id>.json` about half a second later, even if you open another design right away. There is one file per design, overwritten; autosave never creates versions.
  - If a save fails, *Not saved – retry* appears in the top bar. The unsaved copy stays in memory if you open another design, so coming back and retrying saves your changes.
  - Closing the page with unsaved changes, or while Claude is working, asks first. Closing it stops the generation.
  - Each save is numbered (`rev`). If another tab or window saved the design since this one last did, that newer copy is shown instead of being overwritten (while Claude works on the design here, Claude's copy wins).
  - A design deleted in one tab closes in the others, and nothing saves it back.
- **Questions:** ask Claude something about the design and the reply starts with the short answer, then the explanation; the model is only changed when you ask for a change.

## Watching Claude work

The chat shows every step with its time while Claude works, and follows new output only while you are scrolled to the bottom. Hover the working line, click it to pin, or click *activity* on any reply to open the activity panel beside the chat. It shows:
- Claude's thinking and reply as they stream
- `model.js` as it is typed (edits as replace/with)
- each tool call with its result and render previews

The panel follows the newest output unless you scroll up. Thinking arrives as Claude Code's summaries, a few sentences at a time. The live transcript is kept in memory only; after a reload the panel is rebuilt from the saved steps.

## Viewer

- **Controls:** orbit/pan/zoom, a home view (`Home` key; `F` fits from the current angle), view presets and an ortho camera.
- **Overlays:** bounding-box dimensions, AI feature callouts, a click-to-measure tool with vertex snapping, a section plane, per-part visibility and a part-colour toggle.
- **Display:** fullscreen (`U` hides the controls there) and draft/normal/high preview quality.
- **Sidebars:** `T` and `N` hide the chat and parameter sidebars.

The 256 × 256 mm Bambu Lab A1 plate is drawn. The printer is defined in `shared/printer.ts` (build volume, nozzle and Bambu Studio presets); the baseline print settings are in `shared/print.ts`.

**Editable dimensions:** double-click any X/Y/Z or callout label (or type in *Overall size*) and the app solves for the parameter value that produces exactly that size. Uniform *Scale %* is available too.

**Multi-part designs:** a layout bar switches between print, assembled and exploded layouts, and *Assemble* animates Claude's assembly sequence step by step. Replies include assembly pictures and instructions.

## Text

- **Text tool (Text tab):** raised or engraved text on any face or on a point you click. Text can lie flat or stand on a side, be straight, follow an arc, or wrap around a cylinder. You set letter height, depth, rotation, spacing and multi-line layout, and it sticks to the surface when sliders change.
- **Fonts:** bundled open-licence fonts (Roboto, Inter, Montserrat, Oswald, Bebas Neue, Black Ops One, Allerta Stencil, Pacifico, Lobster, Roboto Mono), plus every TTF/OTF font installed on the computer, shown with live previews. Installed fonts come from fontconfig on Linux and from the system font folders on macOS and Windows. A font that isn't available is reported, and the text uses Roboto Bold.
- **Through Claude:** `H.text`, `H.textSolid` and `H.wrapAroundZ`, plus `text` parameters, cover anything the tool can't do (twisted, tapered, stencil, per-letter effects).

## Print settings and validation

- **Print tab:** layer height, walls, top/bottom layers, infill % and pattern, supports (and whether they may only stand on the plate), brim, wall order, seam, ironing and fuzzy skin, for the whole model or per part. The baseline is Bambu Lab A1, PLA, 0.20 mm Standard as your Bambu Studio defines it: once the 3MF template has been built from your install, the Print tab, Claude and the export all read their defaults from it (until then, the Bambu Studio 2.8 values). Claude suggests changes where the design needs them (e.g. more walls for a hook, supports for an overhang), and your overrides win.
- **Validate** (and automatically on every export) checks the high-resolution mesh of the parts being exported. It checks:
  - fit in the printer and contact with the plate
  - holes, non-manifold edges, flipped or inside-out faces
  - floating parts and pieces in mid-air (a sealed cavity is not one)
  - tall narrow parts, overhangs that need supports, walls too thin for the nozzle
  - overlapping parts

  Supports and brim from the print settings are taken into account.

## Export

Exports contain the visible parts only; hide a part to leave it out, or export a single part as STL from the Model tab. Every export rebuilds the model at high resolution and validates exactly that mesh. Problems are reported, not blocking. If the high-resolution build fails, nothing is exported and the error is shown.

- **STL** (default): a single mesh.
- **3MF:** one named object per part, positioned exactly as in the viewer and centred on the printer's bed. Options:
  - **Colours:** each part keeps its colour, and Bambu Studio maps the colours onto AMS filaments.
  - **Print settings:** a Bambu Studio project with the A1 / PLA / 0.20 mm profile and your print settings (model-wide and per part). Parts that touch become one object with the parts inside it. Each part keeps its own walls, infill and top/bottom layers. Supports and brim can only be set per object in Bambu Studio, so an object gets supports if any of its parts needs them, and the widest brim. The template is built from your own Bambu Studio install the first time and cached in `data/bambu/`; nothing from Bambu is bundled.
- **Blender (.blend):** built by your installed Blender (4.1 or newer) in the background. It has one object per part with materials, millimetre units, a *Dimensions* collection, parameter values as custom properties, and the model script embedded.

## Configuration

Set these in the environment, or in a `.env` file next to `package.json` (copy `.env.sample`; git ignores `.env`). Values already in the environment win.

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | API server port |
| `ELEVENLABS_API_KEY` | | Turns on dictation (the microphone button) |
| `ELEVENLABS_LANGUAGE` | detected | Main dictation language (ISO 639 code, e.g. `en`) |
| `ELEVENLABS_SECONDARY_LANGUAGES` | | Other languages you may speak, comma-separated (e.g. `ro`) |
| `API_PORT` | `8787` | Where the Vite dev server proxies `/api` (set it with `PORT`) |
| `JIG_DATA` | `data/` in the Jig folder | Designs, chat images, workspaces, Bambu template cache |
| `JIG_USE_API_KEY` | off | `1` to use `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) instead of the `claude` CLI's login; otherwise both are removed from Claude's environment |
| `CLAUDE_PATH` | bundled | Claude Code executable for the Agent SDK |
| `BAMBU_STUDIO_PATH` | found on `PATH` or in the default install folder | Bambu Studio executable |
| `BLENDER_PATH` | found on `PATH` or in the default install folder | Blender executable |
| `NODE_ENV` | | `production` serves `dist/` too (as `npm start` does with `--production`) |
| `DEBUG_AGENT` | off | Print the Claude Code process's stderr |

## Claude account or API key

By default Jig runs on the Claude account you are logged in with in the `claude` CLI. That is meant for your own use on your own computer. Anthropic's terms do not allow third-party developers to offer claude.ai login, or to route requests through Free, Pro or Max plan credentials on behalf of their users, without approval. See the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). If you share or host Jig for other people, run it with `JIG_USE_API_KEY=1` and an API key.

## License

Copyright (C) 2026 3dprogramin.

Jig's own code is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), see [LICENSE](LICENSE). You may use, change and share it; if you share a changed Jig, or run a changed Jig as a service other people use over a network, you must offer them its source code under the same licence.

**Additional permission under AGPL-3.0 section 7:** if you modify Jig, or any covered work, by linking or combining it with `@anthropic-ai/claude-agent-sdk` or the Claude Code executable (or a modified version of either), containing parts covered by Anthropic's terms, the copyright holder grants you additional permission to convey the resulting work. The source for those parts is not required as part of Jig's Corresponding Source.

Other licences (for example for a hosted or closed-source use of Jig) can be had from the copyright holder: andrei@3dprogramin.io.

Jig depends on packages under their own licences:
- **`@anthropic-ai/claude-agent-sdk` and the Claude Code executable it installs** are proprietary and covered by [Anthropic's terms](https://www.anthropic.com/legal), not by Jig's licence. Install them with `npm install`; don't redistribute them (for example inside `node_modules` in an archive or image).
- **The packages bundled into the built app** (manifold-3d, SES, three.js, React and others) are MIT or Apache-2.0. `npm run build` writes their licences to `dist/THIRD_PARTY_NOTICES.md`; keep that file with any copy of `dist/`.
- **The bundled fonts** (`@fontsource`) are under the SIL Open Font License.

Jig is an independent project. It is not affiliated with or endorsed by Anthropic, Bambu Lab or the Blender Foundation. Claude, Bambu Lab, Bambu Studio and Blender are trademarks of their respective owners.
