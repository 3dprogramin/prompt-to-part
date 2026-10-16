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

export default defineConfig({
  plugins: [react(), hideData()],
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
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['manifold-3d'] },
});
