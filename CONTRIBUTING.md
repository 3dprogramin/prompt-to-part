# Contributing to Jig

Thanks for helping. Bug reports, ideas, print results and code are all welcome.

## Reporting a bug or an idea

Open an issue with:

- what you asked Jig for (the prompt, and any photo, SVG or model you attached, if you can share it),
- what happened and what you expected,
- a screenshot of the design, and the reply's steps (click the step line, or *activity*) when it is about a generation,
- how you run Jig (Docker or `npm start`, your OS, Node version, and whether Claude runs on an Anthropic key, OpenRouter or a subscription).

Never paste API keys, tokens or your `.env` into an issue.

**Security problems** (a way for a model script, a web page or an attachment to escape the sandbox, reach your files or network, or leak a key): don't open a public issue. Email andrei@3dprogramin.io instead.

## Running Jig for development

```sh
nvm use                  # Node 26 from .nvmrc (22.12+ works)
npm install
cp .env.sample .env      # then set ONE way to run Claude (an Anthropic or OpenRouter key)
npm run dev              # http://localhost:5173, API on :8787
```

`npm run dev` does not restart the API server when its code changes, because a restart kills running generations; restart it yourself once nothing is generating (or use `npm run dev:watch`). For 3D figures without Meshy credits, run `npm run mock:meshy` and point Jig at it (see the README).

## Before you open a pull request

```sh
npm run typecheck
npm test                 # unit and API tests, about 20 s
npm run test:ui          # UI smoke test in headless Chromium, when you changed the UI
```

- **Small and focused:** one change per pull request. Open an issue first for anything big, so we can agree on the approach before you spend time on it.
- **Branch from `dev`** and open the pull request against `dev`; `main` is the stable branch.
- **Match the code around you:** its naming, comment style and density, and helpers already in `shared/`. Comments say why, not what.
- **Tests:** add or update a test in `test/` for a bug fix or a new behaviour. Keep them light: small models, no long browser runs.
- **Model scripts are untrusted code.** Changes to the sandbox (`shared/sandbox.ts`), the geometry process (`server/geometry*.ts`) or the API's checks (host, origin, `X-Jig`) need a clear reason and tests.
- **The app is called Jig in everything users see** (replies, prompts, UI), and filament painting is *LayerTone*.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(lineart): add a square brush`, `fix(export): keep part colours in the 3MF`, `docs: …`, `test: …`.
- **Update the README** when you change how something works or add a setting.

## Licence of your contribution

Jig is licensed under the [GNU AGPL-3.0](LICENSE) (version 3 only), and its author also offers Jig under other terms (for example as a hosted service). To keep both possible, contributions are accepted on these terms. By opening a pull request you agree that:

1. the contribution is your own work, or you have the right to submit it under these terms, and it contains no code or assets under a licence that conflicts with them;
2. your contribution is licensed under AGPL-3.0-only, like the rest of Jig;
3. you also grant 3dprogramin (andrei@3dprogramin.io) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to use, copy, modify, distribute and sublicense your contribution, and to relicense it under other terms, including commercial and closed-source ones;
4. you keep the copyright in your contribution, and may use it however you like.

If you can't agree to this (for example because your employer owns your code), say so in the pull request before it is merged.
