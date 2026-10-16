import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8787}`, changeOrigin: true } },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['manifold-3d'] },
});
