import { createRequire } from 'node:module';
import { afterAll } from 'vitest';
import { installTestChromiumProxy, withTestNoProxy } from './test-proxy.mjs';

Object.assign(process.env, withTestNoProxy(process.env));

if (process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1') {
  // ESM imports and createRequire share this same public Playwright singleton.
  // No production entrypoint imports this setup file.
  const { chromium } = createRequire(
    new URL('../apps/worker/package.json', import.meta.url),
  )('playwright-core');
  afterAll(installTestChromiumProxy(chromium));
}
