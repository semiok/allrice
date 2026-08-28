import {
  CodexProviderStatusSchema,
  type CodexProviderStatus,
} from '@allrice/contracts';

import { getDatabase } from './index.ts';

export async function recordCodexProviderStatus(
  statusInput: CodexProviderStatus,
) {
  const status = CodexProviderStatusSchema.parse(statusInput);
  const sql = getDatabase();
  await sql`
    insert into allrice_provider_status (
      provider, auth_mode, status, cli_version, detail_code, checked_at,
      updated_at
    ) values (
      'codex', 'chatgpt_subscription', ${status.status},
      ${status.cliVersion}, ${status.detailCode},
      ${status.checkedAt ? new Date(status.checkedAt) : new Date()}, now()
    ) on conflict (provider) do update set
      status = excluded.status, cli_version = excluded.cli_version,
      detail_code = excluded.detail_code, checked_at = excluded.checked_at,
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
    }[]
  >`
    select status, cli_version, detail_code, checked_at
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
  });
}
