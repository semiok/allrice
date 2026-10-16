import { expect, it } from 'vitest';
import {
  CloudCommandSchema,
  cloudPythonImageV1,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import {
  cloudCommandBinding,
  normalizeCloudPythonArguments,
} from './cloud-authority.ts';
import { runtimePolicyDigest as digest } from './runtime-policy.ts';
import { RepositoryExecutionProofSchema } from './platform-repair-contracts.ts';
import { randomUUID } from 'node:crypto';

it('preserves explicit canonical Python budgets and destinations without injecting them into legacy calls', () => {
  const original = {
    script: 'print(35)',
    location: 'local',
    execution: { version: 1, kind: 'compute' },
    network: { mode: 'controlled_https', origins: ['https://pypi.org'] },
  };
  const before = JSON.stringify(original);
  const normalized = normalizeCloudPythonArguments(original);
  expect(normalized.execution).toEqual(original.execution);
  expect(normalized.network).toEqual(original.network);
  expect(normalized.language).toBe('python');
  expect(normalized).not.toHaveProperty('location');
  expect(JSON.stringify(original)).toBe(before);
  const legacy = normalizeCloudPythonArguments({ script: 'print(35)' });
  expect(legacy).not.toHaveProperty('execution');
  expect(legacy).not.toHaveProperty('network');
});

it('keeps historic executable/image bindings unchanged and freezes Python language separately', () => {
  const node = CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    arguments: { script: '0' },
    backend: 'cloud-gvisor-v1',
    imageDigest: cloudToolchainImageV1,
    runtime: 'runsc',
    network: 'none',
  });
  expect(cloudCommandBinding(node).executableDigest).toBe(
    digest({ runtime: 'runsc', script: '0' }),
  );
  expect(cloudCommandBinding(node).toolchainDigest).toBe(
    digest({ backend: 'cloud-gvisor-v1', imageDigest: cloudToolchainImageV1 }),
  );
  const python = CloudCommandSchema.parse({
    ...node,
    imageDigest: cloudPythonImageV1,
    arguments: { ...node.arguments, language: 'python' },
  });
  expect(cloudCommandBinding(python).executableDigest).not.toBe(
    cloudCommandBinding(node).executableDigest,
  );
  expect(cloudCommandBinding(python).toolchainDigest).not.toBe(
    cloudCommandBinding(node).toolchainDigest,
  );
});

it('uses the admitted private compiler budget without changing ordinary or historic v1 bindings', () => {
  const command = CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    arguments: {
      script: 'synthetic',
      limits: { timeoutMs: 60000, memoryMiB: 512 },
    },
    backend: 'cloud-gvisor-v1',
    imageDigest: cloudToolchainImageV1,
    runtime: 'runsc',
    network: 'none',
  });
  const common = {
    commandDigest: 'sha256:' + 'a'.repeat(64),
    baselineId: randomUUID(),
    candidateChecksum: 'sha256:' + 'b'.repeat(64),
  };
  const v1 = RepositoryExecutionProofSchema.parse({
    ...common,
    version: 1,
    profileId: 'allrice.output-redaction.v1',
    inputLimit: 12000000,
    tmpfsMiB: 64,
  });
  const v2 = RepositoryExecutionProofSchema.parse({
    ...common,
    version: 2,
    profileId: 'allrice.output-redaction.compiled.v1',
    inputLimit: 23000000,
    tmpfsMiB: 128,
    dependencyChecksum: 'sha256:' + 'c'.repeat(64),
    planDigest: 'sha256:' + 'd'.repeat(64),
    timeoutMs: 300000,
    memoryMiB: 768,
  });
  expect(cloudCommandBinding(command).budgetDigest).toBe(
    digest(command.arguments.limits),
  );
  expect(cloudCommandBinding(command, v1).budgetDigest).toBe(
    cloudCommandBinding(command).budgetDigest,
  );
  expect(cloudCommandBinding(command, v2).budgetDigest).toBe(
    digest({ ...command.arguments.limits, timeoutMs: 300000, memoryMiB: 768 }),
  );
  expect(command.arguments.limits.timeoutMs).toBe(60000);
  expect(command.arguments.limits.memoryMiB).toBe(512);
});
