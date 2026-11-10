import react from '@vitejs/plugin-react';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve #core/#shared/#database subpath imports to TypeScript sources ("@workbox/source" condition),
// so tests never depend on a prior build.
const conditions = ['@workbox/source', ...defaultServerConditions];

const shared = {
  resolve: { conditions },
  ssr: { resolve: { conditions } },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages}/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**', 'apps/web/**'],
          testTimeout: 15_000,
        },
      },
      {
        plugins: [react()],
        resolve: { conditions: ['@workbox/source', ...defaultClientConditions] },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/test/**/*.test.tsx'],
          setupFiles: ['./apps/web/test/setup.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{apps,packages}/*/test/**/*.int.test.ts'],
          setupFiles: ['./test/integration-env.ts'],
          // Integration tests share Postgres/Redis; run files serially for deterministic results.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['{apps,packages}/*/src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
