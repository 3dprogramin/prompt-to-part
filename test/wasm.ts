// Starts the model sandbox and the manifold-3d runtime, as the geometry workers do. Import it
// first in tests that evaluate scripts (each test file runs in its own process).
import '../shared/sandbox';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';
import { initRuntime, instantiateWith } from '../shared/runtime';

const bytes = await readFile(fileURLToPath(import.meta.resolve('manifold-3d/manifold.wasm')));
initRuntime(await new Promise<Awaited<ReturnType<typeof Module>>>((resolve, reject) => {
  Module({ instantiateWasm: instantiateWith((imports) => WebAssembly.instantiate(bytes, imports), reject) } as unknown as Parameters<typeof Module>[0]).then(resolve, reject);
}));
