import { createApp } from './app';
import { DATA_DIR, HOST, PORT } from './config';
import { geometry } from './geometry';

geometry.warmup();
createApp().listen(PORT, HOST, () => {
  console.log(`Jig server on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
});
