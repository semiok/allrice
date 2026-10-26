import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

describe('Worker entrypoint memory configuration (MET-219)', () => {
  it('refuses to start with an invalid pause pressure', async () => {
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
    vi.stubEnv('ALLRICE_WORKER_CONCURRENCY', '1');
    vi.stubEnv('ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE', 'normal');
    // The real entrypoint must reject configuration before runtime setup,
    // database initialization, HTTP listen, or queue consumption.
    await expect(import('./index.js')).rejects.toThrow(
      'ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE',
    );
  }, 30_000);
});
