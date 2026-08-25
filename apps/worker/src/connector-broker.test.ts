import { afterEach, describe, expect, it } from 'vitest';

import { DeploymentConnectorCredentialResolver } from './connector-broker.js';

afterEach(() => {
  delete process.env.ALLRICE_CONNECTOR_CREDENTIALS_JSON;
});

describe('connector credential broker', () => {
  it('resolves only an opaque reference within the tenant identity', async () => {
    process.env.ALLRICE_CONNECTOR_CREDENTIALS_JSON = JSON.stringify({
      'user:drive': {
        organizationId: 'org-a',
        workspaceId: 'workspace-a',
        actorId: 'user-a',
        credentials: { accessToken: 'secret-token' },
      },
    });
    const credentials =
      await new DeploymentConnectorCredentialResolver().resolve({
        reference: 'user:drive',
        organizationId: 'org-a',
        workspaceId: 'workspace-a',
        actorId: 'user-a',
      });
    expect(credentials).toEqual({ accessToken: 'secret-token' });
    await expect(
      new DeploymentConnectorCredentialResolver().resolve({
        reference: 'user:drive',
        organizationId: 'org-a',
        workspaceId: 'workspace-a',
        actorId: 'user-b',
      }),
    ).rejects.toThrow('unavailable for this tenant identity');
  });
});
