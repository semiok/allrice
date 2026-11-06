import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccountCapabilitySettingsSchema,
  cloudProjectCapabilityId,
  defaultAccountCapabilitySettings,
  UuidSchema,
} from '@allrice/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { DataAccessError } from '../data.ts';

type Scope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
};
const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    capabilityId: z.literal(cloudProjectCapabilityId),
    configVersion: z.literal(1),
    enabled: z.boolean(),
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    sessionId: UuidSchema,
    configurationDigest: z.string(),
  })
  .strict();

function configurationDigest(config: { configVersion: 1; enabled: boolean }) {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        capabilityId: cloudProjectCapabilityId,
        configVersion: config.configVersion,
        enabled: config.enabled,
      }),
    )
    .digest('hex')}`;
}

/** Called only inside ordinary conversation creation, never Run admission.
 * The persisted session ID is already part of every Run's exact reference.
 * Updating account configuration is not revocation of an existing conversation. */
export async function freezeConversationCapabilities(
  sql: TransactionSql,
  scope: Scope,
) {
  const [row] = await sql<{ capability_settings: unknown }[]>`
    select capability_settings from allrice_user_preferences where user_id=${scope.ownerId}
  `;
  const settings = row
    ? AccountCapabilitySettingsSchema.parse(row.capability_settings)
    : defaultAccountCapabilitySettings;
  const config = settings[cloudProjectCapabilityId];
  return SnapshotSchema.parse({
    schemaVersion: 1,
    capabilityId: cloudProjectCapabilityId,
    ...config,
    ...scope,
    configurationDigest: configurationDigest(config),
  });
}

/** A reduction of published qualification only; dispatch still checks the
 * existing tenant, file, execution and approval gates. No tool can be added. */
export async function qualifyConversationProjectTools(
  sql: Sql | TransactionSql,
  scope: Scope,
  toolNames: string[],
  baseRice: boolean,
) {
  if (!toolNames.includes('workspace.project')) return toolNames;
  const [row] = await sql<{ account_capability_snapshot: unknown }[]>`
    select account_capability_snapshot from allrice_chat_sessions
    where id=${scope.sessionId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
      and visibility='private' and archived_at is null
  `;
  if (!row) throw new DataAccessError('authorization_denied');
  // Retain #784's legacy default-Rice reduction for pre-feature conversations.
  // Never backfill them from the current account switch or rewrite old Runs.
  let enabled = !baseRice;
  if (row.account_capability_snapshot !== null) {
    const result = SnapshotSchema.safeParse(row.account_capability_snapshot);
    if (
      !result.success ||
      result.data.organizationId !== scope.organizationId ||
      result.data.workspaceId !== scope.workspaceId ||
      result.data.ownerId !== scope.ownerId ||
      result.data.sessionId !== scope.sessionId ||
      result.data.configurationDigest !== configurationDigest(result.data)
    )
      throw new DataAccessError('authorization_denied');
    enabled = result.data.enabled;
  }
  return enabled
    ? toolNames
    : toolNames.filter((name) => name !== 'workspace.project');
}
