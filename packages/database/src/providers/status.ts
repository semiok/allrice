import {
  CodexProviderStatusSchema,
  type CodexProviderStatus,
} from '@allrice/contracts';

import { getDatabase } from '../core/client.ts';

export async function recordCodexProviderStatus(
  statusInput: CodexProviderStatus,
) {
  const status = CodexProviderStatusSchema.parse(statusInput);
  const sql = getDatabase();
  // Provider checkedAt is probe start; quota.checkedAt is read completion.
  // All replacements require the latest probe-start watermark; same-account
  // readings additionally compete by completion. Late old-account reads must
  // not resurrect a superseded grant. Errors cannot erase live exhaustion.
  // Missing quota means no observation; explicit null is a clear/tombstone.
  const quotaObserved = status.quota !== undefined;
  await sql`
    insert into allrice_provider_status as current_status (
      provider, auth_mode, status, cli_version, detail_code, checked_at,
      updated_at, subscription_quota
    ) values (
      'codex', 'chatgpt_subscription', ${status.status},
      ${status.cliVersion}, ${status.detailCode},
      ${status.checkedAt ? new Date(status.checkedAt) : new Date()}, now(),
      ${status.quota ? sql.json(JSON.parse(JSON.stringify(status.quota))) : null}
    ) on conflict (provider) do update set
      status = case when excluded.checked_at > current_status.checked_at
        then excluded.status else current_status.status end,
      cli_version = case when excluded.checked_at > current_status.checked_at
        then excluded.cli_version else current_status.cli_version end,
      detail_code = case when excluded.checked_at > current_status.checked_at
        then excluded.detail_code else current_status.detail_code end,
      checked_at = greatest(current_status.checked_at, excluded.checked_at),
      subscription_quota = case
        when excluded.checked_at < current_status.checked_at
          then current_status.subscription_quota
        when excluded.status = 'disconnected'
          and excluded.checked_at > current_status.checked_at then null
        when not ${quotaObserved} then current_status.subscription_quota
        when excluded.subscription_quota is null then
          case when excluded.checked_at > current_status.checked_at
            then null else current_status.subscription_quota end
        when current_status.subscription_quota is null then
          case when excluded.checked_at > current_status.checked_at
            and (excluded.subscription_quota->>'checkedAt')::timestamptz
              > current_status.checked_at
            then excluded.subscription_quota else null end
        when (
          excluded.subscription_quota->>'accountFingerprint' is null
          or (excluded.subscription_quota->>'accountFingerprint')
            = (current_status.subscription_quota->>'accountFingerprint')
        ) and (exists (
          select 1
          from jsonb_array_elements(current_status.subscription_quota->'buckets') old_bucket,
            jsonb_array_elements(old_bucket->'windows') old_window
          where old_window->>'status' = 'available'
            and (old_window->>'usedPercent')::numeric = 100
            and (old_window->>'resetsAt')::numeric > extract(epoch from now())
            and (
              excluded.subscription_quota->>'status' <> 'available'
              or not exists (
                select 1
                from jsonb_array_elements(excluded.subscription_quota->'buckets') new_bucket,
                  jsonb_array_elements(new_bucket->'windows') new_window
                where (new_bucket->>'limitId') is not distinct from (old_bucket->>'limitId')
                  and new_window->>'slot' = old_window->>'slot'
                  and new_window->>'windowDurationMins' = old_window->>'windowDurationMins'
                  and new_window->>'status' = 'available'
              )
            )
        ) or exists (
          select 1
          from jsonb_array_elements(current_status.subscription_quota->'buckets') old_bucket
          where old_bucket->>'limitReached' = 'true'
            and (current_status.subscription_quota->>'checkedAt')::timestamptz
              between now() - interval '5 minutes' and now() + interval '5 seconds'
            and (
              excluded.subscription_quota->>'status' <> 'available'
              or not exists (
                select 1
                from jsonb_array_elements(excluded.subscription_quota->'buckets') new_bucket
                where (new_bucket->>'limitId') is not distinct from (old_bucket->>'limitId')
                  and new_bucket->>'limitReached' = 'false'
                  and exists (
                    select 1 from jsonb_array_elements(new_bucket->'windows') new_window
                    where new_window->>'status' = 'available'
                  )
              )
            )
        )) then current_status.subscription_quota
        when (excluded.subscription_quota->>'accountFingerprint')
          is not distinct from
            (current_status.subscription_quota->>'accountFingerprint') then
          case when (excluded.subscription_quota->>'checkedAt')::timestamptz
            > (current_status.subscription_quota->>'checkedAt')::timestamptz
            then excluded.subscription_quota
            else current_status.subscription_quota end
        when excluded.checked_at > current_status.checked_at
          then excluded.subscription_quota
        else current_status.subscription_quota
      end,
      updated_at = now()
  `;
}

export async function getCodexProviderStatus() {
  const sql = getDatabase();
  const rows = await sql<
    {
      status: CodexProviderStatus['status'];
      cli_version: string | null;
      detail_code: string | null;
      checked_at: Date;
      subscription_quota: unknown;
    }[]
  >`
    select status, cli_version, detail_code, checked_at, subscription_quota
    from allrice_provider_status where provider = 'codex'
  `;
  const row = rows[0];
  return CodexProviderStatusSchema.parse({
    provider: 'codex',
    authMode: 'chatgpt_subscription',
    status: row?.status ?? 'unknown',
    cliVersion: row?.cli_version ?? null,
    detailCode: row?.detail_code ?? 'worker_not_checked',
    checkedAt: row?.checked_at.toISOString() ?? null,
    quota: row?.subscription_quota ?? null,
  });
}
