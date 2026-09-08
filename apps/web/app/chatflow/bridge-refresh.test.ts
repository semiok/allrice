import { describe, expect, it } from 'vitest';
import { BridgeRefreshCoordinator } from './bridge-refresh';

describe('Bridge latest refresh authority', () => {
  it('ignores an old online polling response arriving after a manual offline response', () => {
    const gate = new BridgeRefreshCoordinator();
    gate.reset('tenant-a/workspace-a');
    const poll = gate.start('tenant-a/workspace-a', false)!;
    const click = gate.start('tenant-a/workspace-a', true)!;
    expect(poll.controller.signal.aborted).toBe(true);
    expect(gate.isCurrent(click)).toBe(true);
    gate.finish(click);
    expect(gate.isCurrent(poll)).toBe(false);
    expect(gate.isCurrent(click)).toBe(false);
  });
  it('does not let background timers interrupt a manual refresh or its busy state', () => {
    const gate = new BridgeRefreshCoordinator();
    gate.reset('a');
    const click = gate.start('a', true)!;
    expect(gate.start('a', false)).toBeNull();
    expect(click.controller.signal.aborted).toBe(false);
    expect(gate.isCurrent(click)).toBe(true);
  });
  it('keeps a slow poll bounded by its own timeout instead of restarting it every timer tick', () => {
    const gate = new BridgeRefreshCoordinator();
    gate.reset('a');
    const poll = gate.start('a', false)!;
    expect(gate.start('a', false)).toBeNull();
    poll.controller.abort();
    expect(gate.isCurrent(poll)).toBe(true); // timeout must invalidate the visible status
    gate.finish(poll);
    expect(gate.start('a', false)).not.toBeNull();
  });
  it('rejects late tenant/workspace responses and stale closures even after returning to the old workspace', () => {
    const gate = new BridgeRefreshCoordinator();
    gate.reset('a');
    const first = gate.start('a', true)!;
    gate.reset('b');
    expect(first.controller.signal.aborted).toBe(true);
    expect(gate.start('a', true)).toBeNull();
    gate.reset('a');
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.start('a', true)).not.toBeNull();
  });
  it('unmount cancels requests and an old completion cannot release a newer one', () => {
    const gate = new BridgeRefreshCoordinator();
    gate.reset('a');
    const first = gate.start('a', true)!;
    const second = gate.start('a', true)!;
    gate.finish(first);
    expect(gate.isCurrent(second)).toBe(true);
    gate.reset(null);
    expect(second.controller.signal.aborted).toBe(true);
    expect(gate.isCurrent(second)).toBe(false);
  });
  it('invalidates an in-flight pairing result when tenant headers change, even after switching back', () => {
    const gate = new BridgeRefreshCoordinator();
    gate.reset('tenant-a/workspace');
    const stillInScope = gate.capture('tenant-a/workspace')!;
    expect(stillInScope()).toBe(true);
    gate.reset('tenant-b/workspace');
    expect(stillInScope()).toBe(false);
    expect(gate.capture('tenant-a/workspace')).toBeNull();
    gate.reset('tenant-a/workspace');
    expect(stillInScope()).toBe(false);
  });
});
