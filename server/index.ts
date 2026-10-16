import { createApp } from './app';
import { DATA_DIR, PORT } from './config';
import { geometry } from './geometry';

geometry.warmup();
createApp().listen(PORT, '127.0.0.1', () => {
  console.log(`Jig server on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
});
