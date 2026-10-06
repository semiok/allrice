import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DevProducerLifecycle,
  type DevProducerContext,
} from './dev-producer-lifecycle.ts';
import { DevMaintenanceError } from './dev-maintenance.ts';
import type { ServiceBuildIdentity } from './service-build-identity.ts';

const identity: ServiceBuildIdentity = {
  version: 1,
  environment: 'dev',
  service: 'worker',
  mode: 'production',
  sourceSha: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  manifestDigest: 'sha256:' + 'c'.repeat(64),
  artifactDigest: 'sha256:' + 'd'.repeat(64),
  runtimeGraphDigest: 'sha256:' + 'e'.repeat(64),
  webBuildId: 'fixture',
  bootId: randomUUID(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  nodeVersion: process.version,
  protocols: { identity: 1, ordinaryConsumer: 1, releaseAdmission: 'disabled' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const starts: { id: string; instanceBootId: string; epoch: number }[] = [];
  const finishes: string[] = [];
  const store = {
    async start(input: { id?: string; instanceBootId: string }) {
      const p = {
        id: input.id!,
        instanceBootId: input.instanceBootId,
        epoch: 0,
      };
      starts.push(p);
      return p;
    },
    async finish(p: { id: string }) {
      finishes.push(p.id);
    },
  };
  return {
    starts,
    finishes,
    store,
    lifecycle: new DevProducerLifecycle(true, 'worker', identity, store),
  };
}
describe('Process producer lifecycle, without resource-idle or host authority', () => {
  it('registers pending before the commit await and never calls business before admission succeeds', async () => {
    const f = fixture(),
      commit = deferred<{
        id: string;
        instanceBootId: string;
        epoch: number;
      }>();
    let receivedId = '',
      called = 0;
    f.store.start = async (input) => {
      receivedId = input.id!;
      return commit.promise;
    };
    const execution = f.lifecycle.run(
      'ordinary_consumer',
      async () => ++called,
    );
    expect(f.lifecycle.snapshot()?.pendingRoots).toBe(1);
    expect(called).toBe(0);
    commit.resolve({
      id: receivedId,
      instanceBootId: identity.bootId,
      epoch: 1,
    });
    expect(await execution).toBe(1);
    expect(f.finishes).toEqual([receivedId]);
  });
  it('retains a child after its parent returns and refuses late use of the released parent context', async () => {
    const f = fixture(),
      wait = deferred<void>();
    let child!: Promise<string>, saved!: DevProducerContext;
    expect(
      await f.lifecycle.run('ordinary_consumer', async (scope) => {
        saved = scope;
        child = scope.child(async () => {
          await wait.promise;
          return 'child-complete';
        });
        return 'parent-complete';
      }),
    ).toBe('parent-complete');
    expect(f.finishes).toEqual([]);
    expect(f.lifecycle.snapshot()?.retainedChildren).toBe(1);
    let called = false;
    await expect(
      saved.child(async () => {
        called = true;
      }),
    ).rejects.toMatchObject({ code: 'dev_barrier_stale' });
    expect(called).toBe(false);
    wait.resolve();
    expect(await child).toBe('child-complete');
    expect(f.finishes).toHaveLength(1);
    expect(f.lifecycle.snapshot()?.activeRoots).toBe(0);
  });
  it('keeps a stable uncertain insert identity, with no business replay or implicit finish', async () => {
    const f = fixture();
    let id = '',
      starts = 0,
      effects = 0;
    f.store.start = async (input) => {
      id = input.id!;
      starts++;
      throw Error('commit response lost');
    };
    await expect(
      f.lifecycle.run('automation', async () => {
        effects++;
      }),
    ).rejects.toThrow('commit response lost');
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(starts).toBe(1);
    expect(effects).toBe(0);
    expect(f.finishes).toEqual([]);
    expect(f.lifecycle.snapshot()).toMatchObject({
      unresolvedRoots: 1,
      unknownOutcomes: ['permit_start_result_unknown'],
      releaseAdmission: 'disabled',
    });
  });
  it('a known maintenance refusal causes no effect and is not an unknown commit', async () => {
    const f = fixture();
    f.store.start = async () => {
      throw new DevMaintenanceError('dev_maintenance_requested');
    };
    let effects = 0;
    await expect(
      f.lifecycle.run('automation', async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: 'dev_maintenance_requested' });
    expect(effects).toBe(0);
    expect(f.lifecycle.snapshot()).toMatchObject({
      pendingRoots: 0,
      activeRoots: 0,
      unresolvedRoots: 0,
    });
  });
  it('a failed finish preserves uncertainty without repeating successful business', async () => {
    const f = fixture();
    let effects = 0;
    f.store.finish = async () => {
      throw Error('finish response lost');
    };
    expect(
      await f.lifecycle.run('repository_action', async () => ++effects),
    ).toBe(1);
    expect(effects).toBe(1);
    expect(f.lifecycle.snapshot()).toMatchObject({
      unresolvedRoots: 1,
      unknownOutcomes: ['permit_finish_result_unknown'],
    });
  });
  it('a caught child failure cannot manufacture a finished root permit', async () => {
    const f = fixture();
    await f.lifecycle.run('ordinary_consumer', async (scope) => {
      await scope
        .child(async () => {
          throw Error('physical close unknown');
        })
        .catch(() => undefined);
    });
    expect(f.finishes).toEqual([]);
    expect(f.lifecycle.snapshot()).toMatchObject({
      unresolvedRoots: 1,
      unknownOutcomes: ['business_lifetime_unknown'],
    });
  });
  it('waiting for current roots includes retained children and the final durable finish', async () => {
    const f = fixture(),
      childWait = deferred<void>(),
      finishWait = deferred<void>();
    f.store.finish = async (permit) => {
      await finishWait.promise;
      f.finishes.push(permit.id);
    };
    let child!: Promise<void>,
      settled = false;
    await f.lifecycle.run('ordinary_consumer', async (scope) => {
      child = scope.child(async () => {
        await childWait.promise;
      });
    });
    const wait = f.lifecycle.waitForCurrentRoots().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    childWait.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishWait.resolve();
    await Promise.all([child, wait]);
    expect(f.finishes).toHaveLength(1);
    expect(settled).toBe(true);
  });
  it('unmanaged environments preserve ordinary callbacks without identity or database writes', async () => {
    const f = fixture(),
      lifecycle = new DevProducerLifecycle(false, 'worker', null, f.store);
    expect(
      await lifecycle.run('ordinary_consumer', async (scope) =>
        scope.child(async () => 42),
      ),
    ).toBe(42);
    expect(f.starts).toEqual([]);
    expect(lifecycle.snapshot()).toBeNull();
  });
  it('rejects a role or process mismatch before any business', () => {
    expect(() => new DevProducerLifecycle(true, 'web', identity)).toThrow();
    expect(
      () =>
        new DevProducerLifecycle(true, 'worker', {
          ...identity,
          pid: process.pid + 1,
        }),
    ).toThrow();
  });
});
