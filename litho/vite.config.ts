// The lithophane preview widget's build, separate from the app's (vite.config.ts at the root).
//   --mode lib:  dist-litho/litho-preview.js, the <litho-preview> web component as one classic
//                script (styles inside), for a shop theme's <script src>.
//   default:     the demo page (index.html, which loads that script) and the shop's production page.
// `pnpm build:litho` runs both, the library first.
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = fileURLToPath(new URL('../dist-litho', import.meta.url));

/**
 * In the built demo page, the component comes from the single-file script, exactly as a shop loads
 * it: the dev module tag is dropped before Vite bundles the page, the script tag added after.
 */
const DEV_TAG = '<script type="module" src="./src/element.ts"></script>';
const demoScript = (): Plugin[] => [
  {
    name: 'litho-demo-drop-module',
    apply: 'build',
    transformIndexHtml: { order: 'pre', handler: (html, ctx) => (ctx.path.endsWith('/index.html') ? html.replace(DEV_TAG, '') : html) },
  },
  {
    name: 'litho-demo-add-script',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => (ctx.path.endsWith('/index.html') ? html.replace('</body>', '  <script src="./litho-preview.js" defer></script>\n</body>') : html),
    },
  },
];

export default defineConfig(({ mode }) => (mode === 'lib'
  ? {
    root,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2020',
      lib: { entry: 'src/element.ts', name: 'LithoPreview', formats: ['iife'], fileName: () => 'litho-preview.js' },
    },
  }
  : {
    root,
    base: './',
    publicDir: false,
    plugins: [demoScript()],
    server: { port: 5174 },
    build: {
      outDir,
      emptyOutDir: false,
      target: 'es2020',
      chunkSizeWarningLimit: 800,
      rolldownOptions: { input: { index: `${root}index.html`, production: `${root}production.html` } },
    },
  }));
