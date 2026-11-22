import type {
  DEntryIdentity,
  EmployeeInstance,
  RequestContext,
} from '@allrice/contracts';
import { setImmediate as turn } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readers = vi.hoisted(() => ({
  resolveDEntryIdentity: vi.fn(),
  requireDEntryNativeIdentity: vi.fn(),
  getEmployeeInstance: vi.fn(),
  getEmployeeInstanceForHistory: vi.fn(),
  readApplicationBuiltinModules: vi.fn(),
}));
// Explicit identity contract fakes; the production module imports these exact
// public symbols. No fake is registered in a production composition.
vi.mock('@allrice/database', () => readers);
import { readDEntryBusinessIdentity } from './d-entry-current.ts';

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
const selected = {
  workspaceId: id(5),
  employeeInstanceId: id(6),
  threadId: id(7),
};
const identity = (): DEntryIdentity => ({
  organizationId: id(4),
  workspaceId: id(5),
  personId: id(3),
  employeeInstanceId: id(6),
  employeeRevision: 2,
  employeeVersionId: id(8),
  threadId: id(7),
});
const instance = (): EmployeeInstance => ({
  id: id(6),
  assignmentId: id(9),
  organizationId: id(4),
  workspaceId: id(5),
  ownerId: id(3),
  kind: 'custom',
  revision: 2,
  profile: { name: 'contract fixture' },
  creationSource: { kind: 'tenant_version', employeeVersionId: id(8) },
  source: { kind: 'tenant_version', employeeVersionId: id(8) },
  createdAt: '2026-11-21T00:00:00Z',
  updatedAt: '2026-11-22T00:00:00Z',
  archivedAt: null,
});
const applicationModules = () => ({
  schemaVersion: 1 as const,
  policy: 'all-enabled' as const,
  applicationBuild: null,
  builtinModules: {
    deliverables: true,
    'enterprise-materials': true,
    'employee-memory': true,
    capabilities: true,
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  readers.requireDEntryNativeIdentity.mockResolvedValue(identity());
  readers.resolveDEntryIdentity.mockResolvedValue(identity());
  readers.getEmployeeInstance.mockResolvedValue(instance());
  readers.getEmployeeInstanceForHistory.mockResolvedValue(instance());
  readers.readApplicationBuiltinModules.mockResolvedValue(applicationModules());
});

describe('real 271 symbol identity adapter with explicit contract fakes', () => {
  it('uses native execution eligibility and the current instance without inventing employee or module/B facts', async () => {
    const result = await readDEntryBusinessIdentity(
      context,
      selected,
      'execute',
    );
    expect(readers.requireDEntryNativeIdentity).toHaveBeenCalledWith(
      context,
      selected,
    );
    expect(readers.getEmployeeInstance).toHaveBeenCalledWith(context, id(6));
    expect(readers.resolveDEntryIdentity).not.toHaveBeenCalled();
    expect(readers.getEmployeeInstanceForHistory).not.toHaveBeenCalled();
    expect(result.identity).toEqual(identity());
    expect(result.instance.assignmentId).toBe(id(9));
    expect(result.applicationModules).toEqual(applicationModules());
    expect(
      readers.readApplicationBuiltinModules,
    ).toHaveBeenCalledExactlyOnceWith('worker');
    for (const key of ['employeeId', 'b', 'module', 'enabled_modules'])
      expect(result).not.toHaveProperty(key);
    expect(result.instance).not.toHaveProperty('employeeId');
    expect(result.instance).not.toHaveProperty('profile');
  });

  it('keeps cold history eligible through its actual reader, including archived instances, without execute fallback', async () => {
    const archived = { ...instance(), archivedAt: '2026-11-22T01:00:00Z' };
    readers.getEmployeeInstanceForHistory.mockResolvedValue(archived);
    const result = await readDEntryBusinessIdentity(
      context,
      selected,
      'history',
    );
    expect(result.instance.archivedAt).toBe(archived.archivedAt);
    expect(readers.resolveDEntryIdentity).toHaveBeenCalledWith(
      context,
      selected,
      'history',
    );
    expect(readers.requireDEntryNativeIdentity).not.toHaveBeenCalled();
    expect(readers.getEmployeeInstance).not.toHaveBeenCalled();
    expect(
      readers.readApplicationBuiltinModules,
    ).toHaveBeenCalledExactlyOnceWith('worker');
  });

  it('rechecks current execution rights after the build read and never falls back to history', async () => {
    const denied = Error('current membership withdrawn');
    readers.requireDEntryNativeIdentity
      .mockResolvedValueOnce(identity())
      .mockRejectedValueOnce(denied);
    await expect(
      readDEntryBusinessIdentity(context, selected, 'execute'),
    ).rejects.toBe(denied);
    expect(readers.readApplicationBuiltinModules).toHaveBeenCalledTimes(1);
    expect(readers.resolveDEntryIdentity).not.toHaveBeenCalled();
  });

  it('rejects an assignment changed during module reading even when the visible identity revision is unchanged', async () => {
    readers.getEmployeeInstance
      .mockResolvedValueOnce(instance())
      .mockResolvedValueOnce({ ...instance(), assignmentId: id(99) });
    await expect(
      readDEntryBusinessIdentity(context, selected, 'execute'),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });

  it('does not replace a failed trusted build read with binding, request or environment claims', async () => {
    const failed = Error('invalid application build seal');
    readers.readApplicationBuiltinModules.mockRejectedValueOnce(failed);
    await expect(
      readDEntryBusinessIdentity(context, selected, 'history'),
    ).rejects.toBe(failed);
    expect(readers.resolveDEntryIdentity).toHaveBeenCalledTimes(1);
    expect(readers.requireDEntryNativeIdentity).not.toHaveBeenCalled();
  });

  it('joins a pending application read on cancellation and does not begin a late current lookup', async () => {
    let entered!: () => void,
      finish!: (value: ReturnType<typeof applicationModules>) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    readers.readApplicationBuiltinModules.mockImplementationOnce(() => {
      entered();
      return new Promise<ReturnType<typeof applicationModules>>((resolve) => {
        finish = resolve;
      });
    });
    const stop = new AbortController(),
      reason = Error('cancelled during policy read');
    let settled = false;
    const outcome = readDEntryBusinessIdentity(
      context,
      selected,
      'execute',
      stop.signal,
    )
      .then(
        () => null,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    try {
      await started;
      stop.abort(reason);
      await turn();
      expect(settled).toBe(false);
      expect(readers.requireDEntryNativeIdentity).toHaveBeenCalledTimes(1);
      finish(applicationModules());
      expect(await outcome).toBe(reason);
      expect(readers.requireDEntryNativeIdentity).toHaveBeenCalledTimes(1);
    } finally {
      finish(applicationModules());
      await outcome;
    }
  });

  it('preserves a native denial and never retries it through history', async () => {
    const denied = new Error('original native qualification denied');
    readers.requireDEntryNativeIdentity.mockRejectedValue(denied);
    await expect(
      readDEntryBusinessIdentity(context, selected, 'execute'),
    ).rejects.toBe(denied);
    expect(readers.resolveDEntryIdentity).not.toHaveBeenCalled();
    expect(readers.getEmployeeInstance).not.toHaveBeenCalled();
    expect(readers.readApplicationBuiltinModules).not.toHaveBeenCalled();
  });

  it.each([
    'organizationId',
    'workspaceId',
    'personId',
    'employeeInstanceId',
    'threadId',
  ] as const)(
    'rejects an identity for another %s before further reads',
    async (field) => {
      readers.requireDEntryNativeIdentity.mockResolvedValue({
        ...identity(),
        [field]: id(99),
      });
      await expect(
        readDEntryBusinessIdentity(context, selected, 'execute'),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
      expect(readers.getEmployeeInstance).not.toHaveBeenCalled();
    },
  );

  it.each([
    'id',
    'organizationId',
    'workspaceId',
    'ownerId',
    'revision',
    'source',
    'archivedAt',
  ] as const)(
    'rejects a changed/currently ineligible instance %s',
    async (field) => {
      const changed = {
        ...instance(),
        [field]:
          field === 'revision'
            ? 3
            : field === 'source'
              ? { kind: 'tenant_version', employeeVersionId: id(99) }
              : field === 'archivedAt'
                ? '2026-11-22T01:00:00Z'
                : id(99),
      };
      readers.getEmployeeInstance.mockResolvedValue(changed);
      await expect(
        readDEntryBusinessIdentity(context, selected, 'execute'),
      ).rejects.toMatchObject({
        code: 'business_runtime_authorization_denied',
      });
    },
  );

  it('rejects a guest access mode or mismatched original context without routing to history', async () => {
    await expect(
      readDEntryBusinessIdentity(context, selected, 'management' as 'execute'),
    ).rejects.toMatchObject({ code: 'business_runtime_projection_invalid' });
    await expect(
      readDEntryBusinessIdentity(
        { ...context, workspaceId: id(99) },
        selected,
        'execute',
      ),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
    expect(readers.requireDEntryNativeIdentity).not.toHaveBeenCalled();
    expect(readers.resolveDEntryIdentity).not.toHaveBeenCalled();
  });

  it('joins a signal-less 271 read before suppressing its late result', async () => {
    let resolveIdentity!: (value: DEntryIdentity) => void;
    readers.requireDEntryNativeIdentity.mockReturnValue(
      new Promise<DEntryIdentity>((resolve) => {
        resolveIdentity = resolve;
      }),
    );
    const controller = new AbortController();
    const reason = new Error('original caller cancellation');
    let settled = false;
    const result = readDEntryBusinessIdentity(
      context,
      selected,
      'execute',
      controller.signal,
    ).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveIdentity(identity());
    expect(await result).toBe(reason);
    expect(readers.getEmployeeInstance).not.toHaveBeenCalled();
  });
});
