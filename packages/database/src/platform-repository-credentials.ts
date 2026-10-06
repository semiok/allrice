import type postgres from 'postgres';
import { z } from 'zod';
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { encryptionKey, seal, unseal } from './mcp-credentials.ts';
import {
  platformRepository,
  PlatformRepositoryCredentialSchema,
  PlatformRepositoryTokenSchema,
  UpdatePlatformRepositoryCredentialSchema,
} from './platform-repository-credential-contracts.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
const storedSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string().uuid(),
    repositoryId: z.literal(platformRepository.id),
    revision: z.number().int().positive(),
    requestId: z.string().uuid(),
    secret: z.unknown().nullable(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
const settingsKey = (owner: string) =>
  `platform-repository-credential:${owner}:${platformRepository.id}`;
const associated = (owner: string, revision: number) =>
  Buffer.from(`${settingsKey(owner)}:private:${revision}`);

async function currentAdmin(context: RequestContext, sql: Sql) {
  const owner = await requirePlatformAdmin(context, sql);
  if (!context.sessionId) throw new DataAccessError('authentication_required');
  const [login] =
    await sql`select id from allrice_sessions where id=${context.sessionId} and user_id=${owner} and revoked_at is null and expires_at>clock_timestamp() for share`;
  if (!login) throw new DataAccessError('authorization_denied');
  return owner;
}
async function read(owner: string, sql: Sql) {
  const [row] =
    await sql`select value,updated_at from allrice_runtime_metadata where key=${settingsKey(owner)}`;
  if (!row) return null;
  const stored = storedSchema.parse(row.value);
  if (stored.ownerId !== owner)
    throw new DataAccessError('authorization_denied');
  return { stored, updatedAt: (row.updated_at as Date).toISOString() };
}
function tokenFor(owner: string, value: Stored, key?: string) {
  return PlatformRepositoryTokenSchema.parse(
    unseal(
      value.secret,
      encryptionKey(key ?? process.env.ALLRICE_MCP_CREDENTIAL_KEY),
      associated(owner, value.revision),
    ),
  );
}

/** Public configuration facts only. Configured does not mean GitHub or CI is reachable. */
export async function getPlatformRepositoryCredential(
  context: RequestContext,
  sql: Sql = getDatabase(),
) {
  const owner = await currentAdmin(context, sql),
    value = await read(owner, sql),
    configured = !!value?.stored.secret;
  let state: 'not_configured' | 'configured' | 'unavailable' = 'not_configured';
  if (configured) {
    try {
      tokenFor(owner, value!.stored);
      state = 'configured';
    } catch {
      state = 'unavailable';
    }
  }
  return PlatformRepositoryCredentialSchema.parse({
    repositoryId: platformRepository.id,
    repository: platformRepository.fullName,
    revision: value?.stored.revision ?? 0,
    configured,
    state,
    updatedAt: value?.updatedAt ?? null,
    lastWriteRequestId: value?.stored.requestId ?? null,
  });
}

export async function updatePlatformRepositoryCredential(
  context: RequestContext,
  input: unknown,
  db = getDatabase(),
) {
  const value = UpdatePlatformRepositoryCredentialSchema.parse(input);
  await db.begin(async (tx) => {
    const owner = await currentAdmin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtext(${settingsKey(owner)}))`;
    const previous = await read(owner, tx);
    if ((previous?.stored.revision ?? 0) !== value.expectedRevision)
      throw new QueueError('conflict');
    const revision = value.expectedRevision + 1;
    const stored = {
      version: 1,
      ownerId: owner,
      repositoryId: platformRepository.id,
      revision,
      requestId: value.requestId,
      secret:
        value.action === 'replace'
          ? seal(
              value.token,
              encryptionKey(process.env.ALLRICE_MCP_CREDENTIAL_KEY),
              associated(owner, revision),
            )
          : null,
    };
    await tx`insert into allrice_runtime_metadata(key,value) values (${settingsKey(owner)},${tx.json(stored)})
      on conflict (key) do update set value=excluded.value,updated_at=clock_timestamp()`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values (${context.organizationId},${context.workspaceId},${owner},${'platform_repository.credential.' + value.action},'platform_repository_credential',${owner},'allowed','platform_admin_private_repository',${value.requestId},${tx.json({ revision, repositoryId: platformRepository.id })})`;
  });
  return getPlatformRepositoryCredential(context, db);
}

/** Server-only. A fresh login and exact credential revision are required on each use. */
export async function readPlatformRepositoryCredential(
  context: RequestContext,
  expectedRevision: number,
  sql: Sql = getDatabase(),
) {
  const owner = await currentAdmin(context, sql),
    value = await read(owner, sql);
  if (!value?.stored.secret || value.stored.revision !== expectedRevision)
    throw new DataAccessError('authorization_denied');
  return tokenFor(owner, value.stored);
}
