import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import type { Plugin } from 'vitest/config';

const fixture = fileURLToPath(new URL('./host-fixture.ts', import.meta.url));

/** Vite's Oxc pass preserves standard decorators; Node22 needs them lowered.
 * Match the product's existing esbuild target only for this owned fixture. */
export const principalFixtureTransform: Plugin = {
  name: 'd-entry-principal-fixture',
  enforce: 'pre',
  async transform(code, id) {
    if (id.split('?')[0] !== fixture) return null;
    const result = await transform(code, {
      loader: 'ts',
      format: 'esm',
      target: 'node22',
      sourcefile: fixture,
      sourcemap: true,
    });
    return { code: result.code, map: result.map };
  },
};
