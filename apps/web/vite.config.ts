import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Same single .env as the API, so the dev proxy follows API_HOST/API_PORT.
  const env = loadEnv(mode, projectRoot, '');
  const apiTarget = `http://${env.API_HOST || '127.0.0.1'}:${env.API_PORT || '3000'}`;

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir: projectRoot,
    plugins: [react()],
    resolve: {
      // Resolve #shared to TypeScript sources, like the rest of the repo.
      conditions: ['@workbox/source', ...defaultClientConditions],
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': apiTarget,
        '/health': apiTarget,
        '/docs': apiTarget,
      },
    },
    build: {
      // Served by the API in production builds (see apps/api/src/app.ts).
      outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)),
      emptyOutDir: true,
    },
  };
});
