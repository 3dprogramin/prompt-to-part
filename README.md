# prompt-to-part

**Describe it. Print it.** Describe what you want to 3D print, in plain words and with photos if you have them. prompt-to-part designs a parametric model with sliders and real dimensions, checks that it prints, slices it, tells you what it costs to print and exports a ready-to-print Bambu Studio project or an STL.

![prompt-to-part in 40 seconds: asked for a desk stand for a Galaxy S25 Ultra with a cable slot, it looks up the phone's size, builds a parametric stand and shows what the reply cost ($0.58); dragging the sliders changes the model live, and slicing in Bambu Studio gives the print time, grams and cost ($1.43)](docs/demo.gif)

<!-- Launch videos (vault 06-JIG/launch-video.md): put the short cut (60 to 90 s, mp4 under 10 MB, dropped into GitHub's editor) here, beside or instead of the GIF, then uncomment the line below and set the YouTube link of the long tour.
▶ **[Watch the full tour](https://www.youtube.com/watch?v=VIDEO_ID)** (3 min): web search, the four tabs and every mode.
-->

## What it makes

- **Parts that fit real things:** phone and tablet stands, clips, mounts, hooks, boxes, organisers. It looks up the product's dimensions on the web, adds the clearances a print needs and tells you where every number came from.
- **Pictures you can print:** line art wall pieces and key holders, LayerTone (filament painting) pictures and lithophane night lights, from a photo or just a description.
- **Plaques, signs and figures:** reliefs drawn by an image model, raised text and logos, and sculpted figures made with [Meshy](https://www.meshy.ai).
- **Checked before you print:** while it designs, it renders its model, looks at it and tries the sliders at their limits, and doesn't hand it over until those builds pass (or it explains why one can't). On every export it checks the mesh for holes, floating pieces, overhangs that need supports and walls too thin to print (see [Print settings and validation](#print-settings-and-validation)).
- **Your printer:** any Bambu Lab printer and nozzle your Bambu Studio knows (A1, A1 mini, P1S, X1C, H2S…), or a printer preset you saved in Bambu Studio yourself. It asks on its first start and designs for it: what fits the bed, what the nozzle can print, how many filaments it loads at once.
- **Ready to print:** a Bambu Studio project with the right print settings, print time, grams and cost from your own Bambu Studio, and photos of how the print will look before it exists.

Every design stays editable: drag the sliders, type an exact size, or ask for a change in the chat.

## Quick start

The easiest and safest way to run prompt-to-part is Docker Compose: one command builds and starts everything, with nothing else to install, and it runs walled off from the rest of your computer (see [Why Docker](#why-docker)). You need [Docker](https://docs.docker.com/get-docker/) with Compose v2 (the `docker compose` command; Docker Desktop includes it) and an [Anthropic API key](https://platform.claude.com/settings/keys) (or an [OpenRouter](https://openrouter.ai/settings/keys) key).

```sh
git clone https://github.com/3dprogramin/prompt-to-part.git && cd prompt-to-part
cp .env.sample .env           # uncomment ANTHROPIC_API_KEY and paste your key
docker compose up -d --build  # builds the image (a few minutes the first time) and starts the app
```

Open http://localhost:8787 and describe what you want to print. Your designs live in a Docker volume, so they survive restarts and updates.

| | |
|---|---|
| Stop the app | `docker compose down` |
| Start it again | `docker compose up -d` |
| Update to the latest version | `git pull && scripts/rebuild.sh` (waits until no reply is running) |
| See what it is doing | `docker compose logs -f app` |
| Use another port | `PTP_PORT=8000` in `.env`, then `docker compose up -d` |

`docker compose down -v` also deletes the volumes, and with them every design: back them up first (Designs → Export all designs). More in [Docker](#docker).

Without Docker: Node 22.12+ and pnpm (`npm install -g pnpm`), then `pnpm install && pnpm build && pnpm start` (see [Run without Docker](#run-without-docker)). That's fine for development, but for everyday use prefer Docker.

### Why Docker

prompt-to-part runs code an AI wrote and reads web pages it found, and either could be made to misbehave: a web page can carry instructions meant for the AI, and an attached file can be built to attack the program that opens it. The app has its own walls against this: Claude may only read and write the design's script and fetch public web pages (no shell, no other files), and the scripts it writes run in a locked-down sandbox with no access to your files or the network (see *Sandbox* under [How it works](#how-it-works)).

Without Docker, though, prompt-to-part and the programs it starts (Claude Code, Bambu Studio, Blender) run as you, with access to everything your account can reach: your files, SSH keys, browser data and other projects. If anything ever gets past the app's walls, through a bug in the app, in one of those programs or a trick nobody has thought of yet, it lands there. In Docker it lands in a container that runs as an unprivileged user, with a read-only file system, no extra privileges and nothing of yours but prompt-to-part's own data and the keys in `.env`.

Worth adding to `.env` too:
- `OPENROUTER_API_KEY` for anything with pictures: line art, LayerTone and lithophanes from a description, AI artwork and product photos.
- `PTP_WITH_BAMBU=1` to build Bambu Studio into the image, for slicing, cost and 3MF print settings.
- `MESHY_API_KEY` for sculpted 3D figures.

prompt-to-part has no login: anyone who can reach it can use your keys, so Docker publishes it on this computer only. To open it from other devices, set a password first (see [Docker](#docker)).

## What it costs

prompt-to-part itself is free. You pay the AI services you use, with your own keys, and each reply shows what its Claude part cost. One design of each kind, with Claude Opus 5.5 at high effort (the default):

| Design | Time | Claude | Pictures and figures |
|---|---|---|---|
| A 90 mm coaster with a rim | 22 s | $0.15 | |
| A change to it ("make the rim 2 mm") | 26 s | $0.10 | |
| A cable clip for a 6 mm cable, one screw | 1 min 17 s | $0.30 | |
| A 60 × 40 × 30 mm box with a sliding lid | 1 min 40 s | $0.37 | |
| A stand for a named phone (looks up its size on the web) | 4 min 47 s | $0.87 | |
| A line art key holder with a car | 42 s | $0.21 | 1 picture, $0.07 |
| A LayerTone picture of a fox | 51 s | $0.23 | 1 picture, $0.07 |
| A lithophane night light with a foot | 1 min 5 s | $0.22 | 2 pictures, $0.14 |
| A round wall plaque with a wolf (AI artwork) | 1 min 25 s | $0.31 | 1 picture, $0.07 |
| A fox figurine on a name base (Meshy) | 2 min 8 s | $0.39 | 25 Meshy credits |

So most designs cost $0.15 to $0.40, and one that has to fit a real product, with web research, closer to $0.90. Claude Sonnet 5.5 (the model menu under the chat) costs about half: $0.07 for the coaster, $0.40 for the phone stand. Pictures are drawn by an image model on OpenRouter; a Meshy figure is 25 credits, 35 in colour.

## Docker

The [Quick start](#quick-start) gets it running; this is everything after that. A single container serves the app and its API (the production build, as `pnpm start` does). The image is built on your computer: it installs the app's dependencies with `pnpm install --frozen-lockfile` (Claude Code among them) and never contains `.env`, `data/` or any credentials.

**Ports and other devices.** prompt-to-part has no login by default, so whoever can reach its port can use your API keys. Compose therefore publishes it on `127.0.0.1` only. To reach it from other devices (`PTP_BIND=0.0.0.0` and this computer's address in `PTP_HOSTS`), also set `PTP_PASSWORD` in `.env`: the browser then asks for it once (any user name). It is plain HTTP, so only on a network you trust, or behind an HTTPS reverse proxy. Don't publish the image to a registry either (it contains Claude Code and, with the Bambu option, Bambu Studio, which are not prompt-to-part's to redistribute). `PTP_PORT` in `.env` changes the port (default 8787); the container then listens on that port too, because prompt-to-part only answers requests addressed to its own port.

**Data.** Everything the app keeps is in three named volumes, so it survives rebuilds and `docker compose down`:

| Volume | In the container | |
|---|---|---|
| `prompt-to-part_data` | `/data` (`PTP_DATA`) | Designs, chat images, workspaces, the Bambu template and slicer data, cost settings |
| `prompt-to-part_claude` | `/home/node/.claude` | Claude Code's sessions (follow-up messages continue the conversation) and settings |
| `prompt-to-part_cache` | `/app/node_modules/.cache` | The OpenSCAD engine (downloaded and hash-checked the first time a `.scad` file is used) and the app's bundled workers |

**Backing up your designs.** `docker compose down -v` deletes the volumes, and with them every design, so keep a backup. In the **Designs** menu, **Export all designs** downloads one zip (`prompt-to-part-designs-<date>.zip`) with every design, its chat images and meshes, your cost settings and your filaments. **Import designs…** adds the designs from such a zip, in this copy of prompt-to-part or another one (it works outside Docker too), or the one design of a zipped project from *Export project…* (see [Export](#export)). A design that is already there is kept as it is, never overwritten, even by a newer copy: delete it first to take the zip's. Settings are restored only where none are saved yet. Workspaces, Claude sessions and the Bambu caches are not in the zip.

To back up the whole `prompt-to-part_data` volume instead (the others can be rebuilt; without `prompt-to-part_claude`, a design's next message starts a fresh Claude session with a summary of the conversation):

```sh
docker compose run --rm --no-deps -v "$PWD:/backup" app tar czf /backup/prompt-to-part-data.tgz -C /data .    # back up
docker compose run --rm --no-deps -v "$PWD:/backup:ro" app tar xzf /backup/prompt-to-part-data.tgz -C /data   # restore
```

**Moving a local install's designs into Docker.** From the folder whose `data/` holds them (or point the first path at your `PTP_DATA`):

```sh
docker compose run --rm --no-deps -v "$PWD/data:/from:ro" app cp -r --preserve=timestamps /from/. /data/
docker compose restart app
```

The Bambu template is rebuilt by the container's Bambu Studio when its version differs. Claude sessions are not moved: a design's next message starts a fresh session with a summary of the conversation.

**Updating:** `git pull && scripts/rebuild.sh` (or `pnpm run rebuild`): it waits until no reply is being generated (and no Bambu Studio slice runs), rebuilds with `docker compose up -d --build` and waits until the app is healthy again (`--check` only says whether it is busy, `--now` skips the wait). Old images can then be removed with `docker image prune`.

**Logs:** `docker compose logs -f app` (add `DEBUG_AGENT=1` to `.env` to include Claude Code's own output). `docker compose ps` shows whether the container is healthy.

**Bambu Studio (Cost tab, 3MF print settings).** Not in the image by default, as it adds about 750 MB. To include it, set `PTP_WITH_BAMBU=1` in `.env` and run `docker compose up -d --build`. The build downloads the official Linux AppImage of a pinned Bambu Studio release from GitHub, checks it against its SHA-256 and unpacks only what its command line needs; it runs headless, with its own data folder in `prompt-to-part_data`. Only `linux/amd64` (Bambu Studio has no Linux ARM build). To use another release, pass the build arguments `BAMBU_URL` and `BAMBU_SHA256` (see the `Dockerfile`).

**Fonts.** The bundled fonts, plus DejaVu and Liberation. To list your own fonts too, uncomment the fonts line under `volumes:` in `docker-compose.yml` (it mounts a fonts folder from your computer read-only).

**Blender (`.blend` export).** Not in the image by default, as it adds about 1 GB (a 380 MB download). To include it, set `PTP_WITH_BLENDER=1` in `.env` and run `docker compose up -d --build`. The build downloads a pinned official Blender release (5.2 LTS) from blender.org and checks it against its SHA-256; the app runs it headless. Only `linux/amd64`. To use another release (4.1 or newer), pass the build arguments `BLENDER_URL` and `BLENDER_SHA256` (see the `Dockerfile`).

The container runs as a non-root user with a read-only file system (only the volumes and in-memory `/tmp` and home folder are writable), no Linux capabilities and a health check on `/api/capabilities`.

## Run without Docker

```sh
pnpm install
pnpm dev          # http://localhost:5173  (API on :8787)
pnpm dev:watch    # same, but the API server restarts on code changes (kills running generations)
# or
pnpm build && pnpm start   # single server on http://127.0.0.1:8787
pnpm test         # unit and API tests (about 20 s)
pnpm test:ui      # UI smoke test: builds, opens a design in headless Chromium (about 10 s; screenshots in PTP_UI_SHOTS)
pnpm mock:meshy   # a stand-in for Meshy's API, for 3D figures without credits (see "3D figures with Meshy")
pnpm typecheck
```

This is meant for development. For everyday use prefer [Docker](#docker): without it the app and the programs it starts run as you, with access to your files (see [Why Docker](#why-docker)).

Requires Node 22.12+ (developed on Node 26; `nvm use` picks it from `.nvmrc`), [pnpm](https://pnpm.io) (the version in `package.json`'s `packageManager`; Node 26 comes without Corepack, so install it with `npm install -g pnpm`) and an OpenRouter or Anthropic API key (copy `.env.sample` to `.env` and fill it in). `pnpm build` needs the dev dependencies (`pnpm install` installs them). `pnpm start` serves whatever is in `dist/`; it warns when `dist/` is missing or older than the source code.

Optional:
- **Bambu Studio** (2.x) for Bambu project 3MF export, and for the printer list (every Bambu Lab printer and nozzle, and your own printer presets).
- **Blender 4.1 or newer** for `.blend` export.

Both are found on `PATH` and in their default install folders on macOS (`/Applications`) and Windows (`Program Files`). Otherwise set `BAMBU_STUDIO_PATH` / `BLENDER_PATH`. prompt-to-part is developed and tested on Linux.

`pnpm dev` does not restart the API server when its code changes, because a restart kills every running generation. Restart it yourself once nothing is generating.

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
  - the API only answers the app's own pages: requests must name its host (against DNS rebinding) and come from its own origin, and writes need an `X-PTP` header. The dev server answers no cross-origin requests and never serves `data/`.
- **Agent loop** (`server/agent.ts`, `server/cadTools.ts`): Claude can only Read/Write/Edit one file (`data/workspaces/<id>/model.js`), optionally search the web, and call three tools:
  - `evaluate_model`: errors with line numbers, bounding boxes, volumes, disconnected-piece and build-plate checks
  - `render_model`: a software-rendered ISO/front/right/top sheet with a mm grid, so Claude can compare against your photos
  - `submit_model`: requires a render of the current script first and the sources of the real-world dimensions it uses (see *Dimension sources*), then evaluates the defaults and a stress test at draft quality:
    - all sliders at their minimum, then all at their maximum
    - each slider alone at its minimum and maximum
    - each switch flipped, and up to 6 options of each select

    It rejects the model if a case fails, unless Claude says the failure is unavoidable. Cases that don't fit the 20 s budget are skipped, and mixed combinations (one slider low, another high) aren't tried. Multi-part designs also need an assembly sequence and assembly pictures.
- **Web search** (a switch in the options menu, the sliders button in the chat bar; on for every design, and turning it off lasts for that design until you reload): Claude may search the web and read public pages to find exact dimensions of products you name. It puts them into parameters and tells you its sources and which numbers are estimates. Addresses on your computer or local network (localhost, private IP ranges, `.local` names, and public names that point there) are refused. A page Claude reads could still try to steer it, so turn web search off for designs you want to keep private. With it off, Claude says which dimensions come from memory.
- **Dimension sources:** when a design has to fit a real product, Claude reports where each fit-critical dimension came from: *official* (manufacturer drawing or datasheet), *distributor*, *from you*, *community* (forums, wikis, other people's models), *social media*, *the model's memory* or *estimate*. The *Model* section (Code tab) lists them with links, most trustworthy first, and marks pages Claude cited without opening; the chat shows a one-line summary coloured by the weakest source. Claude prefers official sources and adds clearances for parts that must fit (pockets, port openings, screw holes; see `server/systemPrompt.ts`).
- **Dictation** (the microphone button next to *Update*): speak instead of typing. The languages come from `ELEVENLABS_LANGUAGE` and `ELEVENLABS_SECONDARY_LANGUAGES` (see `.env.sample`); without them the language is detected. The words appear in the chat box as you speak, after anything you typed. Enter, Esc or the microphone button stops listening and keeps the text, so you can check it; the next Enter sends it. *Update* while listening stops and sends. Audio goes from the browser to ElevenLabs' realtime speech-to-text (Scribe v2 Realtime) with a single-use token from prompt-to-part's server, so your API key stays on the server. Needs `ELEVENLABS_API_KEY`.
- **Model and effort** start at Opus / High (Medium, High, X-High or Max) for every new design; a change applies to that design until you reload.
- **Follow-ups** resume the same Claude session and send what you are looking at: a screenshot of the viewer and a four-view render with your current slider values, scale, text and SVG drawings, plus a note if you restored an older version or edited the code.
- **Send my view** (a switch in the options menu, shown once there is a model; on by default, kept in this browser): off, follow-ups send only your words and notes, without the screenshot and the four-view render (the model is told it can render the design itself with `render_model`). The view lets the model see what you mean by "this", so leave it on unless you want smaller, faster requests. The approval of concept pictures (*Wait for my OK* below) never sends the view.
- **System prompt**: `server/systemPrompt.ts` covers conventions (mm, Z-up, on the bed), the API reference, the helper library, printability rules, where to take real-world dimensions from and the clearances for parts that must fit purchased ones, and print-setting suggestions (with your Bambu Studio profile as the baseline).
- **Helpers** (`shared/helpers.ts`): helical sweep (springs, corkscrews), ISO threads and threaded-hole cutters, radial surfaces (knurling), sweeps/tubes, lofts, rounded boxes, arrays, text, SVG drawings attached in the chat (`H.svg`) and imported or AI-made meshes (`H.mesh`).
- **Designs** are saved as JSON in `data/designs/`, with chat history, versions and slider values. Chat images (your photos, renders, assembly pictures) are stored once each in `data/designs/<id>/`, imported meshes in `data/designs/<id>/meshes/`. **Export all designs** (Designs menu) puts them all in one zip, and **Import designs…** brings them back (see [Backing up your designs](#docker)).

## Designs and versions

- **Designs menu:** your designs, most recent first (starred ones marked), 10 at a time with *Load more*. Type in its search box to list only the designs whose name contains the text – case and accents don't matter, Enter opens the first match.
- **Tags:** mark designs as **Product** (live or planned in your shop, green) or **Temp** (a throwaway test, dashed), or give them your own tags (e.g. *Ornamente*); a design can have several, up to 12. Set them with the tag button in a Designs menu row or next to the open design's name. The chips at the top of the menu show only one tag, the starred designs or the designs without a tag; the list can be sorted by last change, age or name. While the menu shows *Temp*, new designs get the Temp tag too (once they are saved). Tags are kept in `data/tags.json` (like the stars in `data/starred.json`), so tagging never changes a design, and they are in the backup zip.
- **Bulk actions:** tick designs in the Designs menu (shift-click ticks a range; the box at the top ticks every design listed, also those under *Load more*) to star, unstar, tag or delete them together. Deleting asks once and names them; designs with a reply running are left alone. To clear out tests: show *Temp*, tick the top box, *Delete*.
- **Tabs:** designs you open appear as tabs in the top bar, so parallel generations are one click apart. A spinner marks designs with a reply running, and a dot marks ones that finished while you were looking at another. *Close all* closes every tab except designs with a reply running (nothing is deleted). Every saved design is in *Designs*. Right-click the logo to start a new design in a new browser tab.
- **Versions:** click *v2 of 5* in the top bar to jump to any version. Gold versions are generated or your own code edits, blue ones are settings you saved. A design has one chat and one Claude session: after you jump back, the next reply knows which version you are on and works from it, and its new version is added at the end. To start over from a version without that history, use the branch button next to it (*New design from vN*): a new design with that version's script and settings, an empty chat and its own Claude session (handy for product variants). The original design stays as it is.
- **Code (Code tab):** edit `model.js` by hand, with syntax colours, and *Apply* it (Ctrl+S) to make a new version. Edits you haven't applied stay there while you look at other tabs or designs.
- **Saved settings:** when your sliders, scale, text, SVG drawings or print overrides differ from the current version, *Save as vN* appears next to it and stores them as a new version. Restoring a version brings its settings back; switching versions with unsaved changes asks whether to save them, discard them or cancel.
- **Autosave:** every change is saved to `data/designs/<id>.json` about half a second later, even if you open another design right away. There is one file per design, overwritten; autosave never creates versions.
  - If a save fails, *Not saved – retry* appears in the top bar. The unsaved copy stays in memory if you open another design, so coming back and retrying saves your changes.
  - Closing the page with unsaved changes, or while a reply is running, asks first. Closing it stops the generation.
  - Each save is numbered (`rev`). If another tab or window saved the design since this one last did, that newer copy is shown instead of being overwritten (while a reply runs on the design here, that reply's copy wins).
  - A design deleted in one tab closes in the others, and nothing saves it back.
- **Messages while a reply runs:** type and press Enter (or *Send*, next to *Stop*) and the message is queued; it goes out once the reply is done, several queued messages together as one. If the reply is stopped or fails, the queue waits for *Send now*. Queued messages show above the chat box, each with a × to drop it.
- **Questions:** ask something about the design and the reply starts with the short answer, then the explanation; the model is only changed when you ask for a change.

## Side panel

Four tabs, each with two sections one under the other (click a section's title to fold it):

- **Object:** *Parts* and *Parameters*. *Parts* lists the model's parts as a tree: show or hide each part (hidden parts stay out of the view, the exports, validation and the cost, and stay hidden with the design), select one to highlight it in the view, export one part as STL, and switch the text and SVG drawings placed on it on and off. *Parameters* has the overall size and the sliders. A slider whose parts are all hidden is greyed out: prompt-to-part measures which parts each parameter changes (building the model once per parameter with its value nudged), and model scripts can name them with `part` / `parts`.
- **Text & SVG:** the text and SVG tools.
- **Print:** print settings and the cost.
- **Code:** the model's measurements, dimension sources and console, and the script editor.

## Messages while a reply runs

While a reply runs, *Send* puts your message into it: the reply reads it at its next step (after the current tool call or thinking) and takes it into account in the same reply; it shows in the steps as "You: …", and the activity panel notes when it was read. A message that arrives just as the reply ends gets its own answer before the reply finishes. The clock button next to it (*Later*) queues the message for after the reply instead, as do SVG and OpenSCAD attachments, which prompt-to-part only takes with a new request.

## Watching a reply

The chat shows every step with its time while a reply runs, and follows new output only while you are scrolled to the bottom. Hover the working line, click it to pin, or click *activity* on any reply to open the activity panel beside the chat. It shows:
- the thinking and the reply as they stream
- `model.js` as it is typed (edits as replace/with)
- each tool call with its result and render previews
- what was sent (the full request text, your current view and the four-view render) and the full text that came back from every tool (measurements, file reads, web pages, OpenSCAD reports), under *Show the full text*

The panel follows the newest output unless you scroll up. Drag its header to move it anywhere (over the 3D view, say) and its corner to resize it; it remembers where you put it, and a double-click on the header puts it back beside the chat. Pinned on a reply that is running, it follows the running replies: it shows the live reply of whichever design you open, is hidden on designs with no reply running, stays open on a reply that has just finished, and only its × stops this. On one design it keeps what it has shown: the next reply (a queued message, say) is added below, after a line with the message that started it. Thinking arrives as Claude Code's summaries, a few sentences at a time. The live transcript is kept in memory only; after a reload the panel is rebuilt from the saved steps.

## Viewer

- **Controls:** orbit/pan/zoom, a home view (`Home` key; `F` fits from the current angle), view presets and an ortho camera.
- **Overlays:** bounding-box dimensions, AI feature callouts, a click-to-measure tool with vertex snapping, a section plane, per-part visibility and a part-colour toggle.
- **Display:** fullscreen (`U` hides the controls there) and draft/normal/high preview quality.
- **Sidebars:** `T` and `N` hide the chat and parameter sidebars; drag their inner edge to resize them (double-click it for the default width). The chat's default width fits the whole composer bar (attach, model and effort, picture mode, options, microphone, send) on one row (the options menu holds the switches web search, ask first, *Send my view* and sounds; in 3D figure mode the ▾ beside the picture mode chip holds *Colour* and *Wait for my OK*); only a width you drag is remembered, so you keep yours.

**Printer:** prompt-to-part asks which printer you have on its first start and keeps it (`data/printer.json`); the Print tab's *Change* picks another, with its nozzle and how many filaments it loads at once (1 for no AMS, 4 for one AMS or AMS lite, up to 16). The list comes from your Bambu Studio: every Bambu Lab printer with its 0.2 / 0.4 / 0.6 / 0.8 nozzle, and the printer presets you saved there yourself when they are based on a Bambu Lab printer (Bambu Studio's `user` folder, read only; `BAMBU_STUDIO_USER_DIR` points elsewhere, and Docker needs it mounted, see `docker-compose.yml`). Without Bambu Studio a short built-in list is used. The chosen printer's plate is drawn, and its bed, nozzle and kind (bed-slinger or CoreXY) drive the checks, the split pieces and prompt-to-part's instructions. The baseline print settings come from the template built per printer from your Bambu Studio (`data/bambu/templates/`), its machine preset with its own default process and Bambu PLA Basic presets. Two-nozzle printers (H2D, H2D Pro, H2C, X2D) are listed, but Bambu Studio's command line can't slice prompt-to-part's project for them yet, so they get a plain 3MF without print settings or cost.

**Editable dimensions:** double-click any X/Y/Z or callout label (or type in *Overall size*) and the app solves for the parameter value that produces exactly that size. Uniform *Scale %* is available too.

**Multi-part designs:** a layout bar switches between print, assembled and exploded layouts, and *Assemble* animates prompt-to-part's assembly sequence step by step. Replies include assembly pictures and instructions.

## Product photos

Listing photos before anything is printed: the camera button at the top right of the 3D view opens *Product photos*. prompt-to-part renders the model on its own (no grid, plate, labels, edges, section or highlight; the real part colours, or the simulated LayerTone colours, under soft studio light on a plain grey), and the image model on OpenRouter (`PTP_IMAGE_MODEL`, Gemini 3.1 Flash Image by default, about $0.06 and 10-30 s a photo; when it is busy prompt-to-part falls back to `PTP_IMAGE_FALLBACK`, Nano Banana 2.1) turns that render into a realistic photo of the printed product in a scene.

- **Redo with a change:** in an enlarged photo, write what to change ("warmer evening light", "a plant behind it") and click *Redo with this change*: the image model makes the photo again in the same setting – that photo as the scene to keep, the product from its render – and adds it beside the original. Tick *Product at the 3D view's current angle* to change how the product sits or is seen: turn the 3D view to that angle first and the product comes from a new render of it.
- **On its surface:** every photo asks for the product to rest on its surface in the surface's perspective (never floating or tilted against it), or to hang flat against the wall.
- **Scenes:** wooden table, living-room wall, kitchen counter, office desk, shelf with plants, plain studio (white sweep, e-commerce), outdoor / garden, a hand holding it (for scale), backlit at night (for lithophanes: glowing from a warm light behind, chosen for them automatically), or a custom scene you describe. The star marks the scene suggested from the design's name and the model's own description of it (wall art and signs → the wall, a vase → the shelf, a keychain → a hand). Extra wishes (light, mood, props) go in the text box under the scenes.
- **Format and camera:** 1:1, 4:5 (shop listings) or 16:9. *Best angle* frames the model from a 3/4 product angle, and shows flat prints face-on for the wall scene; *Current view* keeps the angle you turned the 3D view to. Parts you hide stay out of the photo; for multi-part designs pick the assembled layout first.
- **The prompt:** the render is the real product, so the image model is told to keep its shape, proportions, colours and any text exactly, to add or change nothing, and to keep the angle (no unseen side to invent). It gets the real size in mm from the bounding box, with a familiar comparison (a coaster, a paperback), so the scale in the scene is right, and is asked for a print, not a render: matte PLA, faint 0.2 mm layer lines, real contact shadows, natural light, shallow depth of field, no text or watermarks.
- **Gallery:** photos are saved with the design (`Design.photos`; the pictures and the renders they came from are stored with its images). Generate several in a row; each shows its progress and lands in its own design even if you open another one meanwhile. Enlarge a photo to compare it with its render, see the exact prompt, the model and the cost, download it or delete it. *Select* above the gallery picks several photos (shift-click: a range) to delete them at once.

It needs `OPENROUTER_API_KEY`. The image model is good at keeping simple shapes, colours and bold lettering, but it can still change small details or text: check a photo against its render before you list it.

## Pictures: AI artwork, LayerTone, lithophanes and line art

The picture mode chip in the chat bar (after the model picker) opens a menu that says what prompt-to-part does with pictures for a design: *3D model* (the default: people, characters and animals become 3D objects), *AI artwork* (flat colour layers: whatever the subject - a person, an animal or an object such as a car or a tommy gun - the image model draws it first and prompt-to-part builds the relief, plaque or sign around it; see *AI artwork* below), *LayerTone*, *Lithophane*, *Line art* or *3D figure* (an AI mesh, see [3D models](#3d-models-imported-meshes-and-ai-figures)). Each mode has one short line in the menu (the full text is in its tooltip); each card has an example you can open; *Line art* and *3D figure* get a ▾ beside the chip for their options: the line art's style, the figure's *Colour* and *Wait for my OK*. A design is a LayerTone print, a lithophane or line art, not more than one; follow-ups stay what the design is.

- **LayerTone (filament painting):** a picture printed flat as a thin relief (0.08 mm layers over a 0.16 mm first layer, 100 % infill), where stacked filaments swapped at set layers let the ones below show through by their TD (transmission distance), so brightness comes from height. Attach a photo, or describe one and prompt-to-part has the image model make it. By default it is as big as the printer's bed allows, 250 × 250 mm on an A1 (the picture's longer side, a frame included). prompt-to-part builds it with `H.layertone(picture, { width, maxHeight, baseHeight, border, gamma, invert, filaments, swaps })` and picks the filaments from the picture and prompt-to-part's library: up to as many as the printer loads at once (4 for one AMS or AMS lite), more only when really needed, each extra one a pause for a manual spool swap.
  - **LayerTone panel (Print tab):** the picture next to the simulated print, the filament stack bottom → top (colour, brand, TD; reorder, add, remove), automatic or manual swap layers, the layer count and filament changes. Click a filament's swatch to change it in place with the **filament picker**: *My filaments* first, a *Common* row (black, white, greys, beige, brown, red, blue, yellow, green), then the library by line (Bambu Lab PLA Basic, Matte and Silk+, eSUN PLA+) as swatch grids with search; each shows its name and TD, `~` marks an estimated TD. *Add filament* uses the same picker. *Custom colour* takes a colour, name, brand and TD, *Look up TD* finds the TD of any brand and colour on the web, and *Save as my filament* keeps it in **My filaments** (saved on the server in `data/filaments.json`, removable; prompt-to-part also gets them and prefers them when they suit the picture). Colour and TD changes show in the simulated print at once. Your setup wins over the script's; it is saved with the design and counts as a setting you can save as a version.
  - **The model sees and changes it too:** follow-ups include the setup, the measurement report lists the stack used, and the model changes filaments, order and swaps with its `set_layertone` tool: the same setup the panel edits.
  - **Preview and print:** the 3D view and prompt-to-part's renders show the simulated colours; the 3MF export and the Cost tab's slice carry the filament changes at the right layers (Bambu Studio's "change filament at layer"), with pauses beyond the filaments the printer loads at once, and without a prime tower (a change of filament once per layer needs none, and a bed-sized picture leaves no room for one; the purge goes to the chute). Bambu Studio's own preview paints each layer in its filament's solid colour, so it doesn't show the blends.
- **Lithophane (backlit photo):** a photo printed in white PLA as a panel that is thick where the picture is dark and thin where it is bright, so it shows the picture when lit from behind: night lights, frames, window panels, lamp shades. Attach a photo, or describe one and prompt-to-part has the image model make it. prompt-to-part builds it with `H.lithophane(picture, { width, minThickness, maxThickness, border, shape, angle, stand, gamma, invert })`: flat, curved (an arc of a lamp shade, `angle` degrees) or a full cylinder (its circumference is the width), with a solid frame at full thickness and an optional foot so it stands on a shelf. The thickness follows the light through PLA (Beer-Lambert, about 1/mm for white PLA), mapped so the lit panel shows the photo's tones evenly rather than with muddy mid-tones; 0.8-3 mm by default.
  - **Printing:** it stands upright as built (picture vertical), which gives the finest tones: the walls trace the thickness in X/Y instead of in whole layers. Its print settings come with it: 0.12 mm layers, 100 % infill, enough walls to fill the panel solid, a brim unless it has a foot (a cylinder puts its seam where the picture's edges meet).
  - **Preview:** the 3D view and prompt-to-part's renders show it lit from behind (thin = warm white, thick = dark and warm), and the *Lithophane* section of the Print tab shows the picture next to the lit panel (click to enlarge), *Change picture…*, its size and thicknesses, and print advice. Sizes and thicknesses are sliders under Parameters. The thickness is kept on each vertex of the mesh, so the colours survive holes and moves prompt-to-part adds.
- **Line art (wall cut-outs):** a drawing cut out as one flat piece in one colour, about 2 mm thick with 1 mm lines and a flat back, to hang with double-sided tape: a car and a motorbike on a key-holder bar, a figure in a frame, a name sign. Start from an attached SVG, an attached picture (traced into a drawing) or just a description (prompt-to-part has the image model draw it). Pick the style in the *Line art* ▾ menu beside the picture button (the button then names it): *Outline* (just the drawing), *Key holder* (standing on a bar with pegs for keys), *Framed* (in a rectangular frame), *Medallion* (in a round or oval frame), *Name sign* (on a bar with raised text) or *Desk stand* (in a slotted base for a desk or shelf); a message can ask for another. prompt-to-part builds it with `H.lineart(source, { style, width, height, thickness, lineWidth, lines, fill, minIsland, joinEnds, gap, hooks, text, shape, … })` (several drawings stand side by side, `gap` apart) and makes it printable: the drawing keeps its own line weights with lines too thin to print thickened to `lineWidth` (`lines: 'even'` redraws every line at exactly that width), loose bits are joined to the rest with short bridges so it comes out as one piece, lines that would dangle (a line or a branch held at one point only, which would lift off the wall) are joined to the nearest line within `joinEnds` mm (default 8), and specks too small to print are dropped. The image model is asked for every line to end on another line and for a few larger solid areas (window glass, tyres) that give the tape room to hold. The image model draws in a house style made for printing - bold, simplified line art like a laser-cut metal sign, with a line weight and detail set for the piece's width - and pictures are traced from their own pixels, so curves stay smooth. prompt-to-part checks the piece in a large straight-on render and counts the gaps between lines that closed up at this size (shown in the Print tab); a drawing too fine for its size is redrawn bolder rather than printed blotchy. Small fixes are made by hand: *Edit drawing* in the Print tab's Line art section opens the piece large and straight on with a brush - *Draw* adds a line (it goes through the same clean-up as the drawing's own lines) and *Erase* removes a blob or a stray bit, also what prompt-to-part drew there (a join, a bridge); *Paint* colours what is under the brush in another filament, and *Fill* (G) is its opposite: it adds material, in the piece's filament or another, only where the piece has none yet (inside an outline, the bottle a figure holds), never over its lines (a fill that touches nothing of the piece would fall off, so it is left out and the Print tab says so); *Select* (C) brushes over an area (strokes add up, Escape deselects) and *Clear edits here* takes back every hand edit there only: there the piece is as prompt-to-part made it again (lines drawn go, erased ones come back, paint and fills go), the rest stays, and it undoes like any stroke; with *Snap* on, a line starting or ending near the drawing joins it exactly, Shift draws a straight line, and Undo / Redo, zoom and pan work as in a paint app (one finger draws on a phone, two move and zoom). The strokes are a draft drawn over the piece while you work; *Done* (or Escape) saves them and the model rebuilds once (*Cancel* drops them). The edits are saved with the design, per drawing and in its own units (they stay put when the piece is resized), and are dropped when the drawing itself is redrawn (a partial change keeps them: they are drawn into the picture the image model changes, and fills stay strokes of their own, filling the new drawing where it is empty).
  - **Line art section (Print tab):** the drawing(s) it was made from, its style, size (warned when bigger than the printer's bed), thickness, line width, the bridges added (and the longest; many or long ones are flagged: ask for a more connected drawing), specks dropped, pegs, and how to print and hang it: flat, back down, in one colour (black PLA), no brim.
  - **Split into pieces:** a piece bigger than the bed (up to a whole wall) can be split into pieces that each fit it: *Off* (the default), *Auto* (the fewest pieces), a number of pieces or a grid, chosen in the Line art section (which shows how many pieces it makes: the grid's cells plus any loose bits too far from the rest of their cell to join, and *Longest join*, 30 mm by default, to join them with longer struts instead) with the whole size (type the width or the height there and the other follows the drawing; it wins over the script's sliders and their limits, ↺ goes back to the generated size), or by the model itself (`split: 'auto' | n | [columns, rows]`). The image model still draws one picture; prompt-to-part cuts the finished drawing along seams it picks through the empty space (as few lines crossed as it can, away from fine detail, each piece at most the bed less 6 mm, 250 mm on an A1, about even), runs the clean-up on each piece on its own so each holds together (a bit a seam would leave on its own goes with the piece it carries on into, bits up to about 30 mm apart are bridged inside their piece, a bare strip of bar or frame joins the next when both fit the bed), adds a dovetail where a seam crosses the bar or frame (thin lines just meet end to end), and engraves each piece's name (A1, A2, B1… - row letter from the top, column number from the left) on its back. The Print / Assembled / Exploded buttons show the pieces laid out to print or on the wall; the section lists the pieces with their sizes and a picture of how they go up, the editor shows the seams dashed, and the Bambu 3MF puts each piece on its own plate.

### Lithophane preview widget for shops

`litho/` is a separate, brand-neutral web component, `<litho-preview>`, built from prompt-to-part's lithophane code. A shop's customers upload a photo, frame it, and see the lithophane lit from behind and in 3D, all in their browser. On a Shopify product page it adds their choices and the photo to the order. A shop-only page builds the order's STL and 3MF at full resolution. `pnpm dev:litho` runs it and `pnpm build:litho` builds it to `dist-litho/`; it doesn't change prompt-to-part's own build. Setup, the API and the Shopify steps are in [litho/README.md](litho/README.md).

## 3D models: imported meshes and AI figures

prompt-to-part can work with ready-made meshes as well as with what it models itself: a figurine, an animal or a part from a file, or a sculpted figure made by [Meshy](https://www.meshy.ai). prompt-to-part then builds the design around it: a base or name plate, a flat bottom, a hole, a mount or hook, text on it, a cut in half, a hollow inside.

- **Attaching a mesh:** the paperclip (or drag and drop) takes STL (binary and ASCII), 3MF, OBJ and GLB/glTF (one file, up to 100 MB; a `.gltf` needs its buffers embedded, and compressed glTF isn't read). It is imported as soon as you attach it, and its chip shows the result (hover it for the size, triangles and repairs). Claude gets a four-view render of it and the import report, and uses it as `H.mesh(name, { height })` in the script. Typical requests: "put this on a round base with my name", "cut it in half so it prints without supports", "add a keyring loop", "make a hole for a 6 × 3 mm magnet underneath".
- **Import and repair** (`shared/meshFormats.ts`, `shared/meshRepair.ts`), in the locked-down geometry process (files are untrusted):
  - **Units and orientation:** STL and OBJ are taken as millimetres, 3MF as its unit says, glTF as metres. A file without usable units (AI tools make models 1-2 units across; an STL a few units across) is scaled so its longest side is 80 mm. glTF and OBJ are Y-up and are turned to prompt-to-part's Z-up. The mesh is stood on the bed and centred; Claude can turn it (`rotate`) if it lies on its side.
  - **Repair:** duplicate vertices are welded; broken, degenerate, duplicate and back-to-back triangles are dropped; inconsistent and inside-out faces are flipped (a sealed cavity stays one); shells that only touch along an edge or at a corner are separated; holes with clean rims are capped; loose specks are dropped and overlapping shells (separately modelled eyes, horns, the boxes of a low-poly model) are fused into one solid. Whatever still isn't a closed surface is rebuilt as a watertight solid from a signed-distance grid (inside and outside decided by rays along three axes, a majority vote, so holes don't leak) with Manifold's `levelSet`, which softens details smaller than its grid (about 0.5–1 mm). A single open sheet is refused.
  - **Simplification:** meshes over 200,000 triangles are simplified (the surface moves by a few micrometres), so sliders stay quick.
  - **The report** lists every repair in words; prompt-to-part sees it, and it shows on the attachment.
  - **Speed** (this machine): a 530,000-triangle STL imports in 3–4 s (with or without holes to close), a 940,000-triangle one in 7–8 s, and a grid rebuild of either takes about 10 s. Once imported, a 90,000-triangle mesh with a base and a hole evaluates in about 0.3 s per slider change (the repaired solid is kept between evaluations; scaling or moving it alone takes about 10 ms).
- **Storage:** each mesh is stored next to the design, in `data/designs/<id>/meshes/`, as a compact binary (`<hash>.bin`: float32 positions and uint32 triangles after a small JSON header, and an RGB colour per triangle for a coloured figure), with the original file and a picture of it. The design's values keep only an index (`$meshes`: name → file, size, triangles, source, repairs, Meshy's prompt, a coloured figure's palette). The browser fetches a mesh once (it never changes), and the server's geometry process gets it from the server like a font. *New design from vN* copies the meshes to the new design.
- **Printing advice** prompt-to-part works with: a flat bottom (trim a little off the feet or sink it into a base), a base for figures that can't stand, features ≥ 1 mm and walls ≥ 1.2 mm (small figures lose fingers and ears first), tree supports for outstretched arms, chins and tails, and hollowing (or few walls and low infill) for big figures.

### 3D figures with Meshy

Choose *3D figure* in the picture menu. prompt-to-part then has Meshy make the subject with `generate_3d({ name, prompt, from_photo })` (text to 3D, or image to 3D from the photo you attach) and builds the design around it. The steps and the activity panel show Meshy's progress (*Meshy: 42 %…*); the chat shows Meshy's preview picture with the prompt that was sent under *Details*. The model is downloaded at once, imported and repaired like an attached file, and Claude gets a four-view render and the report. Follow-ups on a design that has meshes keep the tool, so "make the fox sit" makes a new one.

- **Picture first:** with an image model (`OPENROUTER_API_KEY`), a new figure starts as a concept picture: `generate_concept({ name, subject })` has the image model draw the subject alone, full body, as a grey clay render on white (three-quarter view, even light), the way image to 3D reads a picture best. prompt-to-part shows it in the chat and asks you to approve it or say what to change; a change is a new picture (a few cents), not a Meshy model. Once you approve, `generate_3d({ name, from_concept })` sends exactly that picture to Meshy (image to 3D). A photo you attach, or asking to skip the picture, goes straight to Meshy; without an image model it is text to 3D as before. The pictures are stored with the meshes, indexed under `$concepts` (`image`: the grey picture; `painted`: its coloured version, in colour); *New design from vN* copies them too.
- **Wait for my OK** (the hand button next to *Colour*, on by default, kept in this browser): off, a reply that ends with new concept pictures (and no error) gets a countdown card under it: *Building with Meshy in 10 s · 25 credits* (35 in colour; the total and the names when there are several), with *Build now* and *Stop*. Typing a change, sending a message, opening another design or turning the switch back on stops it too. When it runs out (or on *Build now*), prompt-to-part sends *Approved - build it.* as your message, without your view, so the server's rule (no `generate_3d` from a picture drawn in the same reply) and the per-reply Meshy limit apply as for an approval you type. Only for the design open in that tab, right after its reply: never for a design that finished in the background or after a reload (`src/lib/autoBuild.ts`).
- **Only the subject:** Meshy makes the main subject(s) you asked for; bases, scenery, props and decorations are built in the script unless you ask for a Meshy-made one. At most 2 `generate_3d` calls per reply (`PTP_MESHY_MAX_PER_REPLY`): past that prompt-to-part stops and asks you, saying what another model would cost. Your next message gets a fresh allowance.
- **Credits:** the *Figure* button shows the credits left on the Meshy account (`GET /api/meshy/balance`, Meshy's free balance call, asked at most once a minute), when the mode is turned on and after a reply that made a model.

- **Single colour** (the default): prompt-to-part asks for the untextured mesh: Meshy's *preview* stage (no texturing *refine*), or image to 3D with `should_texture: false`, with `meshy-7.1` at `2k` geometry and no remeshing, which is 25 credits a model (20 + 5 for the finer geometry) and about 1-3 minutes. The description gets ", on a stable circular base, solid, printable, no thin overhangs" appended (Meshy's advice for figurines). Meshy's preview picture (`thumbnail_url`) is only shown in the chat.
- **Colour (4 filaments):** the *Colour* switch next to the *Figure* button (off by default; prompt-to-part also turns it on for one figure when you ask for it in colour, with `color: true` on its tools) makes a figure that prints in up to 4 filaments with the AMS lite:
  - **Shape and colours apart:** image to 3D infers the shape mostly from the shading, so a flat-coloured, cartoon-like picture gave smooth, low-detail models. The concept is therefore the same grey clay picture as without colour (same prompt, same detail), and then the image model paints exactly that picture (image to image: the grey picture is the reference) like a professionally painted collectible figurine: same figure, pose, framing and white background, its sculpted detail and soft shading kept, a few main colours, no text. The chat shows both, *shape* and *colours*, and you approve the pair. Flat colours aren't needed: prompt-to-part reduces the texture to 4 filaments itself (below). If the painting fails, there is only the grey picture and prompt-to-part says the colours will come from Meshy's own texturing.
  - Meshy textures the model: image to 3D with `image_url` the grey picture (the shape), `should_texture: true`, `texture_image_url` the painted picture (a data URI; left out when there is none), `texture_resolution: "2k"`, `remove_lighting: true`, `enable_pbr: false` (30 + 5 = 35 credits); text to 3D runs a *refine* task after the preview (`mode: "refine"`, `preview_task_id`, the same texture options; 25 + 10 = 35 credits). The tool texts, the limit message, the step and the *Figure* button's tooltip say 35.
  - **Reading the colour:** the GLB's base colour texture (embedded PNG or JPEG, decoded in plain JavaScript with `fast-png` and `jpeg-js`, `shared/imageDecode.ts`), times the material's base colour factor, is sampled through the UVs (`TEXCOORD_0`) at four points of each triangle (`shared/meshFormats.ts`).
  - **Through the repair:** every repaired triangle (welded, simplified, or rebuilt on the grid) takes the colour of the original surface nearest to its centre that faces the same way (a `three-mesh-bvh` BVH over the original triangles, `transferColors` in `shared/meshRepair.ts`), so a beard on a chest or a hand on the other figure keeps its own side's colour across the thin gap. The stored `.bin` keeps an sRGB colour per triangle. A 520,000-triangle model with a 2048² texture takes about 1.5 s longer to import than without colours.
  - **4 colours:** area-weighted k-means in OKLab with lightness counting 0.4 against hue and chroma (a texture's shading changes mostly the lightness, so a grey beard's highlights stay grey instead of going to a light skin), merging colours under 2 % of the surface and look-alikes (`shared/meshColors.ts`). Each triangle takes its nearest colour (a grey triangle one of the greys), then the colours are cleaned up over the surface (`cleanSlots`): three passes of an area-weighted majority filter over neighbouring triangles, then every patch of one colour under 1/10,000 of the surface (`MIN_ISLAND_SHARE`, about 1.2 mm² on a stored 80 mm figure; an eye is 1.5–2 mm²) takes the colour it borders most – fewer specks, fewer filament changes. On Meshy's real two-figure model this took the patches from 4,760 to 87 and adds about 0.25 s (136,000 triangles) to 0.7 s (466,000) to the import; each colour gets the closest filament: your own (*My filaments*) first, counted a little closer, then Bambu Lab PLA Basic and Matte, each used once, greys matched to greys. The mesh's entry in `$meshes` keeps the palette (`palette`: the model's colour, its share, its filament). The Object tab's *Filament colours* lists them: change a filament with the filament picker, or reduce the figure to 1–4 colours (clustered again in the browser from the stored colours), and see how many of the 4 AMS slots the design needs.
  - **Through the script:** `H.mesh` gives a coloured mesh its own Manifold mesh ID and each triangle its index as `faceID`; Manifold keeps both through every boolean, cut and transform, so after the script each output triangle maps back to its stored triangle and its filament (`paintOf` in `shared/runtime.ts`). Geometry the script builds has its part's colour; a part in one of the figure's filament colours shares that filament. The part gets `paint` (its filaments and each triangle's), which the 3D view, prompt-to-part's renders and the product photos draw. More than 4 filaments in the design is a warning, for you and for prompt-to-part.
  - **Export:** the Bambu Studio project paints each triangle with its filament the way Bambu Studio's own colour painting does (`paint_color` on the triangle: the filament's TriangleSelector state, `4`, `8`, `0C`, `1C` for filaments 1–4), one solid per part, with the filaments' colours in the project's settings (all PLA). Verified by slicing with Bambu Studio 2.8 (`test/bambuPaint.test.ts`: each filament prints where it is painted). With *Print in one colour* on (or *Colours (AMS)* off) there is no painting and one filament. A plain 3MF gives each triangle its filament's colour (the Materials extension); STL is geometry only.
- **Key:** set `MESHY_API_KEY` (Meshy's API needs a Pro plan; [pricing](https://www.meshy.ai/pricing)). Without it the mode says it needs one and can't be chosen. The key stays on the server (the model never gets it). A stopped generation deletes a Meshy task that hasn't started, which refunds it.
- **The mock:** `pnpm mock:meshy` starts a stand-in for Meshy's API on port 8790 (`server/meshyMock.ts`): the same endpoints, Bearer-key check, status sequence (PENDING → IN_PROGRESS with progress → SUCCEEDED, with Retry-After), errors (400, 401, 402, 404, 409, 429) and expiring download links, serving the sample models in `test/fixtures/meshes` (a figurine, or a fox, dog, cat or fish when the prompt names one) with a grey preview; a textured request (`should_texture`, or a `refine` of a finished preview, 10 credits) gets `colour-figure.glb`, a figure with UVs and an embedded four-colour texture; image to 3D also takes a `texture_image_url` (a URL or a data URI up to 20 MB, checked and recorded). Point prompt-to-part at it with `MESHY_BASE_URL=http://127.0.0.1:8790/openapi` and `MESHY_API_KEY=msy_mock`; `MESHY_MOCK_SECONDS` sets how long a task runs (12 s). Words in the prompt trigger the error paths: `FAIL`, `MODERATION`, `RESCHEDULE` (back to PENDING once), `FLAKY` (a 503 while polling), `BROKEN` (a model with holes and flipped faces); more than 10 unfinished tasks get Meshy's `429 NoMorePendingTasks`. Switching to the real Meshy is only removing `MESHY_BASE_URL` and setting your real key.
- **Samples:** `test/fixtures/meshes` holds small CC0 models (Kenney, Quaternius) without their textures, and broken variants made from them for the repair tests; `LICENSES.md` there says where each comes from.

## Text and SVG

- **Text tool (Text & SVG tab):** raised or engraved text on any face or on a point you click. Text can lie flat or stand on a side, be straight, follow an arc, or wrap around a cylinder. You set letter height, depth, rotation, spacing and multi-line layout, and it sticks to the surface when sliders change.
- **SVG tool (Text & SVG tab):** import an SVG file (a logo, an icon, artwork) and raise or engrave it on the model like text: on a face or a clicked point, with height (the width keeps the proportions), depth, offsets, rotation, and optionally wrapped around a cylinder. It sticks to the surface when sliders change, and prompt-to-part is told about it in follow-ups. For drawings in several colours you choose which colours are raised (or engraved); shapes of other colours painted on top cut through them, as they cover them in the drawing (white lettering on a red disc becomes a disc with the lettering cut out, or just the lettering). White-ish colours are left out by default, as they are usually the background. Filled shapes are imported (paths, rectangles, circles, ellipses, polygons and `<use>` copies, with their transforms and fill rules); strokes, text and embedded pictures are reported and skipped, so convert them to paths first (Inkscape: *Path → Stroke to Path* / *Object to Path*). The drawing is stored with the design as polygons (`$svg`), simplified if it is very detailed.
- **AI artwork:** for any subject drawn as artwork - people, characters, animals, portraits, scenes, and objects too (wall art, reliefs, signs) - prompt-to-part has an image model on OpenRouter (`PTP_IMAGE_MODEL`, Gemini 3.1 Flash Image by default, about $0.06 a picture) draw the artwork, instead of drawing it with shapes. prompt-to-part asks for realistic artwork posterized into a few flat colours (the filament colours prompt-to-part picks, or shades of grey) on a white background, then traces each colour into polygons and drops the background. The result is a drawing like an attached SVG (`H.svg(name, { height, colors })`), and prompt-to-part builds the design around it, each colour its own part for the AMS. It can also draw from photos you attach (a person, a pet). The picture shows in the chat and in the activity panel, with the exact prompt the image model got. It is off by default (prompt-to-part then models such subjects as 3D objects): choose *AI artwork* in the picture mode menu (the chip in the chat bar). It needs `OPENROUTER_API_KEY`.
- **SVG in the chat:** attach an SVG file to a message (the paperclip button, or drop it like a photo) and prompt-to-part gets both a picture of it and its exact shapes. Model scripts use those with `H.svg(name, { height, colors })`, which returns the drawing as a flat shape to extrude, cut out or outline, so a logo on a coaster or a badge comes out exactly as drawn rather than redrawn by eye. The colour choice works as in the SVG tool (e.g. a red disc with its white lettering cut out). Attached drawings are kept with the design (`$drawings`), so the preview, prompt-to-part's checks and the exports all use the same shapes.
- **OpenSCAD in the chat:** attach a `.scad` file (the same button, or drop it) and describe what you want from it. prompt-to-part renders it with OpenSCAD on the server, and gets its source, its Customizer parameters, the sizes of its parts and a four-view picture. It then rebuilds it as a prompt-to-part script, keeping the parameters as sliders and each `color()` as its own part unless you say otherwise. While it works it can render the original at any parameter values (`render_scad`) to compare with its own. Files are kept in the design's workspace, so later messages can still use them. Libraries that come with OpenSCAD Playground (BOSL2, BOSL, MCAD, NopSCADlib and others) work in `include`/`use`; other included files don't. The engine is downloaded the first time it is needed (about 16 MB, into `node_modules/.cache/prompt-to-part`).
- **Fonts:** bundled open-licence fonts (Roboto, Inter, Montserrat, Oswald, Bebas Neue, Black Ops One, Allerta Stencil, Pacifico, Lobster, Roboto Mono), plus every TTF/OTF font installed on the computer, shown with live previews. Installed fonts come from fontconfig on Linux and from the system font folders on macOS and Windows. A font that isn't available is reported, and the text uses Roboto Bold.
- **Through the script:** `H.text`, `H.textSolid` and `H.wrapAroundZ`, plus `text` parameters, cover anything the tool can't do (twisted, tapered, stencil, per-letter effects).

## Print settings and validation

- **Print in one colour (top of the Print tab):** a switch, saved with the design like the print settings (`$oneColour` in its values: kept through reloads, export and import, new versions and "new design from version"; a setting you can save as a version). On, everything prints in one filament while keeping the print settings: the 3MF (Bambu project and plain), the Cost tab's slice and *Export project…* (its README says "printed in one colour") have one filament, no colour painting and no LayerTone filament changes or pauses. The filament is the design's main one (the biggest part's; a coloured figure's most used, a LayerTone print's first) or one you pick from the design's filaments. The 3D view and product photos show the model in it, with a "Printing in one colour" note in the view. Off (default): one filament per colour (AMS), as before.
- **Print settings (Print tab):** layer height, walls, top/bottom layers, infill % and pattern, supports (and whether they may only stand on the plate), brim, wall order, seam, ironing and fuzzy skin, for the whole model or per part. The baseline is Bambu Lab A1, PLA, 0.20 mm Standard as your Bambu Studio defines it: once the 3MF template has been built from your install, the Print tab, prompt-to-part and the export all read their defaults from it (until then, the Bambu Studio 2.8 values). prompt-to-part suggests changes where the design needs them (e.g. more walls for a hook, supports for an overhang), and your overrides win.
- **Validate** (and automatically on every export) checks the high-resolution mesh of the parts being exported. It checks:
  - fit in the printer and contact with the plate
  - holes, non-manifold edges, flipped or inside-out faces
  - floating parts and pieces in mid-air (a sealed cavity is not one)
  - tall narrow parts, overhangs that need supports, walls too thin for the nozzle
  - overlapping parts

  Supports and brim from the print settings are taken into account.

  These are prompt-to-part's own checks, run in the browser on the exported mesh (`src/geometry/validate.ts`); no slicer is involved, so they take a moment rather than a slice. They are rules of thumb: an overhang is a face tilted down more than 45°, and a wall thinner than two nozzle widths (0.8 mm on the A1's 0.4 mm nozzle) is a warning, thinner than one an error. Bambu Studio knows more, such as bridges between two supports and your exact line widths, so it can still disagree on a borderline part; for the final word, open the 3MF in Bambu Studio and look at its preview.

## Cost

The *Cost* section of the *Print* tab works out what a print costs, from Bambu Studio's own numbers:

- **Print time and filament:** the visible parts are built at export resolution, made into the same Bambu Studio project as the 3MF export (your print settings included) and sliced by your installed Bambu Studio (`server/slicer.ts`, with its own data folder in `data/bambu/slicer-data`, so your Bambu Studio settings are untouched). The time is Bambu Studio's estimate; the grams include supports, the prime tower and purge, per filament for multi-colour prints.
- **When:** only when you press *Slice* (slicing is CPU-heavy, so opening the Print tab never starts one). A change to the parameters, hidden parts, print settings or *Print in one colour* marks the numbers as out of date; *Slice again* updates them. The current stage (building the model, preparing the project, slicing) is shown with the time since the calculation started, in the tab and in the viewer's status bar. Small models slice in a second or two; the first project needs the Bambu Studio template, which takes longer.
- **Filament cost:** grams × your price per 1 kg roll, in the currency set by `PTP_CURRENCY` (US dollars by default).
- **Electricity:** your printer's average power while printing × the print time × your price per kWh. Measure it for the real figure (a plug-in meter: the kWh a print used ÷ its hours × 1000); the A1's 1300 W rating is its peak while the bed heats, not an average.
- **Defaults:** until you enter your own, typical prices for a 1 kg PLA roll and a kWh in US dollars ($20, $0.17), euros (€20, €0.25), pounds (£18, £0.25) or lei (140, 1.45); in another currency the Cost tab asks for them. The printer's power starts at 200 W (an upper estimate for the A1, which usually averages 100 to 150 W).
- **Selling price:** *Suggest a price* sends the costs, print time, size, parts and what the item is to Claude (Sonnet, one reply, no tools), which suggests a price, a range and its reasoning. It is shown as a suggestion, not a calculation. The price is in `PTP_CURRENCY`, and `PTP_COUNTRY` (e.g. `Romania`) tells Claude where you sell, so it prices for that market.

Your prices are kept in `data/cost.json`.

## Export

Exports contain the visible parts only; hide a part to leave it out (Object tab, or the part list in the view), or export a single part as STL from the Object tab. A part's colour swatch in the Object tab opens the filament picker (your own filaments, the common colours and the library): the part then prints with that filament - in the 3D view, the 3MF's filaments, the cost and the app's own renders - instead of the colour the design chose, until you reset it (↺); the pick is kept per part name in the design. Every export rebuilds the model at high resolution and validates exactly that mesh. Problems are reported, not blocking. If the high-resolution build fails, nothing is exported and the error is shown.

- **STL** (default): a single mesh, geometry only (a coloured figure's colours are only in the 3MF; the export menu says so).
- **3MF:** one named object per part, positioned exactly as in the viewer and centred on the printer's bed. Options:
  - **Colours (AMS):** each part keeps its colour, and Bambu Studio maps the colours onto AMS filaments. A coloured figure comes painted per triangle with its filaments (see [Colour](#3d-figures-with-meshy)). It is the opposite of the design's *Print in one colour* switch (Print tab), and changes it: off, everything is one filament.
  - **Print settings:** a Bambu Studio project with the A1 / PLA / 0.20 mm profile and your print settings (model-wide and per part). Parts that touch become one object with the parts inside it. Each part keeps its own walls, infill and top/bottom layers. Supports and brim can only be set per object in Bambu Studio, so an object gets supports if any of its parts needs them, and the widest brim. With more than one filament, the prime tower goes beside the model, 10 mm from it by one of its corners (its size measured with Bambu Studio's slicer: 31 mm square for two filaments, 7.5 mm more for each further one), so a big model doesn't collide with it ("G-code conflicts"); without room beside the centred model, the model moves towards a side of the bed, and without room anywhere (a model about the size of the bed) there is no tower and the A1 purges into its chute. The Cost tab's slice uses the same project, so its time and grams include the tower. The template is built from your own Bambu Studio install the first time and cached in `data/bambu/`; nothing from Bambu is bundled.
- **Blender (.blend):** built by your installed Blender (4.1 or newer) in the background. It has one object per part with materials, millimetre units, a *Dimensions* collection, parameter values as custom properties, and the model script embedded.
- **Export project…:** everything about the design in one folder, for keeping your best designs: `model.js` (the script), `values.json` (the parameter values), `design.ptp.json` (the whole design: chat, versions, values), the STL, the 3MF (a Bambu Studio project with your print settings and the colours when Bambu Studio is installed, otherwise a plain 3MF with the colours; in one filament with *Print in one colour*), the `.blend` (only when Blender is installed), `images/` (the chat's photos and drawings, renders, product photos and the LayerTone or lithophane pictures), `meshes/` (imported meshes) and a `README.md` (the summary, overall size, parameters, print settings that differ from the profile, where the dimensions come from, the date and prompt-to-part's version). Chrome and Edge ask for a folder and create the project's folder in it, named after the design (`Name (2)` when there is one already, so nothing is overwritten); other browsers (Firefox) download it as one zip, `<name>.zip`, built off the page's main thread. A piece that fails (Blender, say) is left out and the README says why; the rest is still written. To bring the design back, choose the zip in **Designs → Import designs…** (zip the folder first in Chrome and Edge): the import reads `design.ptp.json`, `images/` and `meshes/` and leaves the other files alone.

## Configuration

Set these in the environment, or in a `.env` file next to `package.json` (copy `.env.sample`, where every setting is commented out; git ignores every `.env` file except the sample). Values already in the environment win. The API server reads `.env` only when it starts, so restart `pnpm dev` after changing it (Vite restarting itself on a `.env` change doesn't restart the API server).

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | API server port |
| `PTP_HOST` | `127.0.0.1` | The address the server listens on (`0.0.0.0` in the Docker image, which Compose publishes on `127.0.0.1` only). prompt-to-part has no login by default: set `PTP_PASSWORD` before making it reachable from other computers |
| `PTP_PASSWORD` | none | A password for every page and API call (HTTP Basic auth, any user name; the browser asks once). Set it whenever prompt-to-part is reachable from your network |
| `PTP_MAX_GENERATIONS` | `4` | Most replies prompt-to-part works on at once, over all designs; one more is refused until one finishes |
| `ELEVENLABS_API_KEY` | | Turns on dictation (the microphone button) |
| `ELEVENLABS_LANGUAGE` | detected | Main dictation language (ISO 639 code, e.g. `en`) |
| `ELEVENLABS_SECONDARY_LANGUAGES` | | Other languages you may speak, comma-separated (e.g. `ro`) |
| `API_PORT` | `8787` | Where the Vite dev server proxies `/api` (set it with `PORT`) |
| `PTP_DATA` | `data/` in the app folder | Designs, chat images, workspaces, the Bambu template and slicer data, cost settings |
| `OPENROUTER_API_KEY` | | Your OpenRouter key: Claude through OpenRouter (unless an Anthropic key is set), AI artwork and product photos |
| `ANTHROPIC_API_KEY` | | Your Anthropic API key: Claude straight from Anthropic (generations, price suggestions) |
| `PTP_MODEL` | `opus` | The model the chat starts with: `opus`, `sonnet`, `haiku` or a full ID such as `claude-opus-5-5` (the chat's model menu still switches) |
| `PTP_EFFORT` | `high` | The reasoning effort the chat starts with (`low` … `max`) |
| `PTP_CURRENCY` | `USD` | The currency of the Cost tab and the price suggestion: any ISO 4217 code (`EUR`, `GBP`, `RON`…) |
| `PTP_COUNTRY` | none | Where you sell, so the price suggestion fits that market (e.g. `Romania`) |
| `PTP_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | The OpenRouter image model for AI artwork and product photos |
| `MESHY_API_KEY` | | Turns on 3D figures (Meshy) |
| `PTP_MESHY_MAX_PER_REPLY` | `2` | Most Meshy models (`generate_3d`) prompt-to-part may make in one reply |
| `MESHY_BASE_URL` | `https://api.meshy.ai/openapi` | Another Meshy endpoint, e.g. the mock (`pnpm mock:meshy`): `http://127.0.0.1:8790/openapi` |
| `PTP_IMAGE_FALLBACK` | `google/gemini-nano-banana-2.1` | Used when the image model stays busy (rate-limited upstream) after two retries; empty turns it off |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | | Instead of the key: a token and base URL of an Anthropic-compatible provider |
| `PTP_PORT`, `PTP_WITH_BAMBU` | `8787`, `0` | Docker Compose only: the published port, and `1` to build the image with Bambu Studio |
| `PTP_BIND` | `127.0.0.1` | Docker Compose only: the address prompt-to-part is published on. `0.0.0.0` makes it reachable from your network (e.g. a phone): set `PTP_PASSWORD` too, and only on a network you trust |
| `PTP_MEM_LIMIT` | `8g` | Docker Compose only: the container's memory limit |
| `PTP_HOSTS` | none | More names prompt-to-part answers to besides `localhost` and `127.0.0.1`, comma-separated: this computer's address when it is reached from the network (with `PTP_BIND`). Requests naming any other host are refused |
| `CLAUDE_PATH` | bundled | Claude Code executable for the Agent SDK |
| `BAMBU_STUDIO_PATH` | found on `PATH` or in the default install folder | Bambu Studio executable |
| `BLENDER_PATH` | found on `PATH` or in the default install folder | Blender executable |
| `NODE_ENV` | | `production` serves `dist/` too (as `pnpm start` does with `--production`) |
| `DEBUG_AGENT` | off | Print the Claude Code process's stderr |

## Claude API key

prompt-to-part needs an API key for Claude. The simplest is OpenRouter: set `OPENROUTER_API_KEY` in `.env` (or the environment), and prompt-to-part runs Claude through OpenRouter's Anthropic-compatible endpoint and uses the same key for AI artwork. Or set `ANTHROPIC_API_KEY` to use Anthropic directly (it wins for Claude when both are set). An Anthropic-compatible provider works too, through `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, with `ANTHROPIC_API_KEY` set but empty. For [OpenRouter](https://openrouter.ai/docs/guides/guides/claude-code-integration): `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, your OpenRouter key in `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY=` (see `.env.sample`). A design whose Claude session was started another way (with another provider, say) can't continue it through a different provider: its next message starts a fresh session with a summary of the conversation, and later messages continue that one. Without either, prompt-to-part doesn't start Claude: the chat box says what is missing, and it never falls back to a Claude account logged in on the computer.

With an API key, each reply's header shows what it cost after its time (*12 steps · 1 min 15 s · $0.30*): Claude Code's estimate of the Claude API usage, without AI pictures or Meshy. A design continuing a conversation from before prompt-to-part kept this total shows no cost for its next reply. If the API refuses the key or token (HTTP 401 or 403), the reply stops at once and says which variable to check, instead of retrying.

**Other models through OpenRouter.** With `OPENROUTER_API_KEY` (and no Anthropic key), the model menu under the chat offers OpenRouter's models that can use tools: the newest of the well-known families first (Claude, Kimi, DeepSeek, Gemini, GPT, GLM, Grok, Qwen Coder), with each one's price per million input and output tokens, then a search box and *Show more* for the rest. `PTP_MODEL` may name one too (for example `PTP_MODEL=deepseek/deepseek-v4.1-flash`). Only Claude is tested: other models may handle the tools, pictures and long designs worse, and the reasoning effort may do nothing for them. Their cost in a reply's header uses OpenRouter's prices for the tokens used, since Claude Code prices only Claude models. With an Anthropic key the menu has Claude's models only.

prompt-to-part runs Claude on API keys only. Anthropic's terms do not allow third-party apps to sign in with a Claude subscription (see the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)), so prompt-to-part has no subscription mode; an old `PTP_AUTH=subscription` in `.env` is refused with a message telling you to set a key.

The chip in the top bar shows what prompt-to-part runs Claude on (*OpenRouter API*, *Anthropic API*, *Custom API*, or *No Claude access* when no key is set) with a green dot when that service answers and a red one when it doesn't (hover for why). For OpenRouter it also shows the credit left. It checks on load, every 5 minutes and when a reply ends, and clicking it checks again; no check spends model usage.

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run prompt-to-part for development, what a pull request needs and the terms contributions are accepted on.

## License

Copyright (C) 2026 3dprogramin.

prompt-to-part's own code is free software under the GNU Affero General Public License, version 3 only (AGPL-3.0-only), see [LICENSE](LICENSE). You may use, change and share it; if you share a changed version, or run a changed version as a service other people use over a network, you must offer them its source code under the same licence.

**Additional permission under AGPL-3.0 section 7:** if you modify prompt-to-part, or any covered work, by linking or combining it with `@anthropic-ai/claude-agent-sdk` or the Claude Code executable (or a modified version of either), containing parts covered by Anthropic's terms, the copyright holder grants you additional permission to convey the resulting work. The source for those parts is not required as part of prompt-to-part's Corresponding Source.

Other licences (for example for a hosted or closed-source use of prompt-to-part) can be had from the copyright holder: andrei@3dprogramin.io.

prompt-to-part depends on packages under their own licences:
- **`@anthropic-ai/claude-agent-sdk` and the Claude Code executable it installs** are proprietary and covered by [Anthropic's terms](https://www.anthropic.com/legal), not by prompt-to-part's licence. Install them with `pnpm install`; don't redistribute them (for example inside `node_modules` in an archive or image).
- **The packages bundled into the built app** (manifold-3d, SES, three.js, React and others) are MIT or Apache-2.0. `pnpm build` writes their licences to `dist/THIRD_PARTY_NOTICES.md`; keep that file with any copy of `dist/`.
- **The bundled fonts** (`@fontsource`) are under the SIL Open Font License.
- **OpenSCAD** (for `.scad` files in the chat) is GPL-2.0-or-later and not part of prompt-to-part: it downloads the [OpenSCAD Playground](https://github.com/openscad/openscad-playground) WebAssembly build from npm on first use (pinned version, checked against its hash) and runs it as a separate program on the server only. Its source is at [github.com/openscad/openscad](https://github.com/openscad/openscad); the libraries it comes with have their own licences.

prompt-to-part is an independent project. It is not affiliated with or endorsed by Anthropic, Bambu Lab or the Blender Foundation. Claude, Bambu Lab, Bambu Studio and Blender are trademarks of their respective owners.
