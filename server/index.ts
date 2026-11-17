import { createApp, endGenerations } from './app';
import { DATA_DIR, HOST, PASSWORD, PORT } from './config';
import { isLoopback } from './auth';
import { geometry } from './geometry';
import { pinLegacyBackTextOnce } from './printed';
import { initSettings } from './settings';
import { sweepDataDir } from './sweep';

// Before anything reads a key: the values set in the app are laid over the environment.
initSettings();
geometry.warmup();
// Leftovers of a crash (a half-restored backup, temp files, workspaces of designs never saved) and
// mesh uploads of chats never saved. Before listening: nothing may be using what it removes.
await sweepDataDir().then(({ removed }) => { if (removed.length) console.log(`[prompt-to-part] Removed ${removed.length} leftover file(s) from the data folder`); }, (e) => console.warn('[sweep]', (e as Error).message));
// Versions marked printed by code from before the back text keep printing without it (before any request; skipped when printed.json is as the last run left it).
await pinLegacyBackTextOnce().then((n) => { if (n) console.log(`[prompt-to-part] Turned the back text off in ${n} printed version(s) that had none`); }, (e) => console.warn('[printed]', (e as Error).message));
createApp().listen(PORT, HOST, (error?: Error) => {
  // Express 5 hands a failed listen (port taken) to this callback; the geometry process would keep the program alive.
  if (error) {
    console.error(`[prompt-to-part] Cannot listen on ${HOST}:${PORT}: ${error.message}. Is it already running, or is the port used by another program? The PORT variable changes it.`);
    process.exit(1);
  }
  console.log(`prompt-to-part server on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  // In Docker the container listens on 0.0.0.0 and PTP_PUBLISHED (PTP_BIND, set by docker-compose.yml) says
  // where it is published: only that tells whether other computers can reach it.
  const exposed = process.env.PTP_PUBLISHED?.trim() || HOST;
  if (!PASSWORD && !isLoopback(exposed)) console.warn(`[prompt-to-part] Listening on ${exposed} without PTP_PASSWORD: anyone who can reach port ${PORT} can use prompt-to-part and your API keys. Set PTP_PASSWORD in .env.`);
});

// Docker stops the container with SIGTERM (and kills it 10 s later): running replies are ended
// with a note first, so their pages show at once that the reply stopped (and why).
process.once('SIGTERM', () => {
  void endGenerations('The server is restarting, so this reply stopped before finishing. Send "continue" once it is back to pick up where it stopped.')
    .finally(() => setTimeout(() => process.exit(0), 200));
});
