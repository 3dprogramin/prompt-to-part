// Settings from the environment, read once. Paths are resolved from the Jig folder rather than the
// working directory, so the server also works when started from somewhere else.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Secrets such as ELEVENLABS_API_KEY can live in .env next to package.json (git ignores it);
// variables already set in the environment win.
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
export const PORT = Number(process.env.PORT ?? 8787);
/** Designs, workspaces and the Bambu template cache. */
export const DATA_DIR = process.env.JIG_DATA ? path.resolve(process.env.JIG_DATA) : path.join(ROOT, 'data');
/** Serve the built app from dist/ as well as the API (`npm start`). */
export const PRODUCTION = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
/** Bill generations to ANTHROPIC_API_KEY instead of the Claude plan the `claude` CLI is logged in with. */
export const USE_API_KEY = process.env.JIG_USE_API_KEY === '1';
