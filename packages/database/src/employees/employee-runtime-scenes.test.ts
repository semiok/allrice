import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { EmployeeRuntimeContentSchema } from '@allrice/contracts';
import { employeeRuntimeScenes } from './employee-runtime-scenes.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';

it('keeps historical hashes exact and counts repeated cross-layer references once', () => {
  const organizationId = randomUUID(),
    digest = `sha256:${'0'.repeat(64)}`;
  const refs = Array.from({ length: 65 }, () => ({
    sourceKind: 'knowledge',
    contentId: randomUUID(),
    revisionId: randomUUID(),
    digest,
  }));
  const index = {
    schemaVersion: 1,
    instanceId: randomUUID(),
    employeeId: randomUUID(),
    employeeVersionId: randomUUID(),
    platform: { revisionId: null, digest },
    layers: [
      {
        setId: randomUUID(),
        revisionId: randomUUID(),
        digest,
        ownership: { scope: 'company', organizationId },
        common: refs,
      },
      {
        setId: randomUUID(),
        revisionId: randomUUID(),
        digest,
        ownership: {
          scope: 'department',
          organizationId,
          departmentId: randomUUID(),
        },
        common: refs,
      },
    ],
  };
  const frozen = { ...index, checksum: runtimePolicyDigest(index) };
  const parsed = EmployeeRuntimeContentSchema.parse(frozen);
  expect(parsed).toEqual(frozen);
  expect(employeeRuntimeScenes(parsed)).toEqual([]);
  const { checksum, ...readback } = parsed;
  expect(runtimePolicyDigest(readback)).toBe(checksum);
  const another = Array.from({ length: 64 }, () => ({
    ...refs[0]!,
    contentId: randomUUID(),
  }));
  const excessive = structuredClone(parsed);
  excessive.layers[1]!.common = another as (typeof parsed.layers)[0]['common'];
  expect(() => employeeRuntimeScenes(excessive)).toThrow(
    'runtime_scene_directory_limit',
  );
});
