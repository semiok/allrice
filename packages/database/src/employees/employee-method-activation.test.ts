import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  EmployeeMethodActivateSchema,
  EmployeeMethodPrepareActivationSchema,
  type EmployeeContentManifest,
} from '@allrice/contracts';
import { employeeMethodActivationChanges } from './employee-method-activation.ts';

it('requires coverage for every changed scene and all retained scenes when common requirements change', () => {
  const ref = {
    sourceKind: 'procedure' as const,
    contentId: randomUUID(),
    revisionId: randomUUID(),
    digest: `sha256:${'a'.repeat(64)}`,
  };
  const before: EmployeeContentManifest = {
    schemaVersion: 1,
    common: [],
    declaredConflicts: [],
    scenes: [
      {
        id: randomUUID(),
        name: '周度',
        appliesWhen: '每周',
        references: [ref],
      },
      {
        id: randomUUID(),
        name: '月度',
        appliesWhen: '每月',
        references: [ref],
      },
    ],
  };
  const after = structuredClone(before);
  after.scenes[0]!.references = [{ ...ref, revisionId: randomUUID() }];
  expect(
    employeeMethodActivationChanges(before, after).changedScenes.map(
      (s) => s.id,
    ),
  ).toEqual([before.scenes[0]!.id]);
  after.common = [ref];
  expect(
    employeeMethodActivationChanges(before, after).changedScenes.map(
      (s) => s.id,
    ),
  ).toEqual(before.scenes.map((s) => s.id));
  after.scenes = [];
  after.common = [];
  expect(employeeMethodActivationChanges(before, after)).toEqual({
    commonChanged: false,
    changedScenes: [],
    removedScenes: before.scenes,
  });
});

it('does not accept model approval, target identities or fabricated assertions', () => {
  const args = {
    expectedRevision: 1,
    candidateRevisionId: randomUUID(),
    candidateDigest: `sha256:${'a'.repeat(64)}`,
    testIds: [randomUUID()],
  };
  expect(EmployeeMethodPrepareActivationSchema.safeParse(args).success).toBe(
    true,
  );
  for (const payload of [
    { ...args, testIds: [args.testIds[0], args.testIds[0]] },
    { ...args, ownerId: randomUUID() },
    { ...args, passed: true },
  ])
    expect(
      EmployeeMethodPrepareActivationSchema.safeParse(payload).success,
    ).toBe(false);
  expect(
    EmployeeMethodActivateSchema.safeParse({
      receiptId: randomUUID(),
      approved: true,
    }).success,
  ).toBe(false);
});
