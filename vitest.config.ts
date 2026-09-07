import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.local/**',
    ],
  },
  resolve: {
    alias: {
      '@allrice/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@allrice/database': fileURLToPath(
        new URL('./packages/database/src/index.ts', import.meta.url),
      ),
      '@allrice/storage': fileURLToPath(
        new URL('./packages/storage/src/index.ts', import.meta.url),
      ),
    },
  },
});
