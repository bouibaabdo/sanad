import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { createSignalingMiddleware } from './remote-assist/signaling.js';

export default defineConfig({
  plugins: [{
    name: 'sanad-signaling',
    configureServer(server) {
      server.middlewares.use(createSignalingMiddleware());
    },
  }],
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, 'remote-assist/index.html'),
    },
  },
});
