import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Transform official UI ESM dependencies so Node suites stub their CSS modules.
    server: {
      deps: { inline: [/@deepseek-ai\/dsh-client-ui-(dockkit|primitives)/] },
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.local/**',
    ],
  },
  resolve: {
    alias: {
      '@allrice/project-runtime': fileURLToPath(
        new URL('./packages/project-runtime/src/index.ts', import.meta.url),
      ),
      '@allrice/office-runtime/pdf-reader': fileURLToPath(
        new URL('./packages/office-runtime/src/pdf-reader.ts', import.meta.url),
      ),
      '@allrice/office-runtime/preview': fileURLToPath(
        new URL('./packages/office-runtime/src/preview.ts', import.meta.url),
      ),
      '@allrice/office-runtime': fileURLToPath(
        new URL('./packages/office-runtime/src/index.ts', import.meta.url),
      ),
      '@allrice/browser-control': fileURLToPath(
        new URL('./packages/browser-control/src/index.ts', import.meta.url),
      ),
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
