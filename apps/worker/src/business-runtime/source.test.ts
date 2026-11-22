import type {
  ActualNativeCallSelectorProjection,
  AdoptedHumanSourceProjection,
  MemoryOriginSelectorProjection,
  RequestContext,
} from '@allrice/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyOrdinaryMemoryOrigin,
  readStoredHumanSource,
  resolveAdoptedHumanSource,
} from './source.ts';

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
const target: ActualNativeCallSelectorProjection = {
  scope: {
    organizationId: id('4'),
    workspaceId: id('5'),
    ownerId: id('3'),
    employeeInstanceId: id('6'),
    employeeId: id('7'),
  },
  threadId: id('8'),
  b: 'contract-fake-B',
  executionBoundaryRef: 'contract-fake-boundary',
  rootOriginRef: 'original-birth',
  nativeCall: {
    rootSessionRef: 'root',
    parentSessionRef: null,
    sessionRef: 'root',
    callRef: 'call',
    toolId: 'owner.remember',
    toolVersion: 'owner-version',
  },
};
const contractFakeSource = (): AdoptedHumanSourceProjection => ({
  ...structuredClone(target),
  kind: 'ordinary-human-message',
  sourceRef: 'original-human-source',
  proof: { version: 'owner-proof-version', digest: 'owner-proof-bytes' },
  accessRevisionRef: 'current-source-rights-revision',
});

