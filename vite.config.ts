import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The app's version (package.json), shown in the top bar as import.meta.env.VITE_APP_VERSION.
process.env.VITE_APP_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;

const API = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;
// Forward slashes: the deny globs below don't match Windows backslashes.
const slash = (p: string) => p.replace(/\\/g, '/');
// The repo's own data/ is hidden even when JIG_DATA points elsewhere (it may still hold designs).
const DATA_DIRS = [...new Set([path.resolve('data'), path.resolve(process.env.JIG_DATA ?? 'data')].map(slash))];

/** Designs live in ./data, inside Vite's root: never serve them as static files. */
const hideData = (): Plugin => ({
  name: 'jig-hide-data',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Decoded and normalised, so /%64ata/…, /./data/… and /src/../data/… are caught too.
      let p: string;
      try { p = path.posix.normalize(decodeURIComponent((req.url ?? '').split('?')[0])); } catch { p = '/data'; }
      const hidden = /^\/data(\/|$)/.test(p) || (p.startsWith('/@fs/') && DATA_DIRS.some((d) => `${p.slice(4)}/`.startsWith(`${d}/`)));
      if (hidden) { res.statusCode = 404; res.end(); } else next();
    });
  },
});

/**
 * dist/THIRD_PARTY_NOTICES.md: the licence of every package bundled into the built app and its
 * geometry worker (a separate build, so Vite's own build.license would miss it).
 */
function notices(): { collect: Plugin; write: Plugin } {
  // Each bundled package's folder, by its name. Ids like
  // node_modules/.pnpm/three@0.186.1/node_modules/three/build/three.module.js: the package is the
  // folder after the last node_modules, which is also where it is for packages that aren't top-level
  // (scheduler, @endo/*).
  const packages = new Map<string, string>();
  let outDir = 'dist';
  const collect: Plugin = {
    name: 'jig-notices-collect',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const m = /^\0?(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(id.replace(/\\/g, '/'));
          if (m) packages.set(m[1], m[2]);
        }
      }
    },
  };
  const write: Plugin = {
    name: 'jig-notices-write',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const sorted = [...packages].sort(([da, a], [db, b]) => (a < b ? -1 : a > b ? 1 : da < db ? -1 : da > db ? 1 : 0));
      const parts = sorted.map(([dir, name]) => {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string; license?: string };
        // Every licence and notice file: some packages (ses) include code under further licences.
        const texts = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort().map((f) => readFileSync(path.join(dir, f), 'utf8').trim());
        return `## ${name} ${pkg.version} (${pkg.license ?? 'see licence'})\n\n${texts.join('\n\n')}`;
      });
      if (existsSync(outDir)) writeFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices\n\nThe built app includes these packages:\n\n${parts.join('\n\n')}\n`);
    },
  };
  return { collect, write };
}
const { collect, write } = notices();

export default defineConfig({
  plugins: [react(), hideData(), collect, write],
  server: {
    port: 5173,
    // Vite answers CORS for every localhost origin by default; only the app's own page may use the API.
    cors: false,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...DATA_DIRS.map((d) => `${d}/**`)] },
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // Requests from the app's own page reach the API with the API's origin; any other origin is
        // passed on unchanged, so the server refuses it (server/index.ts).
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin && req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader('origin', API);
          });
        },
      },
    },
  },
  build: {
    // three.js and React in files of their own: they change only with an upgrade, so after an app
    // update the browser keeps them cached and fetches just the app's code.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/](three|three-mesh-bvh)[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  worker: { format: 'es', plugins: () => [collect] },
  optimizeDeps: { exclude: ['manifold-3d'] },
});
