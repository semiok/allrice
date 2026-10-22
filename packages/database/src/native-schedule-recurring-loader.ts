import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import {
  NativeCalendarControlSchema,
  calendarControlIdentity,
  type NativeCalendarControl,
  type NativeCalendarSnapshot,
} from './native-schedule-calendar-state.ts';
import {
  NativeRecurringControlSchema,
  NativeRecurringStateError,
  recurringControlIdentity,
  type NativeRecurringControl,
  type NativeRecurringSnapshot,
} from './native-schedule-recurring-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
} from './native-schedule-once-state.ts';

export type NativeRecurringPartitionControl =
  NativeRecurringControl | NativeCalendarControl;
export type NativeRecurringPartitionRow = {
  control_id: string;
  immutable_identity: unknown;
  snapshot_version: number | string;
} & (
  | { kind: 'recurring'; snapshot: NativeRecurringSnapshot }
  | { kind: 'calendar'; snapshot: NativeCalendarSnapshot }
);
export type NativeRecurringStoredRow = {
  control_id: string;
  immutable_identity: unknown;
  snapshot: { control: unknown; task: unknown };
  snapshot_version: number | string;
};

/** One authoritative partition inventory. Format dispatch never weakens either
 * format's validator or silently hides a Session from the common writer. */
export function parseNativeRecurringPartitionRows(
  rows: readonly NativeRecurringStoredRow[],
  reference: NativeOnceReference,
  calendarEnabled: boolean,
): NativeRecurringPartitionRow[] {
  const fail = (): never => {
    throw new NativeRecurringStateError('control_invalid');
  };
  if (rows.length > 10_000)
    throw new NativeRecurringStateError('control_limit');
  const sessions = new Set<string>(),
    automations = new Set<string>(),
    controls = new Set<string>(),
    tasks = new Set<string>();
  return rows.map((row) => {
    nativeOnceDigest(row.snapshot);
    const raw = row.snapshot.control;
    const kind =
      raw && typeof raw === 'object' && 'kind' in raw ? raw.kind : undefined;
    let result: NativeRecurringPartitionRow;
    if (kind === 'recurring') {
      const c = NativeRecurringControlSchema.parse(raw);
      if (
        !isDeepStrictEqual(
          recurringControlIdentity(c),
          row.immutable_identity,
        ) ||
        (c.nativeTaskId === null || c.taskDeleted) !==
          (row.snapshot.task === null)
      )
        fail();
      result = {
        ...row,
        kind: 'recurring',
        snapshot: { control: c, task: row.snapshot.task },
      } as NativeRecurringPartitionRow;
    } else if (kind === 'calendar' && calendarEnabled) {
      const c = NativeCalendarControlSchema.parse(raw);
      if (
        !isDeepStrictEqual(
          calendarControlIdentity(c),
          row.immutable_identity,
        ) ||
        !isDeepStrictEqual(c.reference, reference) ||
        row.snapshot.task !== null
      )
        fail();
      result = {
        ...row,
        kind: 'calendar',
        snapshot: { control: c, task: null },
      };
    } else return fail();
    const c = result.snapshot.control;
    if (
      c.partitionId !== 'allrice-recurring-v1' ||
      c.controlId !== row.control_id ||
      !Number.isSafeInteger(Number(row.snapshot_version)) ||
      Number(row.snapshot_version) < 0 ||
      controls.has(c.controlId) ||
      sessions.has(c.controlSessionId) ||
      automations.has(c.automationId) ||
      (c.nativeTaskId !== null && tasks.has(c.nativeTaskId))
    )
      fail();
    controls.add(c.controlId);
    sessions.add(c.controlSessionId);
    automations.add(c.automationId);
    if (c.nativeTaskId !== null) tasks.add(c.nativeTaskId);
    return result;
  });
}

export async function loadNativeRecurringPartitionRows(
  tx: TransactionSql,
  reference: NativeOnceReference,
  calendarEnabled: boolean,
) {
  const rows = await tx<NativeRecurringStoredRow[]>`
    select control_id,immutable_identity,snapshot,snapshot_version
    from allrice_native_recurring_controls where partition_id='allrice-recurring-v1'
    order by control_id limit 10001`;
  return parseNativeRecurringPartitionRows(rows, reference, calendarEnabled);
}
