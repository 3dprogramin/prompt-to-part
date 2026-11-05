# prompt-to-part

[![CI](https://github.com/3dprogramin/prompt-to-part/actions/workflows/ci.yml/badge.svg)](https://github.com/3dprogramin/prompt-to-part/actions/workflows/ci.yml) [![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

**Describe it. Print it.** Describe what you want to 3D print, in plain words and with photos if you have them. prompt-to-part designs a parametric model with sliders and real dimensions, checks that it prints, slices it, tells you what it costs to print and exports a ready-to-print Bambu Studio project or an STL.

![prompt-to-part in 40 seconds: asked for a desk stand for a Galaxy S25 Ultra with a cable slot, it looks up the phone's size, builds a parametric stand and shows what the reply cost ($0.58); dragging the sliders changes the model live, and slicing in Bambu Studio gives the print time, grams and cost ($1.43)](docs/demo.gif)

## What it makes

- **Parts that fit real things:** phone and tablet stands, clips, mounts, hooks, boxes, organisers. It looks up the product's dimensions on the web, adds the clearances a print needs and tells you where every number came from.
- **Pictures you can print:** line art wall pieces and key holders, LayerTone (filament painting) pictures and lithophane night lights, from a photo or just a description.
- **Plaques, signs and figures:** reliefs drawn by an image model, raised text and logos, and sculpted figures made with [Meshy](https://www.meshy.ai).
- **Checked before you print:** while it designs, it renders its model, looks at it and tries the sliders at their limits, and doesn't hand it over until those builds pass (or it explains why one can't). On every export it checks the mesh for holes, floating pieces, overhangs that need supports and walls too thin to print (see [Print settings and validation](docs/using.md#print-settings-and-validation)).
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

`docker compose down -v` also deletes the volumes, and with them every design: back them up first (Designs → Export all designs). More in [Docker](docs/running.md#docker).

Without Docker: Node 22.12+ and pnpm (`npm install -g pnpm`), then `pnpm install && pnpm build && pnpm start` (see [Run without Docker](docs/running.md#run-without-docker)). That's fine for development, but for everyday use prefer Docker.

### Why Docker

prompt-to-part runs code an AI wrote and reads web pages it found, and either could be made to misbehave: a web page can carry instructions meant for the AI, and an attached file can be built to attack the program that opens it. The app has its own walls against this: Claude may only read and write the design's script and fetch public web pages (no shell, no other files), and the scripts it writes run in a locked-down sandbox with no access to your files or the network (see *Sandbox* under [How it works](docs/how-it-works.md#how-it-works)).

Without Docker, though, prompt-to-part and the programs it starts (Claude Code, Bambu Studio, Blender) run as you, with access to everything your account can reach: your files, SSH keys, browser data and other projects. If anything ever gets past the app's walls, through a bug in the app, in one of those programs or a trick nobody has thought of yet, it lands there. In Docker it lands in a container that runs as an unprivileged user, with a read-only file system, no extra privileges and nothing of yours but prompt-to-part's own data and the keys in `.env`.

Worth adding to `.env` too:
- `OPENROUTER_API_KEY` for anything with pictures: line art, LayerTone and lithophanes from a description, AI artwork and product photos.
- `PTP_WITH_BAMBU=1` to build Bambu Studio into the image, for slicing, cost and 3MF print settings.
- `MESHY_API_KEY` for sculpted 3D figures.

prompt-to-part has no login: anyone who can reach it can use your keys, so Docker publishes it on this computer only. To open it from other devices, set a password first (see [Docker](docs/running.md#docker)).

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

## Built by 3dprogramin

prompt-to-part is made by [3dprogramin](https://3dprogramin.io), a small software company in Cluj, Romania. Want a custom version, a hosted setup for your team, or an AI tool like this one built for your own work? Write to andrei@3dprogramin.io.

## Documentation

- **[Running prompt-to-part](docs/running.md)**: Docker in detail (data, backups, updates, Bambu Studio and Blender), and running it without Docker for development.
- **[Configuration](docs/configuration.md)**: The settings in `.env` and how to connect Claude (an Anthropic key, OpenRouter or another provider).
- **[Using prompt-to-part](docs/using.md)**: Designs and versions, the chat, the viewer, print settings, cost and export.
- **[Pictures](docs/pictures.md)**: AI artwork, LayerTone, lithophanes and line art, and product photos for a shop.
- **[3D models, text and SVG](docs/3d-models.md)**: Imported meshes, AI figures with Meshy, and raised or engraved text and SVG.
- **[How it works](docs/how-it-works.md)**: How a reply runs: the agent, the tools, the sandbox and the checks.

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
