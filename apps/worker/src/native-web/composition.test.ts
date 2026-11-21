import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type {
  PersonVmBootstrapScope,
  PersonVmWebStartup,
} from '@allrice/person-vm';
import {
  createAssignedNativeWebStartup,
  personNativeWebRoster,
} from './composition.js';
const { open, prepareRoster } = vi.hoisted(() => ({
  open: vi.fn(),
  prepareRoster: vi.fn(),
}));
vi.mock('./owner.js', () => ({ openNativeWebOwner: open }));
vi.mock('@allrice/database', () => ({
  preparePersonNativeWebRoster: prepareRoster,
}));
afterEach(() => vi.resetAllMocks());
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    leaseEpoch: 3,
  };
  const context: RequestContext = {
    actor: { type: 'user', id: binding.personId },
    organizationId: binding.organizationId,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    workspaceId: null,
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const web: PersonVmWebStartup = {
    context,
    receipt: {
      binding,
      rosterDigest: `sha256:${'a'.repeat(64)}`,
      endpoints: [32171, 32172].map((hostPort) => ({
        workspaceId: randomUUID(),
        employeeInstanceId: randomUUID(),
        employeeRevision: 2,
        employeeVersionId: randomUUID(),
        hostPort,
        guestPort: hostPort,
      })),
    },
  };
  const lifetime = new AbortController(),
    startup = new AbortController();
  const memory = {
    files: [
      { path: '/person/init.cjs', contents: '// fixture plan', mode: 0o600 },
    ],
    initialize: { executable: 'node' as const, args: ['/person/init.cjs'] },
    launcher: '/person/launcher',
    env: {},
  };
  const memoryGuestPlan = vi.fn(async () => memory);
  const service = createAssignedNativeWebStartup({
    vm: { assertCurrentBinding: vi.fn() },
    memoryGuestPlan,
    lifetime: lifetime.signal,
    cleanupTimeoutMs: 5000,
    configuration: {
      cliPath: '/opt/dsh/lib/bin.js',
      guestAddress: '10.0.0.2',
      startupTimeoutMs: 3000,
      publicUrl: (endpoint) =>
        `https://native.example.test/e/${endpoint.employeeInstanceId}/`,
    },
  });
  const scope = {
    binding,
    signal: startup.signal,
    assertCurrent: vi.fn(async () => {}),
    launch: vi.fn(),
  } as PersonVmBootstrapScope;
  return {
    binding,
    web,
    memory,
    memoryGuestPlan,
    service,
    scope,
    startup,
    lifetime,
  };
}
it('实际DB producer直接绑定service roster，取消仍等待已发SQL结束；不接受请求体清单', async () => {
  const f = fixture(),
    entered = latch(),
    joined = latch(),
    cancellation = new AbortController();
  prepareRoster.mockImplementationOnce(async () => {
    entered.resolve();
    await joined.promise;
    return {
      personId: f.binding.personId,
      organizationId: f.binding.organizationId,
      entries: f.web.receipt.endpoints,
      digest: f.web.receipt.rosterDigest,
    };
  });
  let settled = false;
  const reading = personNativeWebRoster
    .prepare(f.web.context, cancellation.signal)
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  cancellation.abort();
  await new Promise<void>((done) => setImmediate(done));
  expect(settled).toBe(false);
  joined.resolve();
  expect(await reading).toBeDefined();
  expect(prepareRoster).toHaveBeenCalledExactlyOnceWith(f.web.context);
  await f.service.close();
});
it('实际employee receipt派生独立HOME/共享workdir；真实public owner逐个接收绑定，control不冒充editor ready', async () => {
  const f = fixture(),
    owners = f.web.receipt.endpoints.map(() => ({
      close: vi.fn(async () => {}),
    }));
  owners.forEach((owner) => open.mockResolvedValueOnce(owner));
  const plan = await f.service.memoryGuestPlan(
    f.binding,
    f.scope.signal,
    f.web,
  );
  expect(plan.initialize).toBe(f.memory.initialize);
  expect(plan.launcher).toBe(f.memory.launcher);
  expect(plan.files).toHaveLength(1 + 2 * f.web.receipt.endpoints.length);
  await f.service.start(f.binding, f.scope.signal, f.scope, f.web);
  expect(f.memoryGuestPlan).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(2);
  for (const [index, endpoint] of f.web.receipt.endpoints.entries()) {
    const input = open.mock.calls[index]![0];
    expect(input.context).toBe(f.web.context);
    expect(input.scope).toBe(f.scope);
    expect(input.launch.binding).toEqual(f.binding);
    expect(input.launch.auth.origin).toBe(
      `http://127.0.0.1:${endpoint.hostPort}/`,
    );
    expect(input.launch.command.env).toEqual({
      DSH_HOME: `/work/.allrice/employees/${endpoint.employeeInstanceId}/dsh`,
      DSH_AGENTS_HOME: `/work/.allrice/employees/${endpoint.employeeInstanceId}/agents`,
    });
    expect(input.launch.command.workdir).toBe('/work');
    expect(input.lifetime).not.toBe(f.scope.signal);
    expect(f.service.owner(f.binding, endpoint.employeeInstanceId)).toBe(
      owners[index],
    );
  }
  expect(f.service).not.toHaveProperty('readiness');
  f.startup.abort();
  expect(owners[0]!.close).not.toHaveBeenCalled();
  await f.service.close();
  expect(owners.every((owner) => owner.close.mock.calls.length === 1)).toBe(
    true,
  );
  expect(() =>
    f.service.owner(f.binding, f.web.receipt.endpoints[0]!.employeeInstanceId),
  ).toThrow();
});
it('startup缺真实receipt或当前epoch不匹配时，在memory/native owner副作用前拒绝', async () => {
  const f = fixture();
  await expect(
    f.service.memoryGuestPlan(f.binding, f.scope.signal),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  await expect(
    f.service.memoryGuestPlan(
      { ...f.binding, leaseEpoch: 4 },
      f.scope.signal,
      f.web,
    ),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  expect(f.memoryGuestPlan).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await f.service.close();
});
it('close与未settle的真实owner启动竞态：先关新准入，再等待晚到owner的实际close join', async () => {
  const f = fixture(),
    entered = latch(),
    release = latch(),
    joined = latch(),
    closeEntered = latch();
  const owner = {
    close: vi.fn(async () => {
      closeEntered.resolve();
      await joined.promise;
    }),
  };
  open.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return owner;
  });
  await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
  const starting = f.service
    .start(f.binding, f.scope.signal, f.scope, f.web)
    .catch((error: unknown) => error);
  await entered.promise;
  let ended = false;
  const closing = f.service.close().then(() => {
    ended = true;
  });
  await expect(
    f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web),
  ).rejects.toBeDefined();
  release.resolve();
  await closeEntered.promise;
  expect(ended).toBe(false);
  joined.resolve();
  expect(await starting).toBeDefined();
  await closing;
  expect(ended).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  '第二个employee失败必须join第一个；unknown=%s保留真实错误不重放',
  async (unknown) => {
    const f = fixture(),
      close = vi.fn(async () => {
        if (unknown) throw Error('unknown exact job close');
      });
    open
      .mockResolvedValueOnce({ close })
      .mockRejectedValueOnce(Error('native auth failed'));
    await f.service.memoryGuestPlan(f.binding, f.scope.signal, f.web);
    const starting = f.service.start(f.binding, f.scope.signal, f.scope, f.web);
    if (unknown)
      await expect(starting).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
    else await expect(starting).rejects.toThrow('native auth failed');
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    if (unknown)
      await expect(f.service.close()).rejects.toMatchObject({
        code: 'CLEANUP_INCOMPLETE',
      });
    else await f.service.close();
  },
);
