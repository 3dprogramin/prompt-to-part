# AI Designer

AI-powered parametric CAD for 3D printing. Describe an object (and/or attach photos). Claude writes a parametric model with sliders and dimension callouts, checks it, looks at renders of it, and stress-tests every slider. You tweak it live and export STL.

Uses your **Claude Code subscription** through the Claude Agent SDK. No API key is needed, and `ANTHROPIC_API_KEY` is ignored unless `AI_DESIGNER_USE_API_KEY=1`.

## Run

```sh
npm install
npm run dev          # http://localhost:5173  (API on :8787)
# or
npm run build && npm start   # single server on http://127.0.0.1:8787
```

Requires Node ≥ 20.19 and a logged-in `claude` CLI (`claude` → `/login`).

## How it works

- **Geometry**: [manifold-3d](https://github.com/elalish/manifold) (WASM), which gives robust booleans and watertight STL. Model scripts are plain JS (`meta`, `params`, `build(p)`) evaluated in a Web Worker for the live preview, and in a Node worker thread for validation.
- **Agent loop** (`server/agent.ts`): Claude can only Read/Write/Edit one file (`data/workspaces/<id>/model.js`) and call three tools:
  - `evaluate_model`: errors with line numbers, bounding boxes, volumes, disconnected-piece and build-plate checks
  - `render_model`: a software-rendered ISO/front/right/top sheet with a mm grid, so Claude can compare against your photos
  - `submit_model`: evaluates every slider at its min and max, and rejects the model if any combination breaks
- **System prompt**: `server/systemPrompt.ts` covers conventions (mm, Z-up, on the bed), the API reference, the helper library and printability rules.
- **Helpers** (`shared/runtime.ts`): helical sweep (springs, corkscrews), ISO threads and threaded-hole cutters, radial surfaces (knurling), sweeps/tubes, lofts, rounded boxes, arrays.
- **Designs** are saved as JSON in `data/designs/`, with chat history, versions (restorable) and slider values. Follow-up prompts resume the same Claude session.

## Viewer

Orbit/pan/zoom, view presets, ortho camera, bounding-box dimensions, AI feature callouts, a click-to-measure tool with vertex snapping, a section plane, per-part visibility, and draft/normal/high preview quality. Export always re-evaluates at high quality.

## License

Copyright (C) 2026 3dprogramin.

Jig's own code is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), see [LICENSE](LICENSE). You may use, change and share it; if you share a changed Jig, or run a changed Jig as a service other people use over a network, you must offer them its source code under the same licence.

**Additional permission under AGPL-3.0 section 7:** if you modify Jig, or any covered work, by linking or combining it with `@anthropic-ai/claude-agent-sdk` or the Claude Code executable (or a modified version of either), containing parts covered by Anthropic's terms, the copyright holder grants you additional permission to convey the resulting work. The source for those parts is not required as part of Jig's Corresponding Source.

Other licences (for example for a hosted or closed-source use of Jig) can be had from the copyright holder: andrei@3dprogramin.io.
