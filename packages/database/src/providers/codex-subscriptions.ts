import { z } from 'zod';
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { requirePlatformAdmin } from '../platform-authority.ts';

export const CodexSubscriptionSlot = z.union([z.literal(1), z.literal(2)]);
export class CodexSubscriptionError extends Error {
  constructor(
    public readonly code:
      | 'disabled'
      | 'busy'
      | 'conflict'
      | 'authorization_required'
      | 'enabled_authorization',
  ) {
    super(
      {
        disabled: 'Codex 订阅已全部停用，请在后台「模型与用量」启用一个账号。',
        busy: '还有任务正在执行或等待处理，请结束这些任务后再切换或停用账号。',
        conflict: '启用账号已变化，请刷新后重新选择。',
        authorization_required: '请先完成这个账号的授权，再启用。',
        enabled_authorization:
          '请先停用这个账号，再重新授权。授权不会自动启用账号。',
      }[code],
    );
  }
}

export async function readEnabledCodexSubscription() {
  const [row] = await getDatabase()<{ slot: 1 | 2 }[]>`
    select slot from allrice_codex_subscriptions where enabled`;
  return row?.slot ?? null;
}

export async function requireEnabledCodexSubscription() {
  const slot = await readEnabledCodexSubscription();
  if (slot === null) throw new CodexSubscriptionError('disabled');
  return slot;
}

export async function listCodexSubscriptions(context: RequestContext) {
  await requirePlatformAdmin(context);
  return getDatabase()<{ slot: 1 | 2; label: string; enabled: boolean }[]>`
    select slot,label,enabled from allrice_codex_subscriptions order by slot`;
}

/** One short transaction fences job admission/claim, never sleeps with a lock.
 * Runs choose the credential store after their job becomes active. The account
 * cannot change until those jobs (including waiting/retry work) are terminal.
 */
export async function selectCodexSubscription(
  context: RequestContext,
  input: unknown,
) {
  const actor = await requirePlatformAdmin(context);
  const selection = z
    .object({
      enabledSlot: CodexSubscriptionSlot.nullable(),
      expectedEnabledSlot: CodexSubscriptionSlot.nullable(),
    })
    .strict()
    .parse(input);
  try {
    return await getDatabase().begin(async (tx) => {
      await tx`set local lock_timeout = '1000ms'`;
      // The same fence is used by authorization start. Acquire before row locks.
      await tx`select pg_advisory_xact_lock(8182)`;
      await tx`lock table allrice_jobs, allrice_platform_employee_test_runs in share mode`;
      const rows = await tx<{ slot: 1 | 2; enabled: boolean }[]>`
        select slot,enabled from allrice_codex_subscriptions order by slot for update`;
      const current = rows.find((row) => row.enabled)?.slot ?? null;
      if (current !== selection.expectedEnabledSlot)
        throw new CodexSubscriptionError('conflict');
      if (current === selection.enabledSlot) return { enabledSlot: current };
      const [busy] = await tx<{ busy: boolean }[]>`select
        exists(select 1 from allrice_jobs where status not in ('succeeded','failed','dead_letter','canceled'))
        or exists(select 1 from allrice_platform_employee_test_runs where status in ('queued','running')) as busy`;
      if (busy?.busy) throw new CodexSubscriptionError('busy');
      if (selection.enabledSlot !== null) {
        const [ready] = await tx`select 1 from allrice_provider_status
          where provider='codex' and subscription_slot=${selection.enabledSlot} and status='connected'
            and checked_at >= clock_timestamp()-interval '2 minutes'
            and not exists(select 1 from allrice_provider_authorization_flows
              where subscription_slot=${selection.enabledSlot} and state in ('pending','running','awaiting_user'))`;
        if (!ready) throw new CodexSubscriptionError('authorization_required');
      }
      if (selection.enabledSlot !== null)
        await tx`update allrice_provider_circuit_breakers set kill_switch=false,updated_by=${actor},updated_at=now()
        where connection_id='52000000-0000-4000-8000-000000000001'`;
      // Separate statements avoid transient unique-index violations on A -> B.
      await tx`update allrice_codex_subscriptions set enabled=false,updated_at=now() where enabled`;
      if (selection.enabledSlot !== null)
        await tx`update allrice_codex_subscriptions
        set enabled=true,updated_at=now() where slot=${selection.enabledSlot}`;
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
        values(${context.organizationId},${context.workspaceId},${actor},'codex_subscription.select','model_connection',
          '52000000-0000-4000-8000-000000000001','recorded','platform_admin',${context.requestId},
          ${tx.json({ previousSlot: current, enabledSlot: selection.enabledSlot })})`;
      return { enabledSlot: selection.enabledSlot };
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '55P03'
    )
      throw new CodexSubscriptionError('busy');
    throw error;
  }
}
