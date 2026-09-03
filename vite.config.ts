import { defineConfig } from 'vite';

// The client is served by Vite in development (port 5173) and by the Node game
// server from `dist/` in production. In both cases the game socket lives at
// `/ws` on the same origin; in dev Vite proxies it to the game server on 8080.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/healthz': { target: 'http://localhost:8080' },
    },
  },
});
