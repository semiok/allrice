import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { DeploymentDshCredentialResolver } from './dsh-credential-resolver.js';

afterEach(() => {
  delete process.env.ALLRICE_DSH_CREDENTIALS_JSON;
});

describe('DeploymentDshCredentialResolver', () => {
  it('resolves only a binding matching the frozen tenant context', async () => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    process.env.ALLRICE_DSH_CREDENTIALS_JSON = JSON.stringify({
      'tenant:deepseek': {
        organizationId,
        workspaceId,
        ownerId,
        apiKey: 'tenant-secret',
      },
    });
    const resolver = new DeploymentDshCredentialResolver();
    await expect(
      resolver.resolve({
        reference: 'tenant:deepseek',
        organizationId,
        workspaceId,
        ownerId,
        route: 'deepseek-official',
      }),
    ).resolves.toEqual({ apiKey: 'tenant-secret' });
    await expect(
      resolver.resolve({
        reference: 'tenant:deepseek',
        organizationId,
        workspaceId: randomUUID(),
        ownerId,
        route: 'deepseek-official',
      }),
    ).rejects.toThrow('unavailable');
  });

  it('supports an explicitly deployment-scoped binding', async () => {
    process.env.ALLRICE_DSH_CREDENTIALS_JSON = JSON.stringify({
      'deployment:deepseek-default': {
        scope: 'deployment',
        apiKey: 'deployment-secret',
      },
    });
    await expect(
      new DeploymentDshCredentialResolver().resolve({
        reference: 'deployment:deepseek-default',
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        ownerId: randomUUID(),
        route: 'deepseek-official',
      }),
    ).resolves.toEqual({ apiKey: 'deployment-secret' });
  });
});
