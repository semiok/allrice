import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareExecutionIsolation } from './isolation.js';

const ids = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  runId: '44444444-4444-4444-8444-444444444444',
  jobId: '55555555-5555-4555-8555-555555555555',
};

describe('Worker execution isolation', () => {
  it('creates a tenant/run/attempt directory with a secret-free environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-isolation-'));
    const isolation = await prepareExecutionIsolation({
      root,
      ...ids,
      attempt: 2,
    });
    expect(isolation.workDirectory.startsWith(root)).toBe(true);
    expect(isolation.workDirectory).toContain(ids.organizationId);
    expect(isolation.environment).toEqual({
      ALLRICE_RUN_ID: ids.runId,
      ALLRICE_JOB_ID: ids.jobId,
      ALLRICE_ORGANIZATION_ID: ids.organizationId,
      ALLRICE_WORKSPACE_ID: ids.workspaceId,
      ALLRICE_OWNER_ID: ids.ownerId,
      ALLRICE_ATTEMPT: '2',
    });
    expect(isolation.environment).not.toHaveProperty('DATABASE_URL');
    const marker = join(isolation.workDirectory, 'marker.txt');
    await writeFile(marker, 'isolated', 'utf8');
    await expect(readFile(marker, 'utf8')).resolves.toBe('isolated');
    const retryIsolation = await prepareExecutionIsolation({
      root,
      ...ids,
      attempt: 3,
    });
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
    await retryIsolation.cleanup();
  });

  it('rejects untrusted path identifiers', async () => {
    await expect(
      prepareExecutionIsolation({
        root: tmpdir(),
        ...ids,
        runId: '../../escape',
        attempt: 1,
      }),
    ).rejects.toThrow();
  });
});
