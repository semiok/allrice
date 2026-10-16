import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type SandboxExecutionRenewal,
} from '@allrice/contracts';
import { CloudExecutionBudget } from './execution-budget.js';

function fixture(cap: 600000 | 1800000 | 3600000 = 600000) {
  let now = 1000000;
  const spec = sandboxExecutionBudgetSpec(
    { version: 1, kind: 'install' },
    resolveSandboxExecutionPolicy([
      {
        scope: 'tenant',
        scopeId: randomUUID(),
        source: 'tenant_override',
        maxExecutionMs: cap,
      },
    ]),
  );
  const rootDeadline = now + 3600000;
  let authority = startSandboxExecutionBudget(spec, now, rootDeadline);
  const requests: SandboxExecutionRenewal[] = [];
  const exchange = async (request: SandboxExecutionRenewal) => {
    requests.push(structuredClone(request));
    authority = renewSandboxExecutionBudget(
      authority,
      request,
      now,
      rootDeadline,
    );
    return authority;
  };
  const clock = new CloudExecutionBudget(authority, spec, exchange, () => now);
  return {
    clock,
    spec,
    requests,
    exchange,
    initial: authority,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

it.each([600000, 1800000, 3600000] as const)(
  'keeps the %i ms authority clock across preparation and container execution',
  async (cap) => {
    const f = fixture(cap),
      start = f.clock.state.startedAt;
    f.advance(105000);
    await f.clock.renew(async () => ({
      cpuNanos: 0,
      readBytes: 800000,
      writtenBytes: 0,
    }));
    f.advance(60000);
    await f.clock.renew(async () => ({
      cpuNanos: 2000000,
      readBytes: 801024,
      writtenBytes: 2048,
    }));
    expect(f.clock.state.startedAt).toBe(start);
    expect(f.clock.state.hardDeadlineAt).toBe(start + cap);
    expect(f.clock.state.deadlineAt).toBe(start + 240000);
    expect(f.clock.state.sequence).toBe(2);
    expect(f.requests.map((r) => r.progress.readBytes)).toEqual([
      800000, 801024,
    ]);
  },
);

it('reconciles a lost renewal acknowledgement with the same request, never another minute', async () => {
  const f = fixture();
  let lose = true;
  const clock = new CloudExecutionBudget(
    f.initial,
    f.spec,
    async (request) => {
      const response = await f.exchange(request);
      if (lose) {
        lose = false;
        throw Error('response lost');
      }
      return response;
    },
    f.now,
  );
  f.advance(105000);
  await expect(
    clock.renew(async () => ({ cpuNanos: 0, readBytes: 100, writtenBytes: 0 })),
  ).rejects.toThrow('response lost');
  await clock.renew(async () => {
    throw Error('must reuse original evidence');
  });
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toEqual(f.requests[0]);
  expect(clock.state.sequence).toBe(1);
  expect(clock.state.deadlineAt).toBe(f.initial.startedAt + 180000);
});

it('cannot renew indefinitely with only lease heartbeats', async () => {
  const f = fixture(),
    idle = async () => ({ cpuNanos: 0, readBytes: 0, writtenBytes: 0 });
  f.advance(105000);
  await f.clock.renew(idle);
  f.advance(60000);
  await expect(f.clock.renew(idle)).rejects.toThrow(
    'SANDBOX_EXECUTION_NO_PROGRESS',
  );
  expect(f.clock.state.sequence).toBe(1);
});

it('does not submit empty progress or extend a confirmed exited process', async () => {
  const f = fixture();
  f.advance(105000);
  const before = structuredClone(f.clock.state);
  await f.clock.renew(async () => null);
  expect(f.requests).toHaveLength(0);
  expect(f.clock.state).toEqual(before);
  f.advance(15000);
  await expect(f.clock.renew(async () => null)).rejects.toThrow(
    'SANDBOX_EXECUTION_DEADLINE',
  );
});

it('never revives an expired preparation phase or resets progress at handoff', async () => {
  const f = fixture();
  f.advance(105000);
  await f.clock.renew(async () => ({
    cpuNanos: 0,
    readBytes: 100,
    writtenBytes: 0,
  }));
  f.advance(60000);
  await expect(
    f.clock.renew(async () => ({
      cpuNanos: 2000000,
      readBytes: 0,
      writtenBytes: 0,
    })),
  ).rejects.toThrow('SANDBOX_EXECUTION_PROGRESS_CHANGED');
  f.advance(15000);
  const count = f.requests.length;
  await expect(
    f.clock.renew(async () => ({
      cpuNanos: 9000000,
      readBytes: 999,
      writtenBytes: 0,
    })),
  ).rejects.toThrow('SANDBOX_EXECUTION_DEADLINE');
  expect(f.requests).toHaveLength(count);
});

it('rejects a changed start time or fabricated authority progress', async () => {
  for (const field of ['startedAt', 'progress'] as const) {
    const f = fixture();
    const clock = new CloudExecutionBudget(
      f.initial,
      f.spec,
      async (request) => {
        const result = structuredClone(await f.exchange(request));
        if (field === 'startedAt') result.startedAt--;
        else result.progress.readBytes++;
        return result;
      },
      f.now,
    );
    f.advance(105000);
    await expect(
      clock.renew(async () => ({
        cpuNanos: 0,
        readBytes: 100,
        writtenBytes: 0,
      })),
    ).rejects.toThrow('SANDBOX_EXECUTION_POLICY_CHANGED');
    expect(clock.state).toEqual(f.initial);
  }
});
