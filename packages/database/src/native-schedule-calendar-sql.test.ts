import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createNativeCalendarSqlStore } from './native-schedule-calendar-sql.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
} from './native-schedule-once-state.ts';
import type { NativeCalendarWrite } from './native-schedule-calendar-state.ts';

describe('calendar SQL protocol stays dormant without explicit opt-in', () => {
  const begin = vi.fn(() => {
    throw Error('database must not be used');
  });
  const options = {
    db: { begin } as unknown as Sql,
    partitionId: 'allrice-recurring-v1',
    ownerId: 'isolated-owner',
    reference: {
      artifactId: `sha256:${'a'.repeat(64)}`,
      profileId: 'allrice-recurring-control-v1',
      storageId: 'isolated-calendar',
      stateRoot: '/isolated/calendar',
    },
    decodeTask: (v: unknown) => structuredClone(v) as NativeOnceTask,
    lockAdmission: async () => new Map(),
    proveClosed: async () => null,
  };
  const writer = {
    partitionId: options.partitionId,
    ownerId: options.ownerId,
    epoch: 1,
    token: 'isolated-token',
  };
  const mutation = {
    kind: 'calendar' as const,
    action: 'session_initializing' as const,
    controlId: '00000000-0000-4000-8000-000000000001',
    expectedControlVersion: 0,
  };
  const write: NativeCalendarWrite = {
    writeId: 'calendar-write',
    digest: nativeOnceDigest(mutation),
    mutation,
  };
  it('rejects writes and returns unknown readback without touching SQL', async () => {
    const store = createNativeCalendarSqlStore(options);
    expect(await store.acquireWriter()).toBeNull();
    expect(await store.commitMutation(writer, write)).toBe('rejected');
    expect(await store.readExactCommit(writer, write)).toBe('unknown');
    expect(
      await store.readExactCalendarArm(
        'missing-arm',
        nativeOnceDigest('request'),
      ),
    ).toEqual({ state: 'unknown' });
    await expect(store.renewWriter(writer)).rejects.toThrow('disabled');
    await expect(store.loadCalendarControls(writer)).rejects.toThrow(
      'disabled',
    );
    expect(begin).not.toHaveBeenCalled();
  });
  it('does not route calendar writes into the fixed recurring state machine', async () => {
    const store = createNativeRecurringSqlStore(options);
    expect(await store.commitMutation(writer, write)).toBe('rejected');
    expect(await store.readExactCommit(writer, write)).toBe('unknown');
    expect(begin).not.toHaveBeenCalled();
  });
});
