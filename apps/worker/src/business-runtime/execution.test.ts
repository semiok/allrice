import type {
  ActualNativeExecutionSelectorProjection,
  LogicalExecutionBindingProjection,
  RequestContext,
} from '@allrice/contracts';
import { describe, expect, it, vi } from 'vitest';
import { readActualExecution, readStoredExecution } from './execution.ts';

const id = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const contractFakeContext: RequestContext = {
  requestId: id('1'),
  sessionId: id('2'),
  actor: { type: 'user', id: id('3') },
  organizationId: id('4'),
  workspaceId: id('5'),
  memberships: [],
  authenticatedAt: '2026-11-22T00:00:00Z',
};
const target: ActualNativeExecutionSelectorProjection = {
  workspaceId: id('5'),
  employeeInstanceId: id('6'),
  threadId: id('8'),
  nativeRequestRef: 'contract-fake-actual-request',
};
const contractFakeBinding = (): LogicalExecutionBindingProjection => ({
  scope: {
    organizationId: id('4'),
    workspaceId: id('5'),
    ownerId: id('3'),
    employeeInstanceId: id('6'),
    employeeId: id('7'),
  },
  threadId: id('8'),
  executionGeneration: '4.0',
  b: 'contract-fake-logical-B',
  executionBoundaryRef: 'contract-fake-real-boundary',
  rootOriginRef: 'original-birth',
  rootSessionRef: 'root',
  nativeCall: {
    rootSessionRef: 'root',
    parentSessionRef: null,
    sessionRef: 'root',
    callRef: 'actual-call',
    toolId: 'owner.tool',
    toolVersion: 'v1',
  },
});

describe('logical execution projection with explicit contract fakes', () => {
  it('preserves producer B through reconnect and projects a different producer B for a new execution', async () => {
    const binding = contractFakeBinding();
    const actual = vi.fn(
      async (
        _context: RequestContext,
        selected: ActualNativeExecutionSelectorProjection,
      ) => ({
        nativeRequestRef: selected.nativeRequestRef,
        binding:
          selected.nativeRequestRef === 'contract-fake-new-execution'
            ? {
                ...binding,
                b: 'contract-fake-new-B',
                executionBoundaryRef: 'new-boundary',
              }
            : binding,
      }),
    );
    const first = await readActualExecution(
      { actual },
      contractFakeContext,
      target,
    );
    const reconnected = await readActualExecution(
      { actual },
      contractFakeContext,
      {
        ...target,
        nativeRequestRef: 'contract-fake-reconnect-request',
      },
    );
    const next = await readActualExecution({ actual }, contractFakeContext, {
      ...target,
      nativeRequestRef: 'contract-fake-new-execution',
    });
    expect(first).toEqual(reconnected);
    expect(next.b).not.toBe(first.b);
    expect(first.b).not.toBe(target.nativeRequestRef);
    expect(first.b).not.toBe(first.rootSessionRef);
  });

  it('reads an original stored B without consulting a live execution or creating another association', async () => {
    const binding = contractFakeBinding();
    const stored = vi.fn(async () => binding);
    const actual = vi.fn(async () => {
      throw new Error('old execution is offline');
    });
    const original = {
      workspaceId: target.workspaceId,
      employeeInstanceId: target.employeeInstanceId,
      threadId: target.threadId,
      b: binding.b,
    };
    expect(
      await readStoredExecution(
        { stored, actual },
        contractFakeContext,
        original,
      ),
    ).toEqual(binding);
    expect(actual).not.toHaveBeenCalled();
    await expect(
      readStoredExecution(
        { stored: async () => ({ ...binding, b: 'replacement-B' }) },
        contractFakeContext,
        original,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });

  it('does not manufacture B when the native producer or original stored association is missing', async () => {
    await expect(
      readActualExecution({}, contractFakeContext, target),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
    await expect(
      readStoredExecution({}, contractFakeContext, {
        workspaceId: target.workspaceId,
        employeeInstanceId: target.employeeInstanceId,
        threadId: target.threadId,
        b: 'selector-is-not-authority',
      }),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
    await expect(
      readActualExecution(
        {
          actual: async () => ({
            nativeRequestRef: target.nativeRequestRef,
            binding: { ...contractFakeBinding(), b: null },
          }),
        },
        contractFakeContext,
        target,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_projection_invalid' });
  });

  it('rejects an observation from another request, thread, person or root-call association', async () => {
    const binding = contractFakeBinding();
    const observations = [
      { nativeRequestRef: 'other-request', binding },
      {
        nativeRequestRef: target.nativeRequestRef,
        binding: { ...binding, threadId: id('99') },
      },
      {
        nativeRequestRef: target.nativeRequestRef,
        binding: { ...binding, scope: { ...binding.scope, ownerId: id('99') } },
      },
      {
        nativeRequestRef: target.nativeRequestRef,
        binding: {
          ...binding,
          nativeCall: { ...binding.nativeCall, rootSessionRef: 'other-root' },
        },
      },
    ];
    for (const observed of observations)
      await expect(
        readActualExecution(
          { actual: async () => observed },
          contractFakeContext,
          target,
        ),
      ).rejects.toThrow();
  });
});
