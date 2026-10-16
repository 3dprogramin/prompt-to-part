# Jig

AI-powered parametric CAD for 3D printing. Describe an object (and/or attach photos). Claude writes a parametric model with sliders and dimension callouts, checks it, looks at renders of it, and stress-tests every slider. You tweak it live, check that it prints, and export STL, a Bambu Studio project or a Blender file.

Uses your **Claude Code subscription** through the Claude Agent SDK. No API key is needed, and `ANTHROPIC_API_KEY` is ignored unless `JIG_USE_API_KEY=1`.

## Run

```sh
npm install
npm run dev          # http://localhost:5173  (API on :8787)
npm run dev:watch    # same, but the API server restarts on code changes (kills running generations)
# or
npm run build && npm start   # single server on http://127.0.0.1:8787
```

Requires Node ≥ 20.19 and a logged-in `claude` CLI (`claude` → `/login`). Optional: Bambu Studio (Bambu project 3MF export) and Blender (`.blend` export), both found automatically.

`npm run dev` does not restart the API server when its code changes, because a restart kills every running generation. Restart it yourself once nothing is generating.

## How it works

- **Geometry**: [manifold-3d](https://github.com/elalish/manifold) (WASM), which gives robust booleans and watertight STL. Model scripts are plain JS (`meta`, `params`, `build(p)`) evaluated in a Web Worker for the live preview, and in a separate Node process for Claude's checks and renders. Every WASM object a build creates is freed afterwards. If the WASM instance ever crashes, the worker is replaced and the job runs once more; the server also starts a fresh worker every 300 jobs.
- **Sandbox**: model scripts are untrusted code (Claude writes them from your prompts, photos and web pages), so they never run with the app's privileges:
  - each script runs in an [SES](https://github.com/endojs/endo/tree/master/packages/ses) Compartment (`shared/sandbox.ts`) that holds only `Manifold`, `CrossSection`, `H`, `quality` and `console`: no `process`, `require`, `import()`, `fetch`, timers, network or app API, and the `constructor` escape routes are disarmed;
  - on the server that happens in its own Node process under the permission model: it may only read `node_modules`, can't write files or start processes, and gets no environment variables (`server/geometry.ts`);
  - the API only answers Jig's own pages: requests must name Jig's host (against DNS rebinding), come from a local origin, and writes need an `X-Jig` header.
- **Agent loop** (`server/agent.ts`): Claude can only Read/Write/Edit one file (`data/workspaces/<id>/model.js`), optionally search the web, and call three tools:
  - `evaluate_model`: errors with line numbers, bounding boxes, volumes, disconnected-piece and build-plate checks
  - `render_model`: a software-rendered ISO/front/right/top sheet with a mm grid, so Claude can compare against your photos
  - `submit_model`: evaluates every slider at its min and max and rejects the model if any combination breaks. Multi-part designs also need an assembly sequence and assembly pictures.
- **Web search** (the globe button next to the model picker, off for every new design and never saved): Claude may use web search and read pages to find exact dimensions of products you name, puts them into parameters and tells you its sources and which numbers are estimates. With it off, Claude says which dimensions come from memory.
- **Model and effort** start at Opus / High for every new design; a change applies to that design until you reload.
- **Follow-ups** resume the same Claude session and send what you are looking at: a screenshot of the viewer and a four-view render with your current slider values, scale and text, plus a note if you restored an older version or edited the code.
- **System prompt**: `server/systemPrompt.ts` covers conventions (mm, Z-up, on the bed), the API reference, the helper library, printability rules and print-setting suggestions.
- **Helpers** (`shared/runtime.ts`): helical sweep (springs, corkscrews), ISO threads and threaded-hole cutters, radial surfaces (knurling), sweeps/tubes, lofts, rounded boxes, arrays, text.
- **Designs** are saved as JSON in `data/designs/`, with chat history, versions and slider values.

## Designs and versions

- **Tabs:** designs you open appear as tabs in the top bar, so parallel generations are one click apart. A spinner marks designs Claude is working on, and a dot marks ones that finished while you were looking at another. Every saved design is in *Designs*. Right-click the logo to start a new design in a new browser tab.
- **Versions:** click *v2 of 5* in the top bar to jump to any version. Gold versions are Claude's, blue ones are settings you saved.
- **Saved settings:** when your sliders, scale, text or print overrides differ from the current version, *Save as vN* appears next to it and stores them as a new version. Restoring a version brings its settings back; switching versions with unsaved changes asks whether to save them, discard them or cancel.
- **Autosave:** every change is saved to `data/designs/<id>.json` about half a second later (one file per design, overwritten; autosave never creates versions). If a save fails, *Not saved – retry* appears in the top bar, and closing the tab asks first.
- **Questions:** ask Claude something about the design and the reply starts with the short answer, then the explanation; the model is only changed when you ask for a change.

## Watching Claude work

The chat shows every step with its time while Claude works. Hover the working line, click it to pin, or click *activity* on any reply to open the activity panel beside the chat. It shows Claude's thinking and reply as they stream, `model.js` as it is typed (edits as replace/with), and each tool call with its result and render previews. It follows the newest output unless you scroll up. Thinking arrives as Claude Code's summaries, a few sentences at a time. The live transcript is kept in memory only; after a reload the panel is rebuilt from the saved steps.

## Viewer

Orbit/pan/zoom, a home view (`Home` key, `F` fits from the current angle), view presets, ortho camera, bounding-box dimensions, AI feature callouts, a click-to-measure tool with vertex snapping, a section plane, per-part visibility, a part-colour toggle, fullscreen, and draft/normal/high preview quality. The 256 × 256 mm Bambu Lab A1 plate is drawn (change the printer in `shared/printer.ts`). `T` and `N` hide the chat and parameter sidebars.

**Editable dimensions:** double-click any X/Y/Z or callout label (or type in *Overall size*) and the app solves for the parameter value that produces exactly that size. Uniform *Scale %* is available too.

**Multi-part designs:** a layout bar switches between print, assembled and exploded layouts, and *Assemble* animates Claude's assembly sequence step by step. Replies include assembly pictures and instructions.

## Text

- **Text tool (Text tab):** raised or engraved text on any face or on a point you click. Text can lie flat or stand on a side, be straight, follow an arc, or wrap around a cylinder. You set letter height, depth, rotation, spacing and multi-line layout, and it sticks to the surface when sliders change.
- **Fonts:** bundled open-licence fonts (Roboto, Inter, Montserrat, Oswald, Bebas Neue, Black Ops One, Allerta Stencil, Pacifico, Lobster, Roboto Mono) plus every TTF/OTF font installed on the computer, shown with live previews.
- **Through Claude:** `H.text`, `H.textSolid` and `H.wrapAroundZ`, plus `text` parameters, cover anything the tool can't do (twisted, tapered, stencil, per-letter effects).

## Print settings and validation

- **Print tab:** layer height, walls, top/bottom layers, infill % and pattern, supports and brim, for the whole model or per part. The baseline is Bambu Lab A1, PLA, 0.20 mm Standard. Claude suggests changes where the design needs them (e.g. more walls for a hook, supports for an overhang), and your overrides win.
- **Validate** (and automatically on every export) checks the high-resolution mesh: fits the printer, holes and non-manifold edges, flipped or inside-out faces, floating parts and pieces in mid-air, contact with the plate, tall narrow parts, overhangs that need supports, walls too thin to print, overlapping parts. Supports and brim from the print settings are taken into account.

## Export

- **STL** (default): a single mesh.
- **3MF:** one named object per part, positioned exactly as in the viewer and centred on the A1 bed. Options:
  - **Colours:** each part keeps its colour, and Bambu Studio maps the colours onto AMS filaments.
  - **Print settings:** a Bambu Studio project with the A1 / PLA / 0.20 mm profile and your print settings (model-wide and per part). The template is built from your own Bambu Studio install the first time and cached in `data/bambu/`; nothing from Bambu is bundled.
- **Blender (.blend):** built by your installed Blender in the background. It has one object per part with materials, millimetre units, a *Dimensions* collection, parameter values as custom properties, and the model script embedded.

Every export re-evaluates the model at high resolution and validates exactly that mesh. Problems are reported, not blocking.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | API server port |
| `API_PORT` | `8787` | Where the Vite dev server proxies `/api` (set it with `PORT`) |
| `JIG_DATA` | `./data` | Designs, workspaces, Bambu template cache |
| `JIG_USE_API_KEY` | off | `1` to use `ANTHROPIC_API_KEY` instead of the subscription |
| `CLAUDE_PATH` | bundled | Claude Code executable for the Agent SDK |
| `BAMBU_STUDIO_PATH` | `bambustudio` on `PATH` | Bambu Studio executable |
| `BLENDER_PATH` | `blender` on `PATH` | Blender executable |
| `DEBUG_AGENT` | off | Print the Claude Code process's stderr |

## License

Copyright (C) 2026 3dprogramin.

Jig's own code is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), see [LICENSE](LICENSE). You may use, change and share it; if you share a changed Jig, or run a changed Jig as a service other people use over a network, you must offer them its source code under the same licence.

**Additional permission under AGPL-3.0 section 7:** if you modify Jig, or any covered work, by linking or combining it with `@anthropic-ai/claude-agent-sdk` or the Claude Code executable (or a modified version of either), containing parts covered by Anthropic's terms, the copyright holder grants you additional permission to convey the resulting work. The source for those parts is not required as part of Jig's Corresponding Source.

Other licences (for example for a hosted or closed-source use of Jig) can be had from the copyright holder: andrei@3dprogramin.io.
