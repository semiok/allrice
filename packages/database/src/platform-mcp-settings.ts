import type postgres from 'postgres';
import {
  GithubMcpSettingsSchema,
  UpdateGithubMcpSettingsSchema,
  McpError,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { encryptionKey, seal, unseal } from './mcp-credentials.ts';

type Sql = ReturnType<typeof postgres> | postgres.TransactionSql;
type Stored = {
  revision: number;
  clientId: string;
  callbackUrl: string;
  secret: unknown;
};
const settingsKey = 'platform-mcp-oauth:github';
const associated = (revision: number) =>
  Buffer.from(`${settingsKey}:${revision}`);
const key = (value?: string) =>
  encryptionKey(value ?? process.env.ALLRICE_MCP_CREDENTIAL_KEY);
async function read(sql: Sql): Promise<Stored | null> {
  const [row] = await sql<
    { value: Stored }[]
  >`select value from allrice_runtime_metadata where key=${settingsKey}`;
  return row?.value ?? null;
}
/** Public readiness contains no client credentials; only read after workspace authorization. */
export async function githubMcpOAuthReady(sql: Sql = getDatabase()) {
  return !!(await read(sql))?.secret;
}
export async function getGithubMcpSettings(
  context: RequestContext,
  sql: Sql = getDatabase(),
) {
  await requirePlatformAdmin(context, sql);
  const data = await read(sql);
  return GithubMcpSettingsSchema.parse({
    revision: data?.revision ?? 0,
    clientId: data?.clientId ?? '',
    callbackUrl: data?.callbackUrl ?? '',
    secretConfigured: !!data?.secret,
    ready: !!data?.secret,
  });
}
export class McpSettingsConflict extends Error {}
export async function updateGithubMcpSettings(
  context: RequestContext,
  input: unknown,
  options: {
    database?: ReturnType<typeof postgres>;
    credentialKey?: string;
  } = {},
) {
  const value = UpdateGithubMcpSettingsSchema.parse(input);
  const db = options.database ?? getDatabase();
  await db.begin(async (tx) => {
    const actor = await requirePlatformAdmin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtext(${settingsKey}))`;
    const previous = await read(tx);
    if ((previous?.revision ?? 0) !== value.expectedRevision)
      throw new McpSettingsConflict();
    // Changing the client ID requires its matching secret, never the old client's secret.
    if (
      !value.clientSecret &&
      (!previous || previous.clientId !== value.clientId)
    )
      throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
    const secret =
      value.clientSecret ??
      unseal(
        previous!.secret,
        key(options.credentialKey),
        associated(previous!.revision),
      );
    const revision = value.expectedRevision + 1;
    const stored = {
      revision,
      clientId: value.clientId,
      callbackUrl: value.callbackUrl,
      secret: seal(secret, key(options.credentialKey), associated(revision)),
    };
    await tx`insert into allrice_runtime_metadata(key,value) values (${settingsKey},${tx.json(stored)}) on conflict (key) do update set value=excluded.value,updated_at=now()`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata) values (${context.organizationId},${context.workspaceId},${actor},'platform_mcp.github.configure','platform_mcp_settings',${context.workspaceId},'recorded','platform_admin',${tx.json({ revision })})`;
  });
  return getGithubMcpSettings(context, db);
}
/** Internal only: snapshot into an already authorized, encrypted member OAuth session. */
export async function readGithubMcpOAuthClient(
  sql: Sql,
  credentialKey: Buffer,
) {
  const data = await read(sql);
  if (!data) throw new McpError('MCP_CREDENTIAL_UNAVAILABLE');
  return {
    callbackUrl: data.callbackUrl,
    clientInformation: {
      client_id: data.clientId,
      client_secret: unseal(
        data.secret,
        credentialKey,
        associated(data.revision),
      ),
    },
  };
}
