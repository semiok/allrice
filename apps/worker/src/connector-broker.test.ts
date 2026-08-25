import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  ConnectorBroker,
  DeploymentConnectorCredentialResolver,
} from './connector-broker.js';

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

  it('never resolves credentials or calls a transport before approval', async () => {
    let credentialReads = 0;
    let transportCalls = 0;
    const callId = randomUUID();
    const approvalId = randomUUID();
    const bindingId = randomUUID();
    const broker = new ConnectorBroker(
      {
        resolve: async () => {
          credentialReads++;
          return { token: 'secret' };
        },
      },
      new Map([
        [
          'mail.send',
          {
            execute: async () => {
              transportCalls++;
              return { modelContent: '', summary: '', rawOutput: {} };
            },
          },
        ],
      ]),
      {
        prepare: async () => ({
          callId,
          bindingId,
          inputDigest: `sha256:${'a'.repeat(64)}`,
          identityMode: 'user',
          risk: 'external_send',
          status: 'waiting_approval',
          approvalId,
        }),
        load: async () => {
          throw new Error('must not load');
        },
        complete: async () => undefined,
      },
    );
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const actorId = randomUUID();
    await expect(
      broker.execute({
        context: {
          executionId: randomUUID(),
          runId: randomUUID(),
          jobId: randomUUID(),
          worker: { type: 'worker', id: randomUUID() },
          delegatedBy: { type: 'user', id: actorId },
          organizationId,
          workspaceId,
          policySnapshot: {
            id: randomUUID(),
            organizationId,
            subjectId: actorId,
            version: 1,
            issuedAt: '2026-08-25T00:00:00.000Z',
            expiresAt: '2026-08-26T00:00:00.000Z',
            memberships: [],
            grants: [],
          },
          startedAt: '2026-08-25T00:00:00.000Z',
        },
        request: {
          connectorBindingId: bindingId,
          operation: 'send',
          input: { to: 'recipient@example.com' },
        },
        grantedCapabilities: ['automation:write'],
        allowedIdentityModes: ['user'],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(`requires approval ${approvalId}`);
    expect(credentialReads).toBe(0);
    expect(transportCalls).toBe(0);
  });
});
