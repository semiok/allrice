import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  DEntryRolloutPolicySchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requireCurrentPlatformAdmin } from './platform-authority.ts';

// The existing platform release store is shared by Web and Worker. No process
// env, browser input or cached allowlist may enable an employee's 4.0 entry.
export const dEntryReleasePolicyKey = 'd_entry_rollout_policy';
const disabledPolicy = {
  revision: 'unpublished',
  defaultGeneration: '3.x' as const,
  selections: [],
};

/** Internal host read; callers establish current session/employee authority.
 * Missing configuration is the explicitly approved default-off policy. Invalid
 * stored configuration fails closed rather than silently changing a thread. */
export async function readDEntryReleasePolicy(
  sql: ReturnType<typeof getDatabase> | postgres.TransactionSql = getDatabase(),
  lock = false,
) {
  const [row] = await sql`select value from allrice_settings
    where scope_type='system' and scope_id is null and key=${dEntryReleasePolicyKey}
    ${lock ? sql`for share` : sql``}`;
  const parsed = DEntryRolloutPolicySchema.safeParse(
    row?.value ?? disabledPolicy,
  );
  if (!parsed.success || parsed.data.defaultGeneration !== '3.x')
    throw new Error('D entry published policy is unavailable');
  return parsed.data;
}

export async function getDEntryReleasePolicy(context: RequestContext) {
  await requireCurrentPlatformAdmin(context);
  return readDEntryReleasePolicy();
}

/** Published by the same platform-admin authority as native_question_mode.
 * Only exact person/employee tuples opt in; global enable is not supported. */
export async function updateDEntryReleasePolicy(
  context: RequestContext,
  input: unknown,
) {
  const parsed = DEntryRolloutPolicySchema.parse(input);
  if (parsed.defaultGeneration !== '3.x')
    throw new DataAccessError('authorization_denied');
  const policy = { ...parsed, revision: randomUUID() };
  await getDatabase().begin(async (tx) => {
    const actor = await requireCurrentPlatformAdmin(context, tx);
    const [setting] =
      await tx`insert into allrice_settings(scope_type,key,value,updated_by)
      values('system',${dEntryReleasePolicyKey},${tx.json(policy)},${actor})
      on conflict(scope_type,scope_id,key) do update
      set value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp()
      returning id`;
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${context.organizationId},${context.workspaceId},${actor},'d_entry_release.update',
        'setting',${setting!.id},'recorded','platform_admin',${context.requestId},
        ${tx.json({ revision: policy.revision })})`;
  });
  return policy;
}
