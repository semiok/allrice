import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  prepareBridgeBrowser,
  bridgePreviewState,
  initialBridgeEnvironment,
} from './runtime-preparation.js';
import { saveLocalBrowserOptIn } from './local-browser-settings.js';

it.skipIf(process.env.ALLRICE_TEST_LOCAL_BROWSER_NATIVE !== '1')(
  'a new pairing actually starts the existing native browser without a VM or manual browser opt-in',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-met159-native-'));
    vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(root, 'config.json'));
    const config = {
      deviceId: randomUUID(),
      server: 'https://synthetic.example/',
      deviceName: 'Preparation fixture',
      grants: [],
    };
    try {
      const environment = initialBridgeEnvironment();
      environment.sandbox = 'unavailable';
      environment.browser = await prepareBridgeBrowser(
        config,
        new AbortController().signal,
      );
      expect(environment.browser).toBe('ready');
      expect(await bridgePreviewState(config, environment)).toBe('unavailable');
      await saveLocalBrowserOptIn(config, false);
      expect(
        await prepareBridgeBrowser(config, new AbortController().signal),
      ).toBe('paused');
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
