import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CloudCommandSchema,
  SandboxNetworkLeaseSchema,
  cloudToolchainImageV1,
  canonicalRuntimeBridgeJson,
} from '@allrice/contracts';
import { CloudRunnerBackend, cloudNetworkSupervisor } from './backend.js';
import { unconfirmedCloudNetworkOutcome } from './network-outcome.js';

const network = {
  mode: 'controlled_https' as const,
  origins: ['https://registry.npmjs.org'],
};
const command = CloudCommandSchema.parse({
  capability: 'cloud.process.execute',
  arguments: { script: 'console.log(1)', network },
  backend: 'cloud-gvisor-v1',
  imageDigest: cloudToolchainImageV1,
  runtime: 'runsc',
  network,
});
function lease(attemptId = randomUUID()) {
  return SandboxNetworkLeaseSchema.parse({
    version: 1,
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    runId: randomUUID(),
    operationId: randomUUID(),
    attemptId,
    target: { kind: 'cloud', targetId: randomUUID() },
    grantId: randomUUID(),
    grantVersion: 1,
    network,
    policyDigest:
      'sha256:' +
      createHash('sha256')
        .update(canonicalRuntimeBridgeJson({ network }))
        .digest('hex'),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maximumConnections: 4,
    maximumBytes: 1024 * 1024,
  });
}

describe('controlled cloud network authority', () => {
  it('rejects mismatched attempt, target and frozen policy before touching a daemon', async () => {
    const backend = new CloudRunnerBackend(),
      attemptId = randomUUID();
    for (const bad of [
      lease(),
      { ...lease(attemptId), policyDigest: 'sha256:' + 'b'.repeat(64) },
      {
        ...lease(attemptId),
        target: {
          kind: 'bridge' as const,
          targetId: randomUUID(),
          deviceId: randomUUID(),
        },
      },
    ])
      await expect(
        backend.execute(command, [], {
          attemptId,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          maintainLease: async () => true,
          networkLease: bad,
        }),
      ).rejects.toThrow('IDENTITY_CHANGED');
    expect(() =>
      CloudCommandSchema.parse({ ...command, network: 'none' }),
    ).toThrow();
    expect(() =>
      CloudCommandSchema.parse({
        ...command,
        arguments: { ...command.arguments, network: undefined },
      }),
    ).toThrow();
  });
  it('reconciles only an unchanged isolated container and approved helper', async () => {
    const attemptId = randomUUID();
    const original = {
      Id: 'a'.repeat(64),
      Config: {
        Labels: {
          'xyz.bplabs.allrice.cloud.attempt': attemptId,
          'xyz.bplabs.allrice.cloud.network': 'controlled-https-v1',
          'xyz.bplabs.allrice.cloud.network-policy': lease().policyDigest,
        },
        Image: cloudToolchainImageV1,
        User: '65532:65532',
        Cmd: ['--input-type=module', '--eval', cloudNetworkSupervisor],
        Entrypoint: ['/usr/local/bin/node'],
        Env: [] as string[],
      },
      HostConfig: {
        Runtime: 'runsc',
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 64,
        Memory: 256 * 1024 ** 2,
        MemorySwap: 256 * 1024 ** 2,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
      },
      State: {
        Running: false,
        Status: 'exited',
        ExitCode: 0,
        OOMKilled: false,
      },
      Mounts: [{ Type: 'tmpfs', Destination: '/tmp' }],
    };
    let container = structuredClone(original);
    class Observed extends CloudRunnerBackend {
      override async json<T>(_method: string, path: string) {
        return (
          path.startsWith('/images/') ? { Config: { Env: [] } } : container
        ) as T;
      }
    }
    const backend = new Observed();
    await expect(backend.inspect(attemptId)).resolves.toEqual(original);
    for (const mutate of [
      () => {
        container.HostConfig.NetworkMode = 'bridge';
      },
      () => {
        container.Config.Env = ['TOKEN=synthetic'];
      },
      () => {
        container.Config.Cmd = ['--eval', 'untrusted'];
      },
      () => {
        container.Config.User = '0:0';
      },
      () => {
        container.Mounts = [{ Type: 'bind', Destination: '/tmp' }];
      },
      () => {
        container.HostConfig.Privileged = true;
      },
      () => {
        container.HostConfig.PidsLimit = 1024;
      },
    ]) {
      container = structuredClone(original);
      mutate();
      await expect(backend.inspect(attemptId)).rejects.toThrow(
        'SANDBOX_NETWORK_CONTAINER_CHANGED',
      );
    }
  });
  it('does not equate local process stop with a confirmed external API result', () => {
    const observed = {
      sentBytes: 200,
      receivedBytes: 100,
      openedConnections: 1,
    };
    expect(
      unconfirmedCloudNetworkOutcome(command, {
        reason: 'failed',
        network: observed,
      }),
    ).toBe(true);
    expect(
      unconfirmedCloudNetworkOutcome(command, {
        reason: 'canceled',
        network: observed,
      }),
    ).toBe(true);
    expect(unconfirmedCloudNetworkOutcome(command, { reason: 'failed' })).toBe(
      true,
    );
    expect(
      unconfirmedCloudNetworkOutcome(command, {
        reason: 'failed',
        network: { ...observed, sentBytes: 0 },
      }),
    ).toBe(false);
    expect(
      unconfirmedCloudNetworkOutcome(command, {
        reason: 'completed',
        network: observed,
      }),
    ).toBe(false);
    const offline = CloudCommandSchema.parse({
      ...command,
      network: 'none',
      arguments: { ...command.arguments, network: undefined },
    });
    expect(unconfirmedCloudNetworkOutcome(offline, { reason: 'failed' })).toBe(
      false,
    );
  });
});
