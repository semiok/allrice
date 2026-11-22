import type { EmployeeMemoryPort } from '@allrice/database';
import type { AllriceMcpScope } from './allrice-server.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  identity: vi.fn(),
  read: vi.fn(),
  remember: vi.fn(),
}));
// Explicit identity/business contract fakes. The production adapter still
// imports the actual 271 reader and the public memory port, never these fakes.
vi.mock('../business-runtime/d-entry-current.ts', () => ({
  readDEntryBusinessIdentity: fixtures.identity,
}));
import { bindEmployeeMemoryMcpServices } from './employee-memory-services.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const release = {
  moduleId: 'employee-memory',
  contractVersion: 1 as const,
  contentVersion: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
};
const scope: AllriceMcpScope = {
  personId: id(1),
  organizationId: id(2),
  workspaceId: id(3),
  employeeInstanceId: id(4),
  allriceThreadRef: id(5),
  nativeSessionRef: {
    instanceId: 'transport-instance',
    profileId: 'transport-profile',
    sessionId: 'transport-child',
  },
  executionGeneration: '4.0',
  enabledModules: ['employee-memory'],
  moduleConfigRevisionRef: 'current-transport-config',
  nativeCallRef: 'opaque-observed-request',
  requestContext: {
    actor: { type: 'user', id: id(1) },
    organizationId: id(2),
    workspaceId: id(3),
    requestId: id(6),
    sessionId: id(7),
    memberships: [],
    authenticatedAt: '2026-11-22T00:00:00Z',
  },
};
const target = {
  workspaceId: id(3),
  employeeInstanceId: id(4),
  threadId: id(5),
  nativeRequestRef: 'actual-host-request',
  moduleRelease: release,
};
const port: Pick<EmployeeMemoryPort, 'readOrdinal' | 'remember'> = {
  readOrdinal: fixtures.read,
  remember: fixtures.remember,
};
const live = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  fixtures.identity.mockResolvedValue({});
  fixtures.read.mockResolvedValue('complete already-metered detail');
  fixtures.remember.mockResolvedValue({
    id: id(8),
    revision: 1,
    pairDigest: 'sha256:internal',
    summary: '待确认候选',
    memoryClass: 'work_note',
    state: 'pending',
    requiresConfirmation: true,
    details: 'not disclosed',
  });
});
describe('formal MCP memory callbacks with explicit contracts', () => {
  it('keeps production target/B/call producer missing and refuses without invoking business or identity reads', async () => {
    const services = bindEmployeeMemoryMcpServices({ port });
    for (const operation of [
      () => services.memoryRead!(scope, { number: 1 }, live()),
      () => services.memoryRemember!(scope, { summary: '候选' }, live()),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: 'business_runtime_dependency_unavailable',
        dependency: 'memory.native-target',
      });
    expect(fixtures.identity).not.toHaveBeenCalled();
    expect(fixtures.read).not.toHaveBeenCalled();
    expect(fixtures.remember).not.toHaveBeenCalled();
  });
  it('uses original authenticated scope and the actual execute identity reader before the business port', async () => {
    const actual = vi.fn().mockResolvedValue(target),
      services = bindEmployeeMemoryMcpServices({ port, targets: { actual } });
    const signal = live();
    expect(await services.memoryRead!(scope, { number: 1 }, signal)).toEqual({
      content: [{ type: 'text', text: 'complete already-metered detail' }],
    });
    expect(actual).toHaveBeenCalledWith(scope, signal);
    expect(fixtures.identity).toHaveBeenCalledWith(
      scope.requestContext,
      { workspaceId: id(3), employeeInstanceId: id(4), threadId: id(5) },
      'execute',
      signal,
    );
    expect(fixtures.read).toHaveBeenCalledWith(
      scope.requestContext,
      target,
      { number: 1 },
      signal,
    );
    const result = await services.memoryRemember!(
      scope,
      { summary: '候选' },
      signal,
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: id(8),
            summary: '待确认候选',
            memoryClass: 'work_note',
            state: 'pending',
            requiresConfirmation: true,
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('details');
    expect(JSON.stringify(result)).not.toContain('pairDigest');
  });
  it.each([
    { workspaceId: id(9) },
    { employeeInstanceId: id(9) },
    { threadId: id(9) },
    { moduleRelease: { ...release, moduleId: 'deliverables' } },
  ])(
    'rejects a host projection for a different memory target %j',
    async (changed) => {
      const services = bindEmployeeMemoryMcpServices({
        port,
        targets: {
          actual: vi.fn().mockResolvedValue({ ...target, ...changed }),
        },
      });
      await expect(
        services.memoryRead!(scope, { number: 1 }, live()),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
      expect(fixtures.identity).not.toHaveBeenCalled();
      expect(fixtures.read).not.toHaveBeenCalled();
    },
  );
  it('joins a signal-less identity promise before suppressing the late result', async () => {
    let done!: () => void;
    fixtures.identity.mockReturnValue(
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    const controller = new AbortController(),
      reason = Error('original native abort');
    const services = bindEmployeeMemoryMcpServices({
      port,
      targets: { actual: async () => target },
    });
    const operation = services.memoryRead!(
      scope,
      { number: 1 },
      controller.signal,
    );
    await vi.waitFor(() => expect(fixtures.identity).toHaveBeenCalledOnce());
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    await expect(operation).rejects.toBe(reason);
    expect(fixtures.read).not.toHaveBeenCalled();
  });
});
