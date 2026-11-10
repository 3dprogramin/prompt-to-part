# Running prompt-to-part

Docker in detail (data, backups, updates, Bambu Studio and Blender), and running it without Docker for development. Back to the [README](../README.md).

## Docker

The [Quick start](../README.md#quick-start) gets it running; this is everything after that. A single container serves the app and its API (the production build, as `pnpm start` does). The image is built on your computer: it installs the app's dependencies with `pnpm install --frozen-lockfile` (Claude Code among them) and never contains `.env`, `data/` or any credentials.

**Ports and other devices.** prompt-to-part has no login by default, so whoever can reach its port can use your API keys. Compose therefore publishes it on `127.0.0.1` only. To reach it from other devices (`PTP_BIND=0.0.0.0` and this computer's address in `PTP_HOSTS`), also set `PTP_PASSWORD` in `.env`: the browser then asks for it once (any user name). It is plain HTTP, so only on a network you trust, or behind an HTTPS reverse proxy. Don't publish the image to a registry either (it contains Claude Code and, with the Bambu option, Bambu Studio, which are not prompt-to-part's to redistribute). `PTP_PORT` in `.env` changes the port (default 8787); the container then listens on that port too, because prompt-to-part only answers requests addressed to its own port.

**Data.** Everything the app keeps is in three named volumes, so it survives rebuilds and `docker compose down`:

| Volume | In the container | |
|---|---|---|
| `prompt-to-part_data` | `/data` (`PTP_DATA`) | Designs, chat images, workspaces, the Bambu template and slicer data, cost settings |
| `prompt-to-part_claude` | `/home/node/.claude` | Claude Code's sessions (follow-up messages continue the conversation) and settings |
| `prompt-to-part_cache` | `/app/node_modules/.cache` | The OpenSCAD engine (downloaded and hash-checked the first time a `.scad` file is used) and the app's bundled workers |

**Backing up your designs.** `docker compose down -v` deletes the volumes, and with them every design, so keep a backup. In the **Designs** menu, **Export all designs** downloads one zip (`prompt-to-part-designs-<date>.zip`) with every design, its chat images and meshes, your cost settings and your filaments. **Import designs…** adds the designs from such a zip, in this copy of prompt-to-part or another one (it works outside Docker too), or the one design of a zipped project from *Export project…* (see [Export](using.md#export)). A design that is already there is kept as it is, never overwritten, even by a newer copy: delete it first to take the zip's. Settings are restored only where none are saved yet. Workspaces, Claude sessions and the Bambu caches are not in the zip.

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

This is meant for development. For everyday use prefer [Docker](#docker): without it the app and the programs it starts run as you, with access to your files (see [Why Docker](../README.md#why-docker)).

Requires Node 22.12+ (developed on Node 26; `nvm use` picks it from `.nvmrc`), [pnpm](https://pnpm.io) (the version in `package.json`'s `packageManager`; Node 26 comes without Corepack, so install it with `npm install -g pnpm`) and an OpenRouter or Anthropic API key (copy `.env.sample` to `.env` and fill it in). For Claude to read PDFs it finds on the web (a datasheet, say), install poppler (`apt-get install poppler-utils`, `brew install poppler`); the Docker image has it. `pnpm build` needs the dev dependencies (`pnpm install` installs them). `pnpm start` serves whatever is in `dist/`; it warns when `dist/` is missing or older than the source code.

Optional:
- **Bambu Studio** (2.x) for Bambu project 3MF export, and for the printer list (every Bambu Lab printer and nozzle, and your own printer presets).
- **Blender 4.1 or newer** for `.blend` export.

Both are found on `PATH` and in their default install folders on macOS (`/Applications`) and Windows (`Program Files`). Otherwise set `BAMBU_STUDIO_PATH` / `BLENDER_PATH`. prompt-to-part is developed and tested on Linux.

`pnpm dev` does not restart the API server when its code changes, because a restart kills every running generation. Restart it yourself once nothing is generating.
