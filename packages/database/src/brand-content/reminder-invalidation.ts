import type { PlanRow, Tx } from './types.ts';

/** Called inside the authorized plan mutation; ordinary Automations are never
 * selected. A delivered message remains immutable historical evidence. */
export async function invalidateBrandContentReminder(
  tx: Tx,
  plan: PlanRow,
  reason: 'PLAN_CHANGED' | 'PLAN_CANCELLED',
) {
  if (!plan.automation_id) return;
  await tx`update allrice_automations a set status='paused',next_run_at=null,revision=revision+1,updated_at=clock_timestamp()
    from allrice_brand_content_reminders r
    where a.id=${plan.automation_id} and a.brand_content_binding=r.id and r.automation_id=a.id
      and r.plan_id=${plan.id}`;
  await tx`update allrice_brand_content_reminders set state='superseded',error_code=${reason},completed_at=clock_timestamp()
    where automation_id=${plan.automation_id} and plan_id=${plan.id} and state='registered'`;
  const { cancelBrandNativeReminder } = await import('./native-reminder.ts');
  await cancelBrandNativeReminder(tx, plan.automation_id);
}
