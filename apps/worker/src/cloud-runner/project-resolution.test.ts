import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CloudCommandSchema,
  cloudToolchainImageV1,
  projectResolutionCloudArguments,
  ProjectDependencyResolveInputSchema,
  sandboxExecutionBudgetSpec,
  resolveSandboxExecutionPolicy,
} from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';
import { unconfirmedCloudNetworkOutcome } from './network-outcome.js';
const request = ProjectDependencyResolveInputSchema.parse({
  action: 'resolve',
  manager: 'pnpm',
  packages: [{ name: 'missing-synthetic', version: '1.0.0' }],
});
const args = projectResolutionCloudArguments(request);
const command = CloudCommandSchema.parse({
  capability: 'cloud.process.execute',
  backend: 'cloud-gvisor-v1',
  runtime: 'runsc',
  imageDigest: cloudToolchainImageV1,
  arguments: args,
  network: args.network,
  executionBudget: sandboxExecutionBudgetSpec(
    { version: 1, kind: 'install' },
    resolveSandboxExecutionPolicy([]),
  ),
  origin: {
    toolName: 'workspace.project',
    callId: 'test',
    purpose: 'project_dependency_resolution',
    argumentsDigest: 'sha256:' + 'a'.repeat(64),
    request,
  },
});
const failed = {
  version: 1 as const,
  manager: 'pnpm' as const,
  status: 'failed' as const,
  phase: 'resolve' as const,
  exitCode: 1,
  errorCode: 'PROJECT_RESOLUTION_PACKAGE_FAILED' as const,
  diagnostics: 'ERR_PNPM_FETCH_404',
};

it('preserves a typed failure after a nonzero physical exit, without publishing it as successful output', async () => {
  const c = {
    Id: 'a'.repeat(64),
    Config: {
      Labels: { 'xyz.bplabs.allrice.cloud.project-resolution': 'v1' },
      Image: cloudToolchainImageV1,
    },
    State: { Running: false, Status: 'exited', ExitCode: 1, OOMKilled: false },
    HostConfig: { Runtime: 'runsc' },
  };
  let data: unknown = failed;
  class Captured extends CloudRunnerBackend {
    override async inspect() {
      return c;
    }
    override async call() {
      const b = Buffer.from(
        JSON.stringify({
          type: 'artifact',
          path: 'resolution.json',
          data: Buffer.from(JSON.stringify(data)).toString('base64'),
        }) + '\n',
      );
      const h = Buffer.alloc(8);
      h[0] = 1;
      h.writeUInt32BE(b.length, 4);
      return Buffer.concat([h, b]);
    }
  }
  const backend = new Captured(),
    result = await backend.collect(randomUUID(), command, Date.now());
  expect(result).toMatchObject({
    reason: 'failed',
    exitCode: 1,
    stopped: true,
    resolution: failed,
    artifacts: [],
  });
  expect(
    unconfirmedCloudNetworkOutcome(command, {
      ...result,
      network: { sentBytes: 100, receivedBytes: 100, openedConnections: 1 },
    }),
  ).toBe(false);
  data = { ...failed, exitCode: 0 };
  await expect(
    backend.collect(randomUUID(), command, Date.now()),
  ).rejects.toThrow('PROJECT_RESOLUTION_RECEIPT_INVALID');
});
it('does not let tenant scripts or missing receipts claim confirmed external failure', () => {
  const network = { sentBytes: 100, receivedBytes: 100, openedConnections: 1 };
  for (const [payload, result] of [
    [
      { ...command, origin: undefined },
      { reason: 'failed', exitCode: 1, resolution: failed, network },
    ],
    [command, { reason: 'failed', exitCode: 1, network }],
    [command, { reason: 'failed', exitCode: 2, resolution: failed, network }],
    [command, { reason: 'unknown', exitCode: 1, resolution: failed, network }],
  ] as const)
    expect(unconfirmedCloudNetworkOutcome(payload, result)).toBe(true);
});
