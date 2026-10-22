import { describe, expect, it } from 'vitest';
import {
  parseNativeRecurringPartitionRows,
  type NativeRecurringStoredRow,
} from './native-schedule-recurring-loader.ts';
import {
  NativeRecurringControlSchema,
  recurringControlIdentity,
} from './native-schedule-recurring-state.ts';
import {
  NativeCalendarControlSchema,
  calendarControlIdentity,
} from './native-schedule-calendar-state.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  artifactId: `sha256:${'a'.repeat(64)}`,
  profileId: 'allrice-recurring-control-v1' as const,
  storageId: 'mixed-test',
  stateRoot: '/isolated/mixed-test',
};
const scope = {
  partitionId: 'allrice-recurring-v1',
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
};
function rows(): NativeRecurringStoredRow[] {
  const fixed = NativeRecurringControlSchema.parse({
    ...scope,
    kind: 'recurring',
    controlId: id(4),
    automationId: id(5),
    revision: 1,
    controlSessionId: 'fixed-session',
    sessionState: 'reserved',
    nativeTaskId: null,
    rule: { kind: 'every', seconds: 60 },
    appliedRule: null,
    appliedRevision: null,
    taskDeleted: false,
    command: { id: id(6), kind: 'create', status: 'pending' },
    dispatch: { consumer: 'platform-quality-v1' },
  });
  const calendar = NativeCalendarControlSchema.parse({
    ...scope,
    kind: 'calendar',
    binding: 'rotating-at-v1',
    controlId: id(7),
    automationId: id(8),
    revision: 1,
    controlSessionId: 'calendar-session',
    sessionState: 'reserved',
    nativeTaskId: null,
    reference,
    dispatch: {
      consumer: 'experience-consolidation-v1',
      employeeAssignmentId: id(9),
      employeeInstanceId: id(10),
    },
  });
  return [
    {
      control_id: fixed.controlId,
      immutable_identity: recurringControlIdentity(fixed),
      snapshot: { control: fixed, task: null },
      snapshot_version: 0,
    },
    {
      control_id: calendar.controlId,
      immutable_identity: calendarControlIdentity(calendar),
      snapshot: { control: calendar, task: null },
      snapshot_version: 0,
    },
  ];
}
describe('shared recurring partition inventory', () => {
  it('retains both fixed and calendar Sessions for the one workspace/writer', () => {
    const parsed = parseNativeRecurringPartitionRows(rows(), reference, true);
    expect(parsed.map((r) => r.kind)).toEqual(['recurring', 'calendar']);
    expect(parsed.map((r) => r.snapshot.control.controlSessionId)).toEqual([
      'fixed-session',
      'calendar-session',
    ]);
  });
  it('fails closed for calendar when the format is not explicitly enabled', () => {
    expect(() =>
      parseNativeRecurringPartitionRows(rows(), reference, false),
    ).toThrow();
  });
  it.each(['unknown', null, undefined])(
    'rejects unknown discriminator %s instead of filtering it',
    (kind) => {
      const input = rows();
      input[1]!.snapshot.control = {
        ...(input[1]!.snapshot.control as object),
        kind,
      };
      expect(() =>
        parseNativeRecurringPartitionRows(input, reference, true),
      ).toThrow();
    },
  );
  it('does not accept calendar rule fields through the original fixed schema', () => {
    const input = rows();
    input[0]!.snapshot.control = {
      ...(input[0]!.snapshot.control as object),
      rule: { kind: 'monthly', monthDay: 31 },
    };
    expect(() =>
      parseNativeRecurringPartitionRows(input, reference, true),
    ).toThrow();
  });
  it('detects cross-format Session collision even when each identity matches its own row', () => {
    const input = rows();
    const c = NativeCalendarControlSchema.parse({
      ...(input[1]!.snapshot.control as object),
      controlSessionId: 'fixed-session',
    });
    input[1]!.snapshot.control = c;
    input[1]!.immutable_identity = calendarControlIdentity(c);
    expect(() =>
      parseNativeRecurringPartitionRows(input, reference, true),
    ).toThrow();
  });
  it('rejects a calendar reference belonging to another root', () => {
    expect(() =>
      parseNativeRecurringPartitionRows(
        rows(),
        { ...reference, stateRoot: '/another-root' },
        true,
      ),
    ).toThrow();
  });
});
