import { createApp, endGenerations } from './app';
import { DATA_DIR, HOST, PORT } from './config';
import { geometry } from './geometry';

geometry.warmup();
createApp().listen(PORT, HOST, () => {
  console.log(`Jig server on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
});

// Docker stops the container with SIGTERM (and kills it 10 s later): running replies are ended
// with a note first, so their pages show at once that Jig stopped (and why).
process.once('SIGTERM', () => {
  void endGenerations('The Jig server is restarting, so Jig stopped before finishing. Send "continue" once it is back to pick up where it stopped.')
    .finally(() => setTimeout(() => process.exit(0), 200));
});
