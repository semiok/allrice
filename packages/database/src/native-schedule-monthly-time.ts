import {
  MonthlyScheduleRuleSchema,
  type MonthlyScheduleRule,
} from '@allrice/contracts';
import { nextScheduleAt } from './execution/automation.ts';

/** Business calendar calculation only. Native create/delivery owns all wakes.
 * Reuse the original month-end and DST resolution, preserving whole seconds. */
export function nextMonthlyBusinessTarget(
  input: MonthlyScheduleRule,
  after: Date,
): Date {
  const rule = MonthlyScheduleRuleSchema.parse(input);
  if (!Number.isFinite(after.getTime())) throw Error('invalid_monthly_clock');
  const seconds = Number(rule.time.slice(6, 8));
  const target = nextScheduleAt(
    {
      frequency: 'monthly',
      monthDay: rule.monthDay,
      time: rule.time.slice(0, 5),
      timezone: rule.timezone,
    },
    new Date(after.getTime() - seconds * 1000),
  );
  return new Date(target.getTime() + seconds * 1000);
}

/** At most the latest missed business period is admitted. This bounded pure
 * calculation neither scans due rows nor replays historical occurrences. */
export function latestMonthlyBusinessTarget(
  input: MonthlyScheduleRule,
  at: Date,
): Date {
  const rule = MonthlyScheduleRuleSchema.parse(input);
  if (!Number.isFinite(at.getTime())) throw Error('invalid_monthly_clock');
  let target = nextMonthlyBusinessTarget(
    rule,
    new Date(at.getTime() - 64 * 86_400_000),
  );
  let latest: Date | undefined;
  for (let i = 0; i < 4; i++) {
    if (target > at) {
      if (latest) return latest;
      break;
    }
    latest = target;
    target = nextMonthlyBusinessTarget(rule, target);
  }
  throw Error('monthly_target_bound_exceeded');
}
