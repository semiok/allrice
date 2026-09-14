import { afterEach, expect, it, vi } from 'vitest';
import type * as configModule from './config.js';
const guards = vi.hoisted(() => ({
  startup: vi.fn(async () => {
    throw Error('UPDATE_RECOVERY_REQUIRED');
  }),
  readiness: vi.fn(async () => undefined),
  readConfig: vi.fn(),
}));
vi.mock('./desktop-update.js', () => ({
  assertBridgeUpdateStartup: guards.startup,
  acknowledgeBridgeUpdateReadiness: guards.readiness,
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof configModule>()),
  readConfig: guards.readConfig,
}));
import { start } from './core.js';

afterEach(() => vi.unstubAllGlobals());
it('direct CLI start honors pending update gating before credentials, journal or network', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(start()).rejects.toThrow('UPDATE_RECOVERY_REQUIRED');
  expect(guards.startup).toHaveBeenCalledOnce();
  expect(guards.readConfig).not.toHaveBeenCalled();
  expect(guards.readiness).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
