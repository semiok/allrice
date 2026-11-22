/** Explicit caller doubles only; real DB/current sources are covered by PG. */
import { setImmediate as turn } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmployeeBusinessTargetProjection,
  RequestContext,
} from '@allrice/contracts';
import type { createBusinessRuntimeCaller } from '@allrice/database';

const source = vi.hoisted(() => ({ read: vi.fn(), identity: vi.fn() }));
vi.mock('@allrice/database', () => ({
  createBusinessRuntimeCaller: () => ({
    readEmployeeBusinessCurrentPreflight: source.read,
  }),
  requireDEntryNativeIdentity: source.identity,
}));
import { createWorkerCurrentBusinessRuntime } from './current-producer.ts';

type Fact = Awaited<
  ReturnType<
    ReturnType<
      typeof createBusinessRuntimeCaller
    >['readEmployeeBusinessCurrentPreflight']
  >
>;
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
const selected: EmployeeBusinessTargetProjection = {
  workspaceId: id(5),
  employeeInstanceId: id(6),
  threadId: null,
  access: 'management',
  module: { kind: 'builtin', moduleId: 'employee-memory' },
};
function fact(target = selected): Fact {
  return {
    identity: {
      organizationId: id(4),
      workspaceId: id(5),
      personId: id(3),
      employeeInstanceId: id(6),
      employeeRevision: 2,
      employeeVersionId: id(8),
      threadId: target.threadId,
    },
    currentConfiguration: null,
    projection: {
      scope: {
        organizationId: id(4),
        workspaceId: id(5),
        ownerId: id(3),
        employeeInstanceId: id(6),
        employeeId: id(7),
      },
      access: target.access,
      threadId: target.threadId,
      identityRevisionRef: JSON.stringify({
        instanceRevision: 2,
        employeeVersionId: id(8),
      }),
      executionGeneration: target.access === 'execute' ? '4.0' : null,
      module:
        target.module.kind === 'builtin'
          ? {
              ...target.module,
              applicationModules: {
                schemaVersion: 1,
                policy: 'all-enabled',
                applicationBuild: null,
                builtinModules: {
                  deliverables: true,
                  'enterprise-materials': true,
                  'employee-memory': true,
                  capabilities: true,
                },
              },
            }
          : { kind: 'not-applicable' },
    },
  };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  source.read.mockImplementation(async (_context, target) => fact(target));
  source.identity.mockResolvedValue(fact().identity);
});

describe('Worker real factory current preflight consumer with explicit caller fakes', () => {
  it.each([
    'deliverables',
    'enterprise-materials',
    'employee-memory',
    'capabilities',
  ] as const)(
    'selects the original factory management reader for builtin %s without upgrading to execute',
    async (moduleId) => {
      const runtime = createWorkerCurrentBusinessRuntime();
      const target = {
        ...selected,
        module: { kind: 'builtin' as const, moduleId },
      };
      const result = await runtime.read(context, target);
      expect(result.projection.access).toBe('management');
      expect(source.read).toHaveBeenCalledExactlyOnceWith(
        context,
        target,
        undefined,
      );
      expect(source.identity).not.toHaveBeenCalled();
      expect(result.projection.module).not.toHaveProperty('binding');
    },
  );
  it('passes an exact threaded execute selector to the current factory for the existing HTTP/mux identity signature', async () => {
    const runtime = createWorkerCurrentBusinessRuntime();
    const selection = {
      workspaceId: id(5),
      employeeInstanceId: id(6),
      threadId: id(9),
    };
    const result = await runtime.identity(context, selection);
    expect(source.read).toHaveBeenCalledExactlyOnceWith(
      context,
      {
        ...selection,
        access: 'execute',
        module: { kind: 'not-applicable' },
      },
      undefined,
    );
    expect(result.threadId).toBe(selection.threadId);
    expect(source.identity).not.toHaveBeenCalled();
  });
  it('keeps no-thread page/input on its original 271 guard without making a business thread', async () => {
    const runtime = createWorkerCurrentBusinessRuntime();
    const selection = { workspaceId: id(5), employeeInstanceId: id(6) };
    await expect(runtime.identity(context, selection)).resolves.toEqual(
      fact().identity,
    );
    expect(source.identity).toHaveBeenCalledExactlyOnceWith(context, selection);
    expect(source.read).not.toHaveBeenCalled();
  });
  it('does not substitute another source when the real current factory rejects', async () => {
    const denied = Error('original current authority lost');
    source.read.mockRejectedValueOnce(denied);
    await expect(
      createWorkerCurrentBusinessRuntime().read(context, selected),
    ).rejects.toBe(denied);
    expect(source.identity).not.toHaveBeenCalled();
  });
  it('still validates real source scope and does not treat a DTO as transferable authority', async () => {
    const value = fact();
    source.read.mockResolvedValueOnce({
      ...value,
      projection: {
        ...value.projection,
        scope: { ...value.projection.scope, ownerId: id(99) },
      },
    });
    await expect(
      createWorkerCurrentBusinessRuntime().read(context, selected),
    ).rejects.toMatchObject({ code: 'business_runtime_authorization_denied' });
  });
  it('joins an outstanding caller read across request cancellation before returning the original reason', async () => {
    const held = gate<Fact>(),
      stop = new AbortController(),
      reason = Error('request ended');
    source.read.mockReturnValueOnce(held.promise);
    let settled = false;
    const outcome = createWorkerCurrentBusinessRuntime()
      .read(context, selected, stop.signal)
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      expect(source.read).toHaveBeenCalledOnce();
      stop.abort(reason);
      await turn();
      expect(settled).toBe(false);
    } finally {
      held.resolve(fact());
      await outcome;
    }
    expect(await outcome).toEqual({ error: reason });
  });
  it('uses the existing Worker lifetime and still joins an outstanding original no-thread admission', async () => {
    const held = gate<Fact['identity']>(),
      lifetime = new AbortController(),
      reason = Error('Worker ended');
    source.identity.mockReturnValueOnce(held.promise);
    let settled = false;
    const outcome = createWorkerCurrentBusinessRuntime({
      lifetime: lifetime.signal,
    })
      .identity(context, {
        workspaceId: id(5),
        employeeInstanceId: id(6),
      })
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      lifetime.abort(reason);
      await turn();
      expect(settled).toBe(false);
    } finally {
      held.resolve(fact().identity);
      await outcome;
    }
    expect(await outcome).toEqual({ error: reason });
  });
});
