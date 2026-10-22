/** Explicit business consumers over one shared native calendar/writer store. */
import type { TransactionSql } from 'postgres';
import type {
  NativeOnceReference,
  NativeOnceWriter,
} from './native-schedule-once-state.ts';
import type {
  NativeCalendarAdmission,
  NativeCalendarControl,
} from './native-schedule-calendar-state.ts';
import type { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import {
  lockExperienceCalendarAdmissions,
  materializeExperienceNativeCalendar,
} from './experience-native.ts';
import {
  lockOrdinaryMonthlyAdmissions,
  materializeOrdinaryMonthlyCalendar,
} from './native-schedule-monthly.ts';

export async function lockNativeCalendarAdmissions(
  tx: TransactionSql,
  controls: readonly NativeCalendarControl[],
  purpose: 'initialize' | 'native' = 'native',
) {
  const result = new Map<string, NativeCalendarAdmission>();
  for (const c of [...controls].sort((a, b) =>
    `${a.organizationId}:${a.ownerId}:${a.automationId}`.localeCompare(
      `${b.organizationId}:${b.ownerId}:${b.automationId}`,
    ),
  )) {
    const facts =
      c.dispatch.consumer === 'experience-consolidation-v1'
        ? await lockExperienceCalendarAdmissions(tx, [c], purpose)
        : await lockOrdinaryMonthlyAdmissions(tx, [c], purpose);
    for (const [id, fact] of facts) result.set(id, fact);
  }
  return result;
}
export async function materializeNativeCalendar(
  calendar: NonNullable<
    ReturnType<typeof createNativeRecurringSqlStore>['calendar']
  >,
  writer: NativeOnceWriter,
  reference: NativeOnceReference,
  allowHandoff = true,
) {
  // Existing shared retirement intents are processed before either producer.
  return (
    (await materializeExperienceNativeCalendar(
      calendar,
      writer,
      reference,
      allowHandoff,
    )) || materializeOrdinaryMonthlyCalendar(calendar, writer, reference)
  );
}
