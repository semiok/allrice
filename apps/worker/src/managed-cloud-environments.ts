import { randomUUID } from 'node:crypto';
import {
  BrowserProfileSchema,
  CloudExecutionProfileSchema,
  cloudPythonImageV1,
  runtimeFeatureEnabled,
} from '@allrice/contracts';
import { recordManagedCloudEnvironment } from '@allrice/database';
import { CloudRunnerBackend } from './cloud-runner/backend.js';
import { startBrowserControlDriver } from './browser-control/driver.js';

/** Reuse the shipping drivers for platform preparation. No tenant task, model
 * call, private account, or user input is executed by these probes. */
export async function refreshManagedCloudEnvironments(workerId: string) {
  const browserProfile = BrowserProfileSchema.parse({
    version: 1,
    network: 'public_https',
    origins: [],
    allowUploads: true,
    allowDownloads: true,
    allowHumanCredentials: true,
  });
  const [compute, browser] = await Promise.all([
    (async () => {
      if (!runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED'))
        return {
          available: false,
          profile: null,
          reason: 'platform_cloud_paused',
        };
      try {
        const backend = new CloudRunnerBackend();
        const verified = await backend.preflight();
        const capacity = await backend.capacity();
        if (capacity.slots === 0) throw Error('cloud_resources_insufficient');
        // Separate runtime readiness must not rewrite the legacy grant profile
        // or invalidate a frozen Node operation. Execution probes it again.
        let python;
        try {
          await backend.preflight(cloudPythonImageV1);
          python = {
            available: true,
            imageDigest: cloudPythonImageV1,
            reason: null,
          };
        } catch {
          python = {
            available: false,
            imageDigest: cloudPythonImageV1,
            reason: 'platform_python_preparing',
          };
        }
        return {
          available: true,
          reason: null,
          python,
          profile: CloudExecutionProfileSchema.parse({
            ...verified,
            runtimeVersion: 'release-20260831.0',
            runtimeChecksum:
              'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
            network: 'none',
            maximumConcurrency: capacity.slots,
          }),
        };
      } catch {
        return {
          available: false,
          profile: null,
          reason: 'platform_cloud_preparing',
        };
      }
    })(),
    (async () => {
      if (!runtimeFeatureEnabled('ALLRICE_BROWSER_CONTROL_ENABLED'))
        return {
          available: false,
          profile: null,
          reason: 'platform_browser_paused',
        };
      let driver;
      try {
        driver = await startBrowserControlDriver({
          profileId: randomUUID(),
          profile: browserProfile,
          assertCurrent: async () => {},
          requestApproval: async () => {
            throw Error('probe_write_denied');
          },
          requestSent: () => {},
          requestStarted: () => () => {},
        });
        await driver.observe(1);
        return { available: true, profile: browserProfile, reason: null };
      } catch {
        return {
          available: false,
          profile: null,
          reason: 'platform_browser_preparing',
        };
      } finally {
        await driver?.close();
      }
    })(),
  ]);
  await recordManagedCloudEnvironment({ workerId, compute, browser });
  return { compute: compute.available, browser: browser.available };
}
