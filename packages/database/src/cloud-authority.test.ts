import { expect, it } from 'vitest';
import {
  CloudCommandSchema,
  cloudPythonImageV1,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { cloudCommandBinding } from './cloud-authority.ts';
import { runtimePolicyDigest as digest } from './runtime-policy.ts';

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
