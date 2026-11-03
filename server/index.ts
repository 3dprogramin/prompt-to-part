import { createApp, endGenerations } from './app';
import { DATA_DIR, HOST, PASSWORD, PORT } from './config';
import { isLoopback } from './auth';
import { geometry } from './geometry';

geometry.warmup();
createApp().listen(PORT, HOST, () => {
  console.log(`Jig server on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  // In Docker the container listens on 0.0.0.0 and JIG_PUBLISHED (JIG_BIND, set by docker-compose.yml) says
  // where it is published: only that tells whether other computers can reach it.
  const exposed = process.env.JIG_PUBLISHED?.trim() || HOST;
  if (!PASSWORD && !isLoopback(exposed)) console.warn(`[jig] Listening on ${exposed} without JIG_PASSWORD: anyone who can reach port ${PORT} can use Jig and your API keys. Set JIG_PASSWORD in .env.`);
});

// Docker stops the container with SIGTERM (and kills it 10 s later): running replies are ended
// with a note first, so their pages show at once that Jig stopped (and why).
process.once('SIGTERM', () => {
  void endGenerations('The Jig server is restarting, so Jig stopped before finishing. Send "continue" once it is back to pick up where it stopped.')
    .finally(() => setTimeout(() => process.exit(0), 200));
});
