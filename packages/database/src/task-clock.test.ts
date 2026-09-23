import { describe, expect, it } from 'vitest';
import {
  projectTaskClock,
  taskClockPhase,
  type TaskClockRow,
} from './task-clock.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';

describe('MET-153 frozen task policy and elapsed-time accounting', () => {
  const source = (timeoutMs: number, scope = 'user') => ({
    scope,
    scopeId: 'synthetic',
    timeoutMs,
  });
  it('uses one hour only in the absence of an explicit policy', () => {
    expect(resolveTaskRuntimePolicy([]).timeoutMs).toBe(3600000);
    expect(resolveTaskRuntimePolicy([source(0)]).timeoutMs).toBe(0);
    expect(
      resolveTaskRuntimePolicy([source(0), source(1800000, 'tenant')])
        .timeoutMs,
    ).toBe(1800000);
    expect(() => resolveTaskRuntimePolicy([source(999)])).toThrow();
    expect(() => resolveTaskRuntimePolicy([source(NaN)])).toThrow();
  });
  const row: TaskClockRow = {
    run_id: 'synthetic',
    policy: resolveTaskRuntimePolicy([]),
    active_ms: 600000,
    waiting_ms: 0,
    phase: 'waiting',
    changed_at: new Date(0),
    started_at: new Date(0),
    completed_at: null,
  };
  it('excludes 40 minutes of waiting, preserves prior active time on resume, and never slides an exhausted deadline', () => {
    const at = new Date(2400000),
      paused = projectTaskClock(row, at);
    expect(paused.activeMs).toBe(600000);
    expect(paused.waitingMs).toBe(2400000);
    const resumed = {
      ...row,
      phase: 'active' as const,
      waiting_ms: paused.waitingMs,
      changed_at: at,
    };
    expect(projectTaskClock(resumed, new Date(3000000)).activeMs).toBe(1200000);
    expect(projectTaskClock(resumed, new Date(6000000)).remainingMs).toBe(0);
    expect(
      projectTaskClock(resumed, new Date(6000000)).deadlineAt.getTime(),
    ).toBe(5400000);
    expect(
      projectTaskClock(resumed, new Date(7000000)).deadlineAt.getTime(),
    ).toBe(5400000);
  });
  it('does not accrue queue or terminal time; unlimited remains explicit', () => {
    expect(
      projectTaskClock({ ...row, phase: 'queued' }, new Date(10000)).activeMs,
    ).toBe(600000);
    expect(
      projectTaskClock(
        { ...row, phase: 'terminal', completed_at: new Date(1000) },
        new Date(10000),
      ).wallMs,
    ).toBe(1000);
    expect(
      projectTaskClock(
        {
          ...row,
          phase: 'active',
          policy: resolveTaskRuntimePolicy([source(0)]),
        },
        new Date(99999999999),
      ).remainingMs,
    ).toBeNull();
  });
  const root = { run_id: 'root', status: 'running' },
    child = { run_id: 'child', status: 'running' };
  const input = {
    state: 'running',
    runId: 'root',
    instances: [root],
    operations: [{ agent_id: 'root', status: 'waiting_user' }],
  };
  it('pauses only a wholly blocked tree, never because a child merely exists', () => {
    expect(taskClockPhase(input)).toBe('waiting');
    expect(taskClockPhase({ ...input, instances: [root, child] })).toBe(
      'active',
    );
    expect(
      taskClockPhase({
        ...input,
        instances: [root, child],
        operations: [
          ...input.operations,
          { agent_id: 'child', status: 'waiting_device' },
        ],
      }),
    ).toBe('waiting');
    expect(
      taskClockPhase({
        ...input,
        instances: [root, child],
        operations: [{ agent_id: 'child', status: 'waiting_user' }],
      }),
    ).toBe('active');
    expect(taskClockPhase({ ...input, modelInFlight: true })).toBe('active');
    expect(
      taskClockPhase({
        ...input,
        operations: [
          ...input.operations,
          { agent_id: 'root', status: 'unknown' },
        ],
      }),
    ).toBe('active');
  });
});
