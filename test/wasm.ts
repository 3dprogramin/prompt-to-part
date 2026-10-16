// Starts the model sandbox and the manifold-3d runtime, as the geometry workers do. Import it
// first in tests that evaluate scripts (each test file runs in its own process).
import '../shared/sandbox';
import Module from 'manifold-3d';
import { initRuntime } from '../shared/runtime';

initRuntime(await Module());
