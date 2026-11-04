# Contributing to prompt-to-part

Thanks for helping. Bug reports, ideas, print results and code are all welcome.

## Reporting a bug or an idea

Open an issue with:

- what you asked for (the prompt, and any photo, SVG or model you attached, if you can share it),
- what happened and what you expected,
- a screenshot of the design, and the reply's steps (click the step line, or *activity*) when it is about a generation,
- how you run prompt-to-part (Docker or `pnpm start`, your OS, Node version, and whether Claude runs on an Anthropic key, OpenRouter or another provider).

Never paste API keys, tokens or your `.env` into an issue.

**Security problems** (a way for a model script, a web page or an attachment to escape the sandbox, reach your files or network, or leak a key): don't open a public issue. Email andrei@3dprogramin.io instead.

## Running prompt-to-part for development

```sh
nvm use                  # Node 26 from .nvmrc (22.12+ works)
npm install -g pnpm      # once: the app uses pnpm, and Node 26 comes without Corepack
pnpm install
cp .env.sample .env      # then set ONE way to run Claude (an Anthropic or OpenRouter key)
pnpm dev                 # http://localhost:5173, API on :8787
```

`pnpm dev` does not restart the API server when its code changes, because a restart kills running generations; restart it yourself once nothing is generating (or use `pnpm dev:watch`). For 3D figures without Meshy credits, run `pnpm mock:meshy` and point the app at it (see the README).

## Before you open a pull request

```sh
pnpm typecheck
pnpm test                # unit and API tests, about 20 s
pnpm test:ui             # UI smoke test in headless Chromium, when you changed the UI
```

- **Small and focused:** one change per pull request. Open an issue first for anything big, so we can agree on the approach before you spend time on it.
- **Branch from `dev`** and open the pull request against `dev`; `main` is the stable branch.
- **Match the code around you:** its naming, comment style and density, and helpers already in `shared/`. Comments say why, not what.
- **Tests:** add or update a test in `test/` for a bug fix or a new behaviour. Keep them light: small models, no long browser runs.
- **Model scripts are untrusted code.** Changes to the sandbox (`shared/sandbox.ts`), the geometry process (`server/geometry*.ts`) or the API's checks (host, origin, `X-PTP`) need a clear reason and tests.
- **The app is called prompt-to-part where it names itself** (title, docs, server errors), with no persona: UI text and replies don't speak as "prompt-to-part" (write "Working on it", not "prompt-to-part is working"), and filament painting is *LayerTone*.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(lineart): add a square brush`, `fix(export): keep part colours in the 3MF`, `docs: …`, `test: …`.
- **Update the README** when you change how something works or add a setting.

## Licence of your contribution

prompt-to-part is licensed under the [GNU AGPL-3.0](LICENSE) (version 3 only), and its author also offers it under other terms (for example as a hosted service). To keep both possible, contributions are accepted on these terms. By opening a pull request you agree that:

1. the contribution is your own work, or you have the right to submit it under these terms, and it contains no code or assets under a licence that conflicts with them;
2. your contribution is licensed under AGPL-3.0-only, like the rest of prompt-to-part;
3. you also grant 3dprogramin (andrei@3dprogramin.io) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to use, copy, modify, distribute and sublicense your contribution, and to relicense it under other terms, including commercial and closed-source ones;
4. you keep the copyright in your contribution, and may use it however you like.

If you can't agree to this (for example because your employer owns your code), say so in the pull request before it is merged.
