import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdoptedHumanSourceProjection,
  RequestContext,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createEmployeeMemoryPort } from './employee-memory-port.ts';
import { nativeMemoryOperationKey } from './employee-memory-runtime.ts';
import {
  nativeMemoryMetadataKey,
  nativeMemorySource,
  requireStoredNativeMemorySource,
  sourceMetadata,
} from './memory-native-source.ts';
import { readMemoryRuntimeAssembly } from './memory-runtime-binding.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context: RequestContext = {
  requestId: id(1),
  sessionId: id(2),
  actor: { type: 'user', id: id(3) },
  organizationId: id(4),
  workspaceId: id(5),
  memberships: [],
  authenticatedAt: '2026-11-22T00:00:00Z',
};
const scope = {
  organizationId: id(4),
  workspaceId: id(5),
  ownerId: id(3),
  employeeInstanceId: id(6),
  employeeId: id(7),
};
const storageScope = {
  organizationId: id(4),
  workspaceId: id(5),
  ownerId: id(3),
  instanceId: id(6),
  employeeId: id(7),
};
const release = {
  moduleId: 'employee-memory',
  contractVersion: 1 as const,
  contentVersion: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
};
const target = {
  workspaceId: id(5),
  employeeInstanceId: id(6),
  threadId: id(8),
  nativeRequestRef: 'opaque-request',
  moduleRelease: release,
};
const source = (): AdoptedHumanSourceProjection => ({
  scope,
  threadId: id(8),
  b: 'B-original',
  executionBoundaryRef: 'boundary-original',
  rootOriginRef: 'root-origin-original',
  nativeCall: {
    rootSessionRef: 'Root/Case',
    parentSessionRef: null,
    sessionRef: 'Root/Case',
    callRef: 'Call/Case',
    toolId: 'memory_remember',
    toolVersion: 'native-version',
  },
  sourceRef: 'original-human-source',
  proof: { version: 'proof-v1', digest: 'opaque-producer-digest' },
  accessRevisionRef: 'current-access-1',
  kind: 'ordinary-human-message',
});
const original = {
  nativeOwnerRef: 'Owner/Case',
  nativeProfileRef: 'Profile/Original',
};
const live = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe('native memory business boundary, with no production assembly', () => {
  it('has a null private production binding and rejects each native path before opening business SQL', async () => {
    expect(readMemoryRuntimeAssembly()).toBeNull();
    const sql = vi.spyOn(client, 'getDatabase').mockImplementation(() => {
      throw Error('business SQL must not open');
    });
    const port = createEmployeeMemoryPort();
    const stored = source();
    const selector = {
      scope: stored.scope,
      threadId: stored.threadId,
      b: stored.b,
      executionBoundaryRef: stored.executionBoundaryRef,
      rootOriginRef: stored.rootOriginRef,
      nativeCall: stored.nativeCall,
      sourceRef: stored.sourceRef,
    };
    for (const action of [
      () => port.issueContext(context, target, live()),
      () => port.readOrdinal(context, target, { number: 1 }, live()),
      () =>
        port.remember(
          context,
          target,
          { summary: '完整候选', details: null },
          live(),
        ),
      () =>
        port.reconcileRemember(
          context,
          { ...selector, moduleRelease: release },
          live(),
        ),
    ])
      await expect(action()).rejects.toMatchObject({
        code: 'memory_runtime_dependency_unavailable',
      });
    expect(sql).not.toHaveBeenCalled();
  });
  it('never accepts guest source/approval/call metadata in model arguments', async () => {
    const sql = vi.spyOn(client, 'getDatabase').mockImplementation(() => {
      throw Error('business SQL must not open');
    });
    for (const extra of [
      { source: source() },
      { approved: true },
      { b: 'guest-B' },
      { nativeCall: source().nativeCall },
      { idempotencyKey: id(9) },
    ])
      await expect(
        createEmployeeMemoryPort().remember(
          context,
          target,
          { summary: '候选', ...extra },
          live(),
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
    expect(sql).not.toHaveBeenCalled();
  });
  it('preserves pre-admission cancellation without opening SQL', async () => {
    const controller = new AbortController(),
      reason = new Error('native original cancellation');
    controller.abort(reason);
    const sql = vi.spyOn(client, 'getDatabase').mockImplementation(() => {
      throw Error('business SQL must not open');
    });
    await expect(
      createEmployeeMemoryPort().issueContext(
        context,
        target,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('memory-owned original-call and source facts', () => {
  it('keeps source/proof/access changes on the same original-call key, while preserving opaque original tuple bytes', () => {
    const first = sourceMetadata(source(), original),
      key = nativeMemoryOperationKey(first);
    expect(key).toMatch(/^candidate:native:v1:sha256:[a-f0-9]{64}$/);
    expect(key.startsWith('candidate:v2:')).toBe(false);
    expect(
      nativeMemoryOperationKey(
        sourceMetadata(
          {
            ...source(),
            sourceRef: 'different source',
            proof: { version: 'v2', digest: 'changed proof' },
            accessRevisionRef: 'current-access-999',
          },
          original,
        ),
      ),
    ).toBe(key);
    for (const changed of [
      { ...first, b: 'B-other' },
      { ...first, nativeOwnerRef: 'owner/case' },
      { ...first, nativeProfileRef: 'profile/rebound' },
      { ...first, nativeCall: { ...first.nativeCall, callRef: 'call/case' } },
      {
        ...first,
        nativeCall: {
          ...first.nativeCall,
          sessionRef: 'child',
          parentSessionRef: first.nativeCall.rootSessionRef,
        },
      },
      {
        ...first,
        nativeCall: { ...first.nativeCall, toolVersion: 'native-other' },
      },
    ])
      expect(nativeMemoryOperationKey(changed)).not.toBe(key);
    expect(first).not.toHaveProperty('accessRevisionRef');
  });
  it('treats controlled metadata only as stored locators and requires a fresh matching current source projection', async () => {
    const stored = sourceMetadata(source(), original),
      origin = {
        source_type: 'message',
        source_id: null,
        metadata: { [nativeMemoryMetadataKey]: stored },
      };
    const storedSource = vi.fn().mockResolvedValue({
      ...source(),
      accessRevisionRef: 'new-current-revision',
    });
    expect(
      await requireStoredNativeMemorySource(
        { storedSource },
        storageScope,
        origin,
        live(),
      ),
    ).toBe(true);
    expect(storedSource).toHaveBeenCalledOnce();
    storedSource.mockResolvedValue({
      ...source(),
      proof: { version: 'proof-v1', digest: 'changed' },
    });
    await expect(
      requireStoredNativeMemorySource(
        { storedSource },
        storageScope,
        origin,
        live(),
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    storedSource.mockRejectedValue(
      new Error('actual current-source SQL failure'),
    );
    await expect(
      requireStoredNativeMemorySource(
        { storedSource },
        storageScope,
        origin,
        live(),
      ),
    ).rejects.toThrow('actual current-source SQL failure');
  });
  it('rejects corrupted/native metadata on a legacy UUID source and rejects a different employee scope', async () => {
    const metadata = {
        [nativeMemoryMetadataKey]: sourceMetadata(source(), original),
      },
      storedSource = vi.fn();
    expect(nativeMemorySource({ unrelated: source() })).toBeNull();
    expect(() =>
      nativeMemorySource({ [nativeMemoryMetadataKey]: { version: 1 } }),
    ).toThrow();
    for (const [s, origin] of [
      [storageScope, { source_type: 'message', source_id: id(9), metadata }],
      [
        { ...storageScope, employeeId: id(10) },
        { source_type: 'message', source_id: null, metadata },
      ],
    ] as const)
      await expect(
        requireStoredNativeMemorySource({ storedSource }, s, origin, live()),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(storedSource).not.toHaveBeenCalled();
  });
});
