// Worker threads don't inherit tsx's loader, so register it before loading the TS worker.
import { register } from 'tsx/esm/api';
register();
await import('./geometry-worker.ts');
