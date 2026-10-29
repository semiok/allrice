import type { ServerResponse } from 'node:http';
import {
  cloudPlatform,
  runtimeFeatureEnabled,
  type HealthResponse,
} from '@allrice/contracts';
import {
  CloudRunnerBackend,
  CloudRunnerError,
} from './cloud-runner/backend.js';

function reportFailure(dependency: string, error: unknown) {
  // Docker/OS errors may contain socket paths; only trusted machine codes leave
  // this boundary. The response uses the existing HealthResponse.detail field.
  const code =
    error instanceof CloudRunnerError &&
    /^CLOUD_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'CLOUD_DEPENDENCY_UNAVAILABLE';
  console.error('[MET-235] Worker readiness dependency failed', {
    dependency,
    code,
  });
  return `${dependency}_unavailable`;
}

/** The cloud runner deployment supplies the four pinned toolchains described
 * by cloudPlatform. Disabled deployments (including QA without a sandbox) do
 * not depend on Docker. All checks reuse the execution backend's bounded,
 * read-only preflight; none pulls images or creates/starts containers. */
async function probeCloudDependencies() {
  let backend: CloudRunnerBackend;
  try {
    backend = new CloudRunnerBackend();
    await backend.call('GET', '/_ping');
  } catch (error) {
    return reportFailure('cloud_docker', error);
  }
  const results = await Promise.all(
    Object.entries(cloudPlatform.images).map(async ([name, image]) => {
      try {
        await backend.preflight(image);
        return undefined;
      } catch (error) {
        return reportFailure(`cloud_image_${name}`, error);
      }
    }),
  );
  return results.find((result) => result !== undefined);
}

export function createWorkerReadinessResponder() {
  // Coalesce only this responder's concurrent HTTP requests. There is no
  // completed-result cache, extra timer or independent health state machine.
  let pending: Promise<string | undefined> | undefined;
  return async (
    response: ServerResponse,
    readCurrentHealth: () => HealthResponse & Record<string, unknown>,
    onReady: () => void,
  ) => {
    let health = readCurrentHealth();
    if (
      health.status === 'ready' &&
      runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED')
    ) {
      const detail = await (pending ??= probeCloudDependencies().finally(() => {
        pending = undefined;
      }));
      // Local prerequisites can fail while a bounded cloud check is pending.
      // Re-read them and their metadata immediately before the synchronous send.
      health = readCurrentHealth();
      if (health.status === 'ready' && detail)
        health = { ...health, status: 'not_ready', detail };
    }
    const ready = health.status === 'ready';
    response.statusCode = ready ? 200 : 503;
    if (ready) response.once('finish', onReady);
    response.end(JSON.stringify(health));
  };
}
