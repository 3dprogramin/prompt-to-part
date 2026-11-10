# Configuration

The settings in `.env` and how to connect Claude (an Anthropic key, OpenRouter or another provider). Back to the [README](../README.md).

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
| `PTP_MODEL` | `fable` | The model the chat starts with: `fable`, `opus`, `sonnet`, `haiku` or a full ID such as `claude-opus-5-5` (the chat's model menu still switches) |
| `PTP_EFFORT` | `high` | The reasoning effort the chat starts with (`low` … `max`) |
| `PTP_CURRENCY` | `USD` | The currency of the Cost tab and the price suggestion: any ISO 4217 code (`EUR`, `GBP`, `RON`…) |
| `PTP_COUNTRY` | none | Where you sell, so the price suggestion fits that market (e.g. `Romania`) |
| `PTP_IMAGE_MODEL` | `google/gemini-3.1-flash-image` | The OpenRouter image model for AI artwork and product photos |
| `MESHY_API_KEY` | | Turns on 3D figures (Meshy) |
| `PTP_MESHY_MAX_PER_REPLY` | `2` | Most Meshy models (`generate_3d`) prompt-to-part may make in one reply |
| `MESHY_BASE_URL` | `https://api.meshy.ai/openapi` | Another Meshy endpoint, e.g. the mock (`pnpm mock:meshy`): `http://127.0.0.1:8790/openapi` |
| `PTP_IMAGE_FALLBACK` | `google/gemini-nano-banana-2.1` | Used when the image model stays busy (rate-limited upstream) after two retries; empty turns it off |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | | Instead of the key: a token and base URL of an Anthropic-compatible provider |
| `PTP_AUTH` | `api-key` | `subscription` uses the Claude account the `claude` CLI is logged in with (or `CLAUDE_CODE_OAUTH_TOKEN`) instead of a key, for your own use on your own computer only (see [Claude subscription](#claude-subscription)) |
| `CLAUDE_CODE_OAUTH_TOKEN` | | With `PTP_AUTH=subscription`: a long-lived token from `claude setup-token`, how prompt-to-part signs in to your subscription in Docker. Ignored in API-key mode |
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

prompt-to-part needs an API key for Claude (or, for your own use only, your [Claude subscription](#claude-subscription)). The simplest is OpenRouter: set `OPENROUTER_API_KEY` in `.env` (or the environment), and prompt-to-part runs Claude through OpenRouter's Anthropic-compatible endpoint and uses the same key for AI artwork. Or set `ANTHROPIC_API_KEY` to use Anthropic directly (it wins for Claude when both are set). An Anthropic-compatible provider works too, through `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, with `ANTHROPIC_API_KEY` set but empty. For [OpenRouter](https://openrouter.ai/docs/guides/guides/claude-code-integration): `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, your OpenRouter key in `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY=` (see `.env.sample`). A design whose Claude session was started another way (with another provider, say) can't continue it through a different provider: its next message starts a fresh session with a summary of the conversation, and later messages continue that one. Without either, prompt-to-part doesn't start Claude: the chat box says what is missing, and it never falls back to a Claude account logged in on the computer.

With an API key, each reply's header shows what it cost after its time (*12 steps · 1 min 15 s · $0.30*): Claude Code's estimate of the Claude API usage, without AI pictures or Meshy. A design continuing a conversation from before prompt-to-part kept this total shows no cost for its next reply. If the API refuses the key or token (HTTP 401 or 403), the reply stops at once and says which variable to check, instead of retrying.

**Other models through OpenRouter.** With `OPENROUTER_API_KEY` (and no Anthropic key), the model menu under the chat offers OpenRouter's models that can use tools: the newest of the well-known families first (Claude, Kimi, DeepSeek, Gemini, GPT, GLM, Grok, Qwen Coder), with each one's price per million input and output tokens, then a search box and *Show more* for the rest. `PTP_MODEL` may name one too (for example `PTP_MODEL=deepseek/deepseek-v4.1-flash`). Only Claude is tested: other models may handle the tools, pictures and long designs worse, and the reasoning effort may do nothing for them. Their cost in a reply's header uses OpenRouter's prices for the tokens used, since Claude Code prices only Claude models. With an Anthropic key the menu has Claude's models only.

The chip in the top bar shows what prompt-to-part runs Claude on (*OpenRouter API*, *Anthropic API*, *Custom API*, *Claude subscription*, or *No Claude access* when no key is set) with a green dot when that service answers and a red one when it doesn't (hover for why). For OpenRouter it also shows the credit left, and for a subscription how much of the nearer limit (5-hour or weekly) is used. It checks on load, every 5 minutes and when a reply ends, and clicking it checks again; no check spends model usage.

## Claude subscription

`PTP_AUTH=subscription` makes prompt-to-part use the Claude account the `claude` CLI is logged in with (`claude` → `/login`), or the token in `CLAUDE_CODE_OAUTH_TOKEN`, instead of a key. That is meant only for running prompt-to-part yourself, on your own computer, with your own account. Anthropic's terms do not allow third-party developers to offer claude.ai login, or to route requests through Free, Pro or Max plan credentials on behalf of their users, without approval. See the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). If you share or host prompt-to-part for other people, use API keys.

In subscription mode Claude never runs through OpenRouter or an API key, even when they are set (`OPENROUTER_API_KEY` is still used for AI artwork and product photos), and replies show no cost.

**In Docker.** The container has no `claude` login of its own, and mounting your `~/.claude` into it could sign your computer out (the two would rotate the same login). Instead, make a long-lived token for it, once:

1. On your computer, with Claude Code installed and logged in to your Claude account: `claude setup-token`, and follow the steps. It prints a token starting with `sk-ant-oat01-`.
2. In `.env`: `PTP_AUTH=subscription` and `CLAUDE_CODE_OAUTH_TOKEN=<the token>`.
3. `docker compose up -d` (restarts prompt-to-part with the new settings), then send a message in a design to check that Claude answers.

If the token expires or is revoked, the chat says so: make a new one the same way.
