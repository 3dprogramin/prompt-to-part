# Starter Ideas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The new-design screen shows four starters from mixed modes (each with a mode chip; a click fills the prompt and switches the mode) and a "Give me 4 new ideas" link under them that asks Claude Haiku for four fresh ideas, each with its mode, which replace the starters.

**Architecture:** Pure logic (starter list, which modes are possible, the prompt, parsing Claude's answer) lives in `shared/ideas.ts`. `server/ideas.ts` asks Claude (one turn, no tools, model `haiku`, same pattern as `server/photoScene.ts`), and `POST /api/ideas` serves it, with a stand-in injectable through `createApp` like `sceneWriter`. A small `Starters` component renders the list and the link inside `ChatPanel`'s empty-chat intro and reuses `tryRequest`.

**Tech Stack:** TypeScript, Express 5, React 19, `@anthropic-ai/claude-agent-sdk` `query`, node:test.

**Spec (approved in chat, 2026-11-04):**
- Replace the four hard-coded 3D model starters in `src/components/ChatPanel.tsx` (~lines 346-355) with four starters of mixed modes. Each shows a mode chip; clicking one puts its text in the prompt box and switches to its mode.
- The existing per-mode examples in the mode menu (`modeExamples.ts`, `ModeExamplePanel`) stay as they are; no new examples menu.
- Under the list, a link "Give me 4 new ideas" (placement A of the mockup). A click asks Jig for four fresh ideas, each with its mode, that replace the four on screen; clicking one behaves the same as a starter.
- Ideas show off what each mode can do.
- One quick Claude Haiku call (like the filament lookup), not the chat's model.
- Only modes that work on this setup for a text-only request: 3D model always; AI artwork, LayerTone, Lithophane and Line art only with an image model; 3D figure only with a Meshy key.
- Ideas fit the chosen printer's bed.
- While Jig thinks, the link reads "Thinking…"; on failure the starters stay and a short error line shows.
- Clicking again gives different ideas (not the ones on screen).
- The default starters are written by the builder (the most impressive example per mode) and checked by the user.

## Global Constraints

- Never the en dash (U+2013) or em dash (U+2014) anywhere: code, comments, copy, commits. Plain hyphen or rephrase.
- User-facing text says "Jig", never "Claude".
- Commits: conventional style (`feat(ui): ...`), no Co-Authored-By line. Commit on dev only; never push or tag.
- Node 26: prefix PATH with `$HOME/.nvm/versions/node/v26.7.0/bin`.
- Tests: node:test in `test/*.test.ts`, run single files with `node --import tsx --test test/<file>.ts`; servers in tests listen on port 0. Never `pkill` by name. Do not run `npm run test:ui` except where Task 3 says so.
- Before every batch of edits to server files or `App.tsx`/`ChatPanel.tsx`, run the generation gate (`/tmp/claude-1000/-home-icebox-Documents-3D-AI-ai-designer/b16b9e3b-a828-4fc4-bab9-55f24f0353e0/scratchpad/gate.sh`) in the same command, so a running generation stops the edit.

## Review Focus

1. Claude answers with a mode that is not available here (e.g. `figure` without Meshy): that idea is dropped, never shown. (Task 1 test `parseIdeas drops unavailable modes`.)
2. Claude returns fewer than four usable ideas, or none: the list is topped up from starters not on screen, and with zero usable ideas the route fails with a plain error so the old starters stay. (Task 1 `topUp`, Task 2 route test.)
3. Claude's text is long, has dashes, quotes or a numbered prefix: it is cleaned (prefix stripped, dashes replaced, clipped to 120 chars). (Task 1 `cleanIdeaText` test.)
4. The user clicks the link twice fast, or sends a first message while Jig thinks: no second request while one runs, and a late answer after the intro is gone does nothing (no state update on an unmounted component). (Task 3, by code review and the smoke step.)
5. No Claude credentials: the route answers 503 with `claudeAuthProblem()` text; the link shows it as the error line and the starters stay. (Task 2 route test.)

---

### Task 1: Ideas logic in `shared/ideas.ts`

**Files:**
- Create: `shared/ideas.ts`
- Test: `test/ideas.test.ts`

**Interfaces:**
- Produces:
  - `type IdeaMode = NonNullable<GenerateRequest['imageMode']>` (from `shared/api.ts`)
  - `interface Idea { text: string; mode: IdeaMode }`
  - `const STARTERS: Idea[]`: hand-written, at least one per mode and at least four `off` ones, in priority order (the first of each mode is that mode's showcase).
  - `function ideaModes(o: { artwork: boolean; meshy: boolean }): IdeaMode[]`: `off` always; `artwork`, `layertone`, `lithophane`, `lineart` with `artwork`; `figure` with `meshy`.
  - `function pickStarters(modes: IdeaMode[], count = 4): Idea[]`: the defaults for the screen. Preference order of modes: `off`, `layertone`, `lithophane`, `lineart`, `artwork`, `figure`; take the first starter of each available mode in that order until `count`, then fill with further `off` starters. Deterministic.
  - `function cleanIdeaText(s: string): string`: trims, strips a leading list marker (`1.`, `-`, `*`, `•`), strips wrapping quotes, replaces U+2013/U+2014 with `-` (spaced ones become `, `), collapses whitespace, clips to `MAX_IDEA_CHARS = 120` at a word boundary.
  - `function ideasPrompt(o: { modes: IdeaMode[]; bed: [number, number]; height: number; printerName: string; shown: string[] }): string`: the user prompt. Names the allowed modes with a one-line description each (reuse wording from `IMAGE_MODES` desc/hint in `src/components/chat/PictureModeMenus.tsx`, copied into a `MODE_IDEA_HINTS` record here, since shared/ must not import src/), the printer and its bed in mm, the texts already shown ("give different ones"), and asks for 4 ideas, each in a different mode when 4 or more modes are allowed.
  - `const IDEAS_SYSTEM_PROMPT: string`: who it is for (someone new to Jig, 3D printing in PLA), what a good idea is (shows off what the mode can do, concrete, with a size, one line under 120 characters, written as the user would type it), and the answer format: ONLY a JSON array `[{"text": "...", "mode": "off" | ...}]`.
  - `function parseIdeas(text: string, modes: IdeaMode[]): Idea[]`: first JSON array in `text`; keeps entries with a string `text` and a `mode` in `modes`; cleans text; drops empty and duplicate texts (case-insensitive); at most 4. Throws `Error('Jig did not come up with ideas')` when no array is found or it is not valid JSON.
  - `function topUp(ideas: Idea[], modes: IdeaMode[], avoid: string[], count = 4): Idea[]`: `ideas` first, then `STARTERS` in available modes whose text is not in `ideas` or `avoid`, until `count`.

- [ ] **Step 1: Write the failing tests** in `test/ideas.test.ts`:
  - `ideaModes`: `{artwork:false, meshy:false}` -> `['off']`; `{artwork:true, meshy:false}` -> `off, artwork, layertone, lithophane, lineart` (any order, compare sorted); `{artwork:true, meshy:true}` adds `figure`.
  - `pickStarters` with all modes -> modes `['off','layertone','lithophane','lineart']`; with `['off']` -> 4 ideas, all `off`, 4 distinct texts.
  - `STARTERS`: every text <= 120 chars, no U+2013/U+2014, no duplicates, every `IdeaMode` present at least once, >= 4 `off`.
  - `cleanIdeaText('1. "A moon lamp – 10 cm"')` -> `'A moon lamp, 10 cm'`; a 200-char input -> length <= 120, does not end mid-word.
  - `parseIdeas drops unavailable modes`: text `'Here: [{"text":"Dragon","mode":"figure"},{"text":"Moon","mode":"lithophane"},{"text":"Box","mode":"off"}]'` with modes `['off','lithophane']` -> `[{text:'Moon',mode:'lithophane'},{text:'Box',mode:'off'}]`.
  - `parseIdeas` drops duplicates and non-strings, caps at 4; `parseIdeas('no json', ['off'])` throws `/did not come up with ideas/`.
  - `topUp([{text:'Box',mode:'off'}], ['off'], [STARTERS[0].text])` -> 4 ideas, first is `Box`, none equals `STARTERS[0].text`.
  - `ideasPrompt` contains the bed (`256 x 256`), every allowed mode id, each shown text, and not a disallowed mode id.

- [ ] **Step 2: Run** `node --import tsx --test test/ideas.test.ts` -> FAIL (module not found).
- [ ] **Step 3: Implement `shared/ideas.ts`** with the interfaces above and write `STARTERS`. Showcase starters (first of each mode), as a starting point the builder may improve:
  - off: `A stackable drawer cabinet: 3 drawers on printed rails, a label slot on each front`
  - layertone: `A mountain lake at dawn with pine trees, about 15 cm wide`
  - lithophane: `The full moon as a round night light, 10 cm across`
  - lineart: `Key holder: a bicycle and a dog on a bar, hung with tape`
  - artwork: `A fox in an autumn forest as colour wall art, 20 cm wide`
  - figure: `A small dragon sitting on a rock, 8 cm tall`
  - more off (at least 3): e.g. a headphone hook clamped to a desk edge with a thumb screw, a cable clip for a 6 mm cable on a 20 mm desk edge, a hinged SD card box with 12 slots.
- [ ] **Step 4: Run** `node --import tsx --test test/ideas.test.ts` -> PASS; `node_modules/.bin/tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(ideas): starter ideas in every mode, and parsing Jig's new ones`

### Task 2: `POST /api/ideas` and the client call

**Files:**
- Create: `server/ideas.ts`, `server/routes/ideas.ts`
- Modify: `server/app.ts` (AppOptions + createApp + register), `src/lib/api.ts` (one export)
- Test: `test/ideas.test.ts` (route tests appended)

**Interfaces:**
- Consumes: Task 1 `ideaModes`, `ideasPrompt`, `IDEAS_SYSTEM_PROMPT`, `parseIdeas`, `topUp`, `Idea`, `MAX_IDEA_CHARS`.
- Produces:
  - `server/ideas.ts`: `async function writeIdeas(prompt: string): Promise<string>`: one `query` like `server/photoScene.ts` (`systemPrompt: IDEAS_SYSTEM_PROMPT`, `model: 'haiku'`, `tools: []`, `maxTurns: 1`, `settingSources: []`, deny-all `canUseTool`, `env: claudeEnv()`, 30 s abort timeout, `pathToClaudeCodeExecutable: process.env.CLAUDE_PATH || undefined`); throws `Jig couldn't come up with ideas (<subtype>)` on a non-success result; returns the raw text.
  - `AppOptions.ideas?: typeof writeIdeas` (doc comment: "Writes new starter ideas (tests pass a stand-in instead of Claude)"), default `writeIdeas`.
  - `registerIdeaRoutes(app, ctx, { ideas })` in `server/routes/ideas.ts`: `POST /api/ideas`, body `{ shown?: string[] }` with `json('8kb')`; `shown` must be an array of at most 8 strings each <= 200 chars, else 400. 503 with `claudeAuthProblem()` when set. Modes from `ideaModes({ artwork: artworkAvailable(), meshy: meshyAvailable() })` (same helpers as `server/routes/system.ts`); bed/height/name from `printer()` (`shared/printer.ts`). Calls `parseIdeas(await ideas(prompt), modes)`; zero ideas -> 502 `Jig did not come up with ideas`; otherwise `res.json({ ideas: topUp(parsed, modes, shown) })`. Any thrown error -> 502 with its message.
  - `src/lib/api.ts`: `export const newIdeas = (shown: string[]): Promise<Idea[]> => getJson<{ ideas: Idea[] }>('/api/ideas', { method: 'POST', body: JSON.stringify({ shown }) }).then((r) => r.ideas);`

- [ ] **Step 1: Write the failing route tests** (start `createApp({ ideas: stub, ... })` on port 0 as `test/filaments.test.ts` does; `X-Jig: 1` header):
  - stub returns `'[{"text":"Moon lamp","mode":"off"}]'` -> 200, 4 ideas, first `{text:'Moon lamp',mode:'off'}`, every mode in the available set.
  - the prompt the stub receives contains every `shown` text sent.
  - stub returns `'sorry'` -> 502, body `error` matches `/did not come up with ideas/`.
  - `shown: 'x'` -> 400; `shown` with 9 entries -> 400.
  - stub throws `new Error('boom')` -> 502 `boom`.
  - with `ANTHROPIC_API_KEY` and the other Claude env vars removed for the test (restore after), -> 503 (check how `test/api.test.ts` or `test/claudeAuth.test.ts` makes `claudeAuthProblem()` non-null and do the same).
- [ ] **Step 2: Run** `node --import tsx --test test/ideas.test.ts` -> new tests FAIL.
- [ ] **Step 3: Implement** `server/ideas.ts`, `server/routes/ideas.ts`, the `createApp` wiring (register next to `registerFilamentRoutes`), and `newIdeas` in `src/lib/api.ts`.
- [ ] **Step 4: Run** `node --import tsx --test test/ideas.test.ts test/api.test.ts` -> PASS; `node_modules/.bin/tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(ideas): POST /api/ideas asks Jig for four new ideas in the modes this setup can do`

### Task 3: The starters and the link in the chat intro

**Files:**
- Create: `src/components/chat/Starters.tsx`
- Modify: `src/components/ChatPanel.tsx` (~346-355), `src/styles.css` (next to `.example` ~174-176), `test/ui/smoke.ts` (stand-in + one step)

**Interfaces:**
- Consumes: Task 1 `Idea`, `ideaModes`, `pickStarters`; Task 2 `newIdeas`; `IMAGE_MODES` (for the chip's `short ?? label` and `icon`) from `src/components/chat/PictureModeMenus.tsx`; `Icon` from `src/components/Icon.tsx`; ChatPanel's `tryRequest(mode, request)`.
- Produces: `function Starters(p: { artworkModel: string | null; meshy: boolean; claudeProblem: string | null; onPick: (mode: ImageMode, text: string) => void }): JSX.Element`.

- [ ] **Step 1: Implement `Starters`**: state `ideas` (initial `pickStarters(ideaModes({ artwork: !!p.artworkModel, meshy: p.meshy }))`, recomputed when those two props change and no fetched ideas are on screen), `busy`, `error`. Renders the existing `.examples` container; each idea a `button.example` with a `span.idea-mode` chip (mode icon + short label) then the text; click -> `p.onPick(idea.mode, idea.text)`. Under it a `button.link-btn.more-ideas` reading `Give me 4 new ideas` (`Thinking…` while busy, disabled while busy, hidden when `p.claudeProblem`). Click -> `newIdeas(ideas.map((i) => i.text))`; success replaces `ideas`; failure keeps them and sets `error` to the message, shown as a `p.small.dim` line under the link (cleared on the next click). Ignore results after unmount (a mounted ref).
- [ ] **Step 2: Wire it in `ChatPanel.tsx`**: replace the hard-coded array block with `<Starters artworkModel={p.artworkModel} meshy={p.meshy} claudeProblem={p.claudeProblem} onPick={tryRequest} />`. Starter clicks now go through `tryRequest` (mode switch + text appended after anything typed + focus at the end), as the mode menu's "Try this request" does.
- [ ] **Step 3: Styles** in `src/styles.css`: `.example` becomes a flex row (gap 8px, align center); `.idea-mode` a small pill (11px, `var(--accent)` text, `var(--line)` border, no wrap); `.more-ideas` left-aligned, accent colour, 13px, no background. Check whether a link-style button class already exists (grep `link-btn` / `text-btn` in `src/styles.css`) and reuse it.
- [ ] **Step 4: Smoke test** in `test/ui/smoke.ts`: pass `ideas: async () => '[{"text":"A test idea for the smoke test","mode":"lithophane"}]'` to its `createApp` call; add one bounded step on a new design: the intro shows 4 `.example` buttons each with an `.idea-mode` chip; clicking `Give me 4 new ideas` shows `A test idea for the smoke test` with a `Lithophane` chip; clicking it puts the text in the prompt box and the picture mode chip reads Lithophane. Close the page in `finally` like the other steps.
- [ ] **Step 5: Verify**: `node_modules/.bin/tsc --noEmit` clean; `npm test` all pass (one skip for ELEVENLABS is expected); `npm run test:ui` all pass (run once, nothing else in parallel).
- [ ] **Step 6: Commit** `feat(ui): mixed-mode starters with their mode, and "Give me 4 new ideas" under them`
