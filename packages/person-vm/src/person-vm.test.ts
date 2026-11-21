import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PersonVmError,
  PERSON_VM_COLD_MS,
  PERSON_VM_IDLE_MS,
} from './contract.ts';
import { PersonVmService } from './person-vm.ts';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import type { PersonVmBootstrapScope } from './guest-bootstrap.ts';
import {
  context,
  harness,
  idleFor,
  MemoryStore,
  running,
  signal,
} from './test-support.ts';

describe('host lifecycle service entrypoints (synthetic runtime; not real VM acceptance)', () => {
  it('starting scope核现权/出口；callback完结后失效，running重复入口不重init', async () => {
    const h = harness(),
      rc = context();
    let scope!: PersonVmBootstrapScope;
    h.runtime.start = async (_binding, _signal, current) => {
      scope = current;
      expect(h.log.indexOf('native:bootstrap')).toBeGreaterThan(
        h.log.indexOf('native:create'),
      );
      await scope.assertCurrent();
      h.authorize(false);
      await expect(scope.assertCurrent()).rejects.toMatchObject({
        code: 'AUTHORIZATION_DENIED',
      });
      h.authorize(true);
      h.active.clear();
      await expect(scope.assertCurrent()).rejects.toMatchObject({
        code: 'EGRESS_UNAVAILABLE',
      });
      // Restore the exact current receipt, not a second binding.
      const row = await h.store.read(rc.actor.id);
      h.active.add(row!.egressReceipt!.bindingId);
    };
    await h.service.prewarm(rc, { trigger: 'page' }, signal());
    expect(Object.keys(scope).sort()).toEqual([
      'assertCurrent',
      'binding',
      'launch',
      'signal',
    ]);
    expect(Object.keys(scope.binding).sort()).toEqual([
      'instanceId',
      'leaseEpoch',
      'organizationId',
      'personId',
      'vmId',
    ]);
    expect(scope.signal.aborted).toBe(true);
    await expect(scope.assertCurrent()).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });
    await expect(
      scope.launch({ executable: 'node', args: [] }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await h.service.start(rc, signal());
    expect(h.log.filter((item) => item === 'native:bootstrap')).toHaveLength(1);
  });
  it('callback不await的launch仍abort并join后才允许stop/detach；不把父callback退出作收尾', async () => {
    const h = harness(),
      rc = context();
    let entered!: () => void,
      release!: () => void,
      joined = false;
    const inLaunch = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.native.bootstrap = async (scope) => ({
      launch: async () => {
        entered();
        await new Promise<void>((resolve) =>
          scope.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        await completed;
        joined = true;
        throw new PersonVmError('PROVIDER_FAILED');
      },
    });
    h.runtime.start = async (_binding, _signal, scope) => {
      void scope.launch({ executable: 'node', args: [] });
      await inLaunch;
    };
    const start = h.service.prewarm(rc, { trigger: 'page' }, signal());
    const failure = expect(start).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    await inLaunch;
    expect(h.log).not.toContain('native:stop');
    expect(h.mounts.size).toBe(1);
    release();
    await failure;
    expect(joined).toBe(true);
    expect(h.log.slice(-2)).toEqual(['native:stop', 'disk:detach']);
  });
  it('缺实际bootstrap依赖在egress/attach/create前拒绝', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    h.log.length = 0;
    const runtime = { ...h.runtime, memoryGuestPlan: undefined };
    // JS host composition can omit the required provider despite TS's contract.
    await expect(
      new PersonVmService({
        ...h.options,
        runtime: runtime as unknown as typeof h.runtime,
      }).start(rc, signal()),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    expect(h.log).toEqual([]);
  });
  it.each(['warm', 'cold'] as const)(
    '已建%s盘的host装配→start入口：长socketRoot在egress/move/attach/create前拒绝',
    async (tier) => {
      const store = new MemoryStore(),
        h = harness(store),
        rc = context();
      await h.service.create(rc, signal());
      if (tier === 'cold') {
        h.advance(PERSON_VM_COLD_MS + 1); // Clock fixture, not seven days waited.
        await h.service.reconcileIdle(rc, signal());
      }
      const before = structuredClone(store.rows.get(rc.actor.id)),
        auditsBefore = structuredClone(store.audits);
      h.log.length = 0;
      const runner = vi.fn(async () => 'microsandbox 0.7.16');
      const startFromHostConfiguration = async () => {
        const native = new MicrosandboxPersonVm({
          binary: '/b',
          libkrunfw: '/fw',
          agentd: '/a',
          image: 'registry/node@sha256:' + 'a'.repeat(64),
          rootDiskGiB: 20,
          socketRoot: '/tmp/ar266-12345678',
          runner,
        });
        return new PersonVmService({ ...h.options, native }).start(
          rc,
          signal(),
        );
      };
      await expect(startFromHostConfiguration()).rejects.toMatchObject({
        code: 'PROVIDER_FAILED',
      });
      expect(h.log).toEqual([]);
      expect(runner).not.toHaveBeenCalled();
      expect(h.mounts.size).toBe(0);
      expect(h.active.size).toBe(0);
      expect(h.states.size).toBe(0);
      expect(store.rows.get(rc.actor.id)).toEqual(before);
      expect(store.audits).toEqual(auditsBefore);
    },
  );
  it('建盘前失败后同vmId重试；部分盘不覆写、不以空盘替换', async () => {
    const h = harness(),
      rc = context();
    const create = h.disk.create;
    let fail = true;
    h.disk.create = async (...args) => {
      if (fail) {
        fail = false;
        throw new PersonVmError('PROVIDER_FAILED');
      }
      return create(...args);
    };
    await expect(h.service.create(rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    const first = (await h.service.read(rc, signal()))!;
    expect(h.disks.size).toBe(0);
    expect(
      (await h.service.prewarm(rc, { trigger: 'page' }, signal())).vmId,
    ).toBe(first.vmId);
    const other = harness(),
      otherRc = context();
    let partialAttempts = 0;
    other.disk.create = async (ref) => {
      partialAttempts += 1;
      other.partialDisks.add(ref.vmId);
      throw new PersonVmError('PROVIDER_FAILED');
    };
    await expect(other.service.create(otherRc, signal())).rejects.toMatchObject(
      { code: 'PROVIDER_FAILED' },
    );
    const partial = (await other.service.read(otherRc, signal()))!;
    await expect(other.service.create(otherRc, signal())).rejects.toMatchObject(
      { code: 'PROVIDER_FAILED' },
    );
    expect((await other.service.read(otherRc, signal()))!.vmId).toBe(
      partial.vmId,
    );
    expect(other.partialDisks.has(partial.vmId)).toBe(true);
    expect(partialAttempts).toBe(1);
    expect(other.log).not.toContain('disk:delete');
  });
  it('采样间短job完全结束也不能把瞬时0累积为连续20min空闲', async () => {
    const h = harness(),
      { rc } = await running(h);
    for (let elapsed = 0; elapsed < PERSON_VM_IDLE_MS; elapsed += 5000) {
      h.advance(2000);
      h.setActivity({ activeJobs: 1 });
      h.advance(1000);
      h.setActivity({ activeJobs: 0 });
      h.advance(2000);
      expect((await h.service.reconcileIdle(rc, signal())).phase).toBe(
        'running',
      );
    }
    expect(h.log).not.toContain('native:stop');
    expect(h.log).not.toContain('egress:revoke');
  });
  it('最终0快照之后原生工作开始，普通stop/delete/takeover仍拒绝', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      { rc } = await running(h);
    const observe = h.runtime.activity;
    h.runtime.activity = async (...args) => {
      const snapshot = await observe(...args);
      h.setActivity({ activeJobs: 1 });
      return snapshot;
    };
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    h.setActivity({ activeJobs: 0 });
    await expect(h.service.delete(rc, {}, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    h.setActivity({ activeJobs: 0 });
    store.rows.get(rc.actor.id)!.phase = 'failed';
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    expect(h.log).not.toContain('native:stop');
    expect(h.log).not.toContain('egress:revoke');
  });
  it('进入员工页和首次输入共用本人的盘/VM，read不会把persisted running冒称ready', async () => {
    const h = harness(),
      rc = context();
    const first = await h.service.prewarm(rc, { trigger: 'page' }, signal());
    const second = await h.service.prewarm(rc, { trigger: 'input' }, signal());
    expect(first.ready).toBe(true);
    expect(second.vmId).toBe(first.vmId);
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
    expect((await h.service.read(rc, signal()))?.ready).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(
      /ownerToken|leaseOwner|mount|key|bindingId/,
    );
    expect(h.log.indexOf('egress:prepare')).toBeLessThan(
      h.log.indexOf('native:create'),
    );
  });
  it('global person uniqueness拒绝跨企业冲突，不暗建每企业VM', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    await expect(
      h.service.create(context(randomUUID(), rc.actor.id), signal()),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_CONFLICT' });
    expect(h.disks.size).toBe(1);
  });
  it('每次入口重查当前权限，伪membership不复活已撤销资格', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.authorize(false);
    await expect(
      h.service.assertCurrentBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'AUTHORIZATION_DENIED',
    });
  });
  it('出口/runtime缺失fail closed，不开机', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    await expect(
      new PersonVmService({ ...h.options, egress: undefined }).start(
        rc,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'EGRESS_UNAVAILABLE' });
    await expect(
      new PersonVmService({ ...h.options, runtime: undefined }).start(
        rc,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_READY' });
    expect(h.log).not.toContain('native:create');
    expect(h.mounts.size).toBe(0);
  });
  it('401/未认证/编辑器不可发送不算ready，失败实际stop+detach', async () => {
    const h = harness(),
      rc = context();
    h.setReadiness({
      authenticated: false,
      editorReady: false,
      canSend: false,
    });
    await h.service.create(rc, signal());
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'RUNTIME_NOT_READY',
    });
    expect(h.log).toContain('native:stop');
    expect(h.mounts.size).toBe(0);
    expect(h.active.size).toBe(0);
    h.setReadiness({ authenticated: true, editorReady: true, canSend: true });
    expect((await h.service.start(rc, signal())).ready).toBe(true);
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('prepare返回他人/旧epoch的receipt不能开机或撤销他人的binding', async () => {
    const h = harness(),
      rc = context();
    h.egress.prepare = async (binding) => ({
      binding: { ...binding, leaseEpoch: 0 },
      bindingId: randomUUID(),
      gatewayPorts: [38990],
    });
    await h.service.create(rc, signal());
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'EGRESS_BINDING_INVALID',
    });
    expect(h.log).not.toContain('native:create');
    expect(h.log).not.toContain('egress:revoke');
  });
  it('已存原生配置只接受每VM固定host端口，资格epoch轮换', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.states.set((await h.service.resolve(rc, signal())).vmId, 'stopped');
    await h.service.stop(rc, signal());
    h.setPorts([38991]);
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'EGRESS_BINDING_INVALID',
    });
    expect(h.active.size).toBe(0);
    expect(h.log).not.toContain('native:start');
    h.setPorts([38990]);
    await h.service.start(rc, signal());
    await expect(
      h.service.assertCurrentBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it.each([
    'activeTurns',
    'activeJobs',
    'activeSubtasks',
    'pendingApprovals',
  ] as const)('%s活跃跨过20分钟仍不回收（时间夹具，未实等）', async (kind) => {
    const h = harness(),
      { rc } = await running(h);
    h.setActivity({ [kind]: 1 });
    h.advance(PERSON_VM_IDLE_MS + 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect(h.log).not.toContain('native:stop');
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'VM_ACTIVE',
    });
  });
  it.each(['unknown', 'stale', 'wrong-epoch', 'disconnected'] as const)(
    '%s活动不是0（时间夹具，未实等）',
    async (kind) => {
      const h = harness(),
        { rc, binding } = await running(h);
      if (kind === 'unknown') h.setActivity({ state: 'unknown' });
      if (kind === 'stale')
        h.setActivity({ observedAt: h.now().toISOString() });
      if (kind === 'wrong-epoch')
        h.setActivity({ binding: { ...binding, leaseEpoch: 0 } });
      if (kind === 'disconnected')
        h.runtime.activity = async () => {
          throw new PersonVmError('ACTIVITY_UNKNOWN');
        };
      h.advance(PERSON_VM_IDLE_MS + 1);
      expect((await h.service.reconcileIdle(rc, signal())).phase).toBe(
        'running',
      );
      expect(h.log).not.toContain('native:stop');
    },
  );
  it('host hold与原生事实并用，释放不把累计旧空闲立刻当可回收', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    const id = await h.service.acquireHold(
      rc,
      binding,
      { kind: 'host-operation', operationId: 'synthetic-op' },
      signal(),
    );
    expect(
      await h.service.acquireHold(
        rc,
        binding,
        { kind: 'host-operation', operationId: 'synthetic-op' },
        signal(),
      ),
    ).toBe(id);
    h.advance(PERSON_VM_IDLE_MS + 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    await h.service.releaseHold(rc, binding, id, signal());
    expect((await idleFor(h, rc, PERSON_VM_IDLE_MS - 1)).phase).toBe('running');
    h.advance(2);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect(h.log).not.toContain('native:stop');
  });
  it('停满7天才冷；旧活动7天也不能让刚停VM立刻冷（时间夹具，未实等）', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.advance(PERSON_VM_COLD_MS + 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect((await idleFor(h, rc, PERSON_VM_IDLE_MS)).phase).toBe('running');
    // No native idle gate exists. Model an already physically stopped VM here.
    h.states.set(binding.vmId, 'stopped');
    await h.service.stop(rc, signal());
    expect(h.log).not.toContain('disk:cold');
    h.advance(PERSON_VM_COLD_MS - 1);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('stopped');
    h.advance(2);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('cold');
    expect((await h.service.stop(rc, signal())).phase).toBe('cold');
    expect(h.mounts.size).toBe(0);
    expect(h.disks.has(binding.vmId)).toBe(true);
    const restored = await h.service.start(rc, signal());
    expect(restored.ready).toBe(true);
    expect(restored.vmId).toBe(binding.vmId);
    expect(h.log).toContain('disk:warm');
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('stop先撤资格；revoke失败仍执行stop，停止不明不detach', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.egress.revoke = async () => {
      h.log.push('egress:revoke-failed');
      throw new PersonVmError('EGRESS_UNAVAILABLE');
    };
    h.states.set(binding.vmId, 'stopped');
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h.log.indexOf('egress:revoke-failed')).toBeLessThan(
      h.log.indexOf('native:stop'),
    );
    expect(h.states.get(binding.vmId)).toBe('stopped');
    const h2 = harness(),
      running2 = await running(h2);
    h2.states.set(running2.binding.vmId, 'stopped');
    h2.native.stop = async () => {
      throw new PersonVmError('PROVIDER_FAILED');
    };
    await expect(h2.service.stop(running2.rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h2.mounts.has(running2.binding.vmId)).toBe(true);
    expect(h2.log).not.toContain('disk:detach');
  });
  it('取消调用不跳过独立清理，create已真实完成但ack失败也可恢复原盘', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    const controller = new AbortController();
    h.native.create = async (binding) => {
      h.log.push('native:create');
      h.states.set(binding.vmId, 'running');
      controller.abort();
      throw new PersonVmError('PROVIDER_FAILED');
    };
    await expect(h.service.start(rc, controller.signal)).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(h.mounts.size).toBe(0);
    expect(h.active.size).toBe(0);
    h.native.start = async (binding) => {
      h.log.push('native:start');
      h.states.set(binding.vmId, 'running');
    };
    expect((await h.service.start(rc, signal())).ready).toBe(true);
    expect(h.log).toContain('native:start');
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('并行开机/关机返回明确lease conflict，不产生第二native实例', async () => {
    const h = harness(),
      rc = context();
    await h.service.create(rc, signal());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.runtime.start = async () => {
      entered();
      await gate;
    };
    const first = h.service.start(rc, signal());
    await started;
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    await expect(h.service.resolve(rc, signal())).rejects.toMatchObject({
      code: 'LEASE_CONFLICT',
    });
    release();
    await first;
    expect(h.log.filter((item) => item === 'native:create')).toHaveLength(1);
  });
  it('删除本人计算实例默认留盘；删盘单独授权并保留拒绝/成功审计', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      { rc, binding } = await running(h);
    h.states.set(binding.vmId, 'stopped');
    expect((await h.service.delete(rc, {}, signal())).diskRetained).toBe(true);
    expect(h.disks.has(binding.vmId)).toBe(true);
    expect((await h.service.create(rc, signal())).vmId).toBe(binding.vmId);
    await expect(
      h.service.delete(rc, { deleteDisk: true }, signal()),
    ).rejects.toMatchObject({ code: 'DISK_DELETE_NOT_AUTHORIZED' });
    expect(
      store.audits.some(
        (event) => event.action === 'delete-disk' && event.result === 'denied',
      ),
    ).toBe(true);
    h.authorizeDiskDelete(true);
    expect(
      (await h.service.delete(rc, { deleteDisk: true }, signal())).diskRetained,
    ).toBe(false);
    expect(h.disks.size).toBe(0);
    expect(
      store.audits.some(
        (event) =>
          event.action === 'delete-disk' && event.result === 'succeeded',
      ),
    ).toBe(true);
    expect((await h.service.create(rc, signal())).vmId).not.toBe(binding.vmId);
  });
  it('真实停止后重复stop不重置停机7天时钟', async () => {
    const h = harness(),
      { rc } = await running(h);
    h.states.set((await h.service.resolve(rc, signal())).vmId, 'stopped');
    await h.service.stop(rc, signal());
    h.advance(PERSON_VM_COLD_MS - 1);
    await h.service.stop(rc, signal());
    h.advance(2);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('cold');
  });
  it('18min活跃、20min首次0及后续轮询均不能证明连续空闲', async () => {
    const h = harness(),
      { rc } = await running(h);
    h.setActivity({ activeTurns: 1 });
    h.advance(18 * 60000);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    h.setActivity({ activeTurns: 0 });
    h.advance(2 * 60000);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    h.advance(PERSON_VM_IDLE_MS);
    expect((await h.service.reconcileIdle(rc, signal())).phase).toBe('running');
    expect((await idleFor(h, rc, PERSON_VM_IDLE_MS)).phase).toBe('running');
    expect(h.log).not.toContain('native:stop');
  });
  it('native readiness异常不会被read或stale binding放行', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    vi.spyOn(h.egress, 'assertActive').mockRejectedValue(
      new PersonVmError('EGRESS_UNAVAILABLE'),
    );
    await expect(
      h.service.assertCurrentBinding(rc, binding, signal()),
    ).rejects.toMatchObject({ code: 'EGRESS_UNAVAILABLE' });
  });
  it('活动探针可重入当前binding；瞬时0仍无原子停机保证而拒绝', async () => {
    const h = harness(),
      { rc } = await running(h);
    h.runtime.activity = async (binding) => {
      await h.service.assertCurrentBinding(rc, binding, signal());
      return {
        binding,
        observedAt: h.now().toISOString(),
        state: 'known',
        activeTurns: 0,
        activeJobs: 0,
        activeSubtasks: 0,
        pendingApprovals: 0,
      };
    };
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    expect(h.log).not.toContain('native:stop');
  });
  it('撤销耗尽单步budget后仍使用新信号尝试物理stop', async () => {
    const h = harness(),
      { rc, binding } = await running(h);
    h.states.set(binding.vmId, 'stopped');
    h.options.cleanupTimeoutMs = 5;
    h.egress.revoke = async (_receipt, _reason, revokeSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      revokeSignal.throwIfAborted();
    };
    h.native.stop = async (binding, stopSignal) => {
      expect(stopSignal.aborted).toBe(false);
      h.log.push('native:stop');
      h.states.set(binding.vmId, 'stopped');
    };
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'CLEANUP_INCOMPLETE',
    });
    expect(h.log).toContain('native:stop');
  });
  it('启动回调派生的异步资源在原租约settled后重新读取当前epoch', async () => {
    const h = harness(),
      rc = context();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late: ReturnType<typeof h.service.resolve> | undefined;
    h.runtime.start = async () => {
      late ??= gate.then(() => h.service.resolve(rc, signal()));
    };
    await h.service.prewarm(rc, { trigger: 'page' }, signal());
    const first = await h.service.resolve(rc, signal());
    h.states.set((await h.service.resolve(rc, signal())).vmId, 'stopped');
    await h.service.stop(rc, signal());
    await h.service.start(rc, signal());
    release();
    expect((await late)!.leaseEpoch).toBeGreaterThan(first.leaseEpoch);
  });
  it('失败VM的接管仍检查真实活动；活跃/未知不能借重开机误回收', async () => {
    const store = new MemoryStore(),
      h = harness(store),
      { rc } = await running(h);
    store.rows.get(rc.actor.id)!.phase = 'failed';
    h.setActivity({ activeJobs: 1 });
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'VM_ACTIVE',
    });
    h.setActivity({ state: 'unknown', activeJobs: 0 });
    await expect(h.service.start(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    await expect(h.service.stop(rc, signal())).rejects.toMatchObject({
      code: 'ACTIVITY_UNKNOWN',
    });
    expect(h.log).not.toContain('native:stop');
  });
});
