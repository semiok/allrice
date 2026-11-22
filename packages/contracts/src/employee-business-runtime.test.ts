import { describe, expect, it } from 'vitest';
import {
  AdoptedHumanSourceProjectionSchema,
  EmployeeBusinessTargetProjectionSchema,
  LogicalExecutionBindingProjectionSchema,
  MemoryOriginSelectorProjectionSchema,
  OrdinaryOriginClassificationProjectionSchema,
} from './employee-business-runtime.ts';

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const scope = {
  organizationId: id('1'),
  workspaceId: id('2'),
  ownerId: id('3'),
  employeeInstanceId: id('4'),
  employeeId: id('5'),
};

describe('neutral employee business projections (contract fakes, not authority)', () => {
  it('keeps management independent of execution while requiring an explicit module decision', () => {
    const target = {
      workspaceId: scope.workspaceId,
      employeeInstanceId: scope.employeeInstanceId,
      threadId: null,
      access: 'management',
      module: { kind: 'not-applicable' },
    };
    expect(EmployeeBusinessTargetProjectionSchema.parse(target)).toEqual(
      target,
    );
    expect(
      EmployeeBusinessTargetProjectionSchema.safeParse({
        ...target,
        module: null,
      }).success,
    ).toBe(false);
    expect(
      EmployeeBusinessTargetProjectionSchema.safeParse({
        ...target,
        access: 'execute',
      }).success,
    ).toBe(false);
    expect(
      EmployeeBusinessTargetProjectionSchema.safeParse({
        ...target,
        approved: true,
      }).success,
    ).toBe(false);
  });

  it('preserves opaque producer bytes and rejects a call attached to another root', () => {
    const binding = {
      scope,
      threadId: id('6'),
      executionGeneration: '4.0',
      b: ' owner-defined B bytes / 一 ',
      executionBoundaryRef: 'producer-defined boundary',
      rootOriginRef: 'original birth provenance',
      rootSessionRef: 'root',
      nativeCall: {
        rootSessionRef: 'root',
        parentSessionRef: null,
        sessionRef: 'root',
        callRef: 'call',
        toolId: 'owner.tool',
        toolVersion: 'owner-defined version',
      },
    };
    expect(LogicalExecutionBindingProjectionSchema.parse(binding).b).toBe(
      binding.b,
    );
    expect(
      LogicalExecutionBindingProjectionSchema.safeParse({
        ...binding,
        nativeCall: { ...binding.nativeCall, rootSessionRef: 'other-root' },
      }).success,
    ).toBe(false);
    expect(
      LogicalExecutionBindingProjectionSchema.safeParse({
        ...binding,
        b: undefined,
      }).success,
    ).toBe(false);
  });

  it('represents adopted steering only with its execution adoption fact, never guest role or approved flags', () => {
    const source = {
      scope,
      threadId: id('6'),
      b: 'contract-fake-B',
      executionBoundaryRef: 'contract-fake-boundary',
      rootOriginRef: 'contract-fake-root-origin',
      nativeCall: {
        rootSessionRef: 'root',
        parentSessionRef: null,
        sessionRef: 'root',
        callRef: 'call',
        toolId: 'tool',
        toolVersion: 'v',
      },
      kind: 'adopted-steering',
      adoptedByExecution: true,
      sourceRef: 'contract-fake-source',
      proof: { version: 'owner bytes', digest: 'not-a-new-digest-format' },
      accessRevisionRef: 'current-rights',
    };
    expect(AdoptedHumanSourceProjectionSchema.parse(source)).toEqual(source);
    for (const extra of [
      { adoptedByExecution: false },
      { role: 'user' },
      { approved: true },
      { kind: 'tool-result' },
      { content: 'private message text' },
    ])
      expect(
        AdoptedHumanSourceProjectionSchema.safeParse({ ...source, ...extra })
          .success,
      ).toBe(false);
  });

  it('distinguishes a checked zero-association result from unknown and non-applicable', () => {
    const fact = {
      sourceCheck: 'checked',
      excludedByMethodAuthoring: false,
    };
    expect(OrdinaryOriginClassificationProjectionSchema.parse(fact)).toEqual(
      fact,
    );
    expect(
      OrdinaryOriginClassificationProjectionSchema.safeParse({
        ...fact,
        sourceCheck: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      OrdinaryOriginClassificationProjectionSchema.safeParse({
        ...fact,
        sourceCheck: 'not-applicable',
      }).success,
    ).toBe(true);
    expect(
      OrdinaryOriginClassificationProjectionSchema.safeParse({
        ...fact,
        sourceCheck: 'not-applicable',
        excludedByMethodAuthoring: true,
      }).success,
    ).toBe(false);
    const selector = {
      sourceType: 'existing-owner-source',
      sourceId: 'existing opaque field',
    };
    expect(MemoryOriginSelectorProjectionSchema.parse(selector)).toEqual(
      selector,
    );
    expect(
      MemoryOriginSelectorProjectionSchema.safeParse({ ...selector, scope })
        .success,
    ).toBe(false);
  });
});