describe('human source projection with explicit contract fakes', () => {
  it('requires the real source dependency instead of accepting guest role=user, approved or raw call IDs', async () => {
    await expect(
      resolveAdoptedHumanSource({}, contractFakeContext, target),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
    for (const extra of [
      { role: 'user' },
      { approved: true },
      { kind: 'tool-result' },
      { content: 'not a source disclosure API' },
    ])
      await expect(
        resolveAdoptedHumanSource(
          { adopted: async () => ({ ...contractFakeSource(), ...extra }) },
          contractFakeContext,
          target,
        ),
      ).rejects.toMatchObject({ code: 'business_runtime_projection_invalid' });
  });

  it('projects ordinary human provenance or actual adopted steering without creating another proof format', async () => {
    const source = contractFakeSource();
    expect(
      await resolveAdoptedHumanSource(
        { adopted: async () => source },
        contractFakeContext,
        target,
      ),
    ).toEqual(source);
    const steering = {
      ...source,
      kind: 'adopted-steering',
      adoptedByExecution: true,
    };
    expect(
      await resolveAdoptedHumanSource(
        { adopted: async () => steering },
        contractFakeContext,
        target,
      ),
    ).toEqual(steering);
    await expect(
      resolveAdoptedHumanSource(
        { adopted: async () => ({ ...steering, adoptedByExecution: false }) },
        contractFakeContext,
        target,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_projection_invalid' });
  });

  it('requires every original execution/call coordinate to match the owner observation', async () => {
    const source = contractFakeSource();
    const mismatches = [
      { ...source, scope: { ...source.scope, employeeId: id('99') } },
      { ...source, threadId: id('99') },
      { ...source, b: 'other-B' },
      { ...source, executionBoundaryRef: 'other-boundary' },
      { ...source, rootOriginRef: 'new-birth' },
      ...(
        [
          'rootSessionRef',
          'parentSessionRef',
          'sessionRef',
          'callRef',
          'toolId',
          'toolVersion',
        ] as const
      ).map((field) => ({
        ...source,
        nativeCall: { ...source.nativeCall, [field]: 'other-coordinate' },
      })),
    ];
    for (const value of mismatches)
      await expect(
        resolveAdoptedHumanSource(
          { adopted: async () => value },
          contractFakeContext,
          target,
        ),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
  });

  it('does not infer child remember authority from its parent or shared B', async () => {
    const childTarget = {
      ...target,
      nativeCall: {
        ...target.nativeCall,
        parentSessionRef: 'root',
        sessionRef: 'child',
        callRef: 'child-call',
      },
    };
    const denied = new Error('contract-fake owner denied child source access');
    const adopted = vi.fn(async () => {
      throw denied;
    });
    await expect(
      resolveAdoptedHumanSource({ adopted }, contractFakeContext, childTarget),
    ).rejects.toBe(denied);
    expect(adopted).toHaveBeenCalledWith(
      contractFakeContext,
      childTarget,
      undefined,
    );
  });

  it('rechecks a stored source without requiring the old execution live or reissuing the original proof', async () => {
    const source = contractFakeSource();
    const storedTarget = { ...target, sourceRef: source.sourceRef };
    const adopted = vi.fn(async () => {
      throw new Error('old execution offline');
    });
    const result = await readStoredHumanSource(
      { stored: async () => source, adopted },
      contractFakeContext,
      storedTarget,
    );
    expect(result.proof).toEqual(source.proof);
    expect(adopted).not.toHaveBeenCalled();
    await expect(
      readStoredHumanSource(
        {
          stored: async () => ({ ...source, sourceRef: 'replacement-source' }),
        },
        contractFakeContext,
        storedTarget,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });
});

describe('ordinary exclusion fact with explicit contract fakes', () => {
  const origin: MemoryOriginSelectorProjection = {
    sourceType: 'message',
    sourceId: id('9'),
  };
  const contractFakeFact = (excluded: boolean) => ({
    sourceCheck: 'checked',
    excludedByMethodAuthoring: excluded,
  });

  it('keeps authorized zero method-authoring associations as checked and not excluded, including no legacy match', async () => {
    for (const sourceType of ['message', 'checkpoint'] as const) {
      for (const sourceId of [id('9'), null]) {
        const selected = { ...origin, sourceType, sourceId };
        const result = await classifyOrdinaryMemoryOrigin(
          { classify: async () => contractFakeFact(false) },
          selected,
        );
        expect(result).toMatchObject({
          sourceCheck: 'checked',
          excludedByMethodAuthoring: false,
        });
      }
    }
    expect(
      await classifyOrdinaryMemoryOrigin(
        { classify: async () => contractFakeFact(true) },
        origin,
      ),
    ).toMatchObject({ excludedByMethodAuthoring: true });
  });

  it('preserves real non-applicable source semantics only through a completed owner classification', async () => {
    const selected = { ...origin, sourceType: 'user' as const, sourceId: null };
    const fact = {
      ...contractFakeFact(false),
      sourceCheck: 'not-applicable',
    };
    expect(
      await classifyOrdinaryMemoryOrigin(
        { classify: async () => fact },
        selected,
      ),
    ).toEqual(fact);
    await expect(
      classifyOrdinaryMemoryOrigin({}, selected),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
    await expect(
      classifyOrdinaryMemoryOrigin(
        {
          classify: async () => ({
            ...contractFakeFact(false),
            sourceCheck: 'not-applicable',
          }),
        },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });

  it('never converts query failure, unchecked permission or unknown classification into ordinary access', async () => {
    const failure = new Error(
      'contract-fake source query permission incomplete',
    );
    await expect(
      classifyOrdinaryMemoryOrigin(
        {
          classify: async () => {
            throw failure;
          },
        },
        origin,
      ),
    ).rejects.toBe(failure);
    await expect(
      classifyOrdinaryMemoryOrigin({}, origin),
    ).rejects.toMatchObject({
      code: 'business_runtime_dependency_unavailable',
    });
    await expect(
      classifyOrdinaryMemoryOrigin(
        {
          classify: async () => ({
            ...contractFakeFact(false),
            sourceCheck: 'unknown',
          }),
        },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_projection_invalid' });
  });

  it('passes only the original source selector and signal to the privately scoped reader', async () => {
    const classify = vi.fn(async () => contractFakeFact(false));
    const signal = new AbortController().signal;
    await classifyOrdinaryMemoryOrigin({ classify }, origin, signal);
    expect(classify).toHaveBeenCalledWith(origin, signal);
    await expect(
      classifyOrdinaryMemoryOrigin({ classify }, {
        ...origin,
        scope: target.scope,
      } as MemoryOriginSelectorProjection),
    ).rejects.toThrow();
    expect(classify).toHaveBeenCalledOnce();
  });
});
