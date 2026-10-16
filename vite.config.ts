import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const API = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;
const DATA_DIR = path.resolve(process.env.JIG_DATA ?? 'data');

/** Designs live in ./data, inside Vite's root: never serve them as static files. */
const hideData = (): Plugin => ({
  name: 'jig-hide-data',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (/^\/data(\/|$)/.test(req.url ?? '')) { res.statusCode = 404; res.end(); } else next();
    });
  },
});

/**
 * dist/THIRD_PARTY_NOTICES.md: the licence of every package bundled into the built app and its
 * geometry worker (a separate build, so Vite's own build.license would miss it).
 */
function notices(): { collect: Plugin; write: Plugin } {
  const packages = new Set<string>();
  let outDir = 'dist';
  const collect: Plugin = {
    name: 'jig-notices-collect',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(id.replace(/\\/g, '/'));
          if (m) packages.add(m[1]);
        }
      }
    },
  };
  const write: Plugin = {
    name: 'jig-notices-write',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const parts = [...packages].sort().map((name) => {
        const dir = path.join('node_modules', name);
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
    // Vite answers CORS for every localhost origin by default; only Jig's own page may use the API.
    cors: false,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', `${DATA_DIR}/**`] },
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        // Requests from Jig's own page reach the API with the API's origin; any other origin is
        // passed on unchanged, so the server refuses it (server/index.ts).
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.origin && req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader('origin', API);
          });
        },
      },
    },
  },
  worker: { format: 'es', plugins: () => [collect] },
  optimizeDeps: { exclude: ['manifold-3d'] },
});
