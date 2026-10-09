import type postgres from 'postgres';
import { z } from 'zod';
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';
import { currentMaintenanceAdmin } from './platform-maintenance.ts';
import { encryptionKey, seal, unseal } from './mcp-credentials.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  platformRepository,
  PlatformRepositoryTokenSchema,
} from './platform-repository-credential-contracts.ts';
import {
  MaintenanceGithubIdentitySchema,
  MaintenanceGithubBotSchema,
  UpdateMaintenanceGithubBotSchema,
  type MaintenanceGithubIdentity,
} from './platform-maintenance-github-contracts.ts';

type Tx = postgres.TransactionSql;
const key = `platform-maintenance-github-bot:${platformRepository.id}`;
const associated = (revision: number) =>
  Buffer.from(`${key}:private:${revision}`);
const StoredSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    requestId: z.string().uuid(),
    inputDigest: z.string(),
    identity: MaintenanceGithubIdentitySchema.nullable(),
    verifiedAt: z.string().datetime({ offset: true }).nullable(),
    secret: z.unknown().nullable(),
  })
  .strict();
const denied = () => {
  throw new DataAccessError('authorization_denied');
};
function central() {
  if (process.env.ALLRICE_MAINTENANCE_CENTRAL_ENABLED !== '1') denied();
}
async function stored(tx: Tx) {
  const [r] =
    await tx`select value,updated_at from allrice_runtime_metadata where key=${key}`;
  return r
    ? {
        value: StoredSchema.parse(r.value),
        updatedAt: (r.updated_at as Date).toISOString(),
      }
    : null;
}
function decrypt(value: z.infer<typeof StoredSchema>) {
  if (
    !value.secret ||
    !value.identity ||
    value.identity.revision !== value.revision
  )
    denied();
  return PlatformRepositoryTokenSchema.parse(
    unseal(
      value.secret,
      encryptionKey(process.env.ALLRICE_MCP_CREDENTIAL_KEY),
      associated(value.revision),
    ),
  );
}
function publicFacts(r: Awaited<ReturnType<typeof stored>>) {
  let state:
    'central_disabled' | 'not_configured' | 'configured' | 'unavailable' =
    process.env.ALLRICE_MAINTENANCE_CENTRAL_ENABLED === '1'
      ? 'not_configured'
      : 'central_disabled';
  if (state !== 'central_disabled' && r?.value.secret) {
    try {
      decrypt(r.value);
      state = 'configured';
    } catch {
      state = 'unavailable';
    }
  }
  return MaintenanceGithubBotSchema.parse({
    repository: platformRepository.fullName,
    revision: r?.value.revision ?? 0,
    configured: !!r?.value.secret,
    state,
    identity: r?.value.identity ?? null,
    verifiedAt: r?.value.verifiedAt ?? null,
    updatedAt: r?.updatedAt ?? null,
    lastWriteRequestId: r?.value.requestId ?? null,
  });
}
export async function getMaintenanceGithubBot(context: RequestContext) {
  return getDatabase().begin(async (tx) => {
    await currentMaintenanceAdmin(context, tx);
    return publicFacts(await stored(tx));
  });
}
/** Fixed, GET-only credential verification. Never use an operator credential,
 * redirect, caller URL or response body in an error or audit event. */
async function verify(
  token: string,
  expectedLogin: string,
  fetcher: typeof fetch,
) {
  async function get(path: string) {
    try {
      const r = await fetcher('https://api.github.com' + path, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'user-agent': 'AllRice-Maintenance-Bot',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok || !r.body) {
        await r.body?.cancel();
        denied();
      }
      const reader = r.body!.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 100000) denied();
          chunks.push(part.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      denied();
    }
  }
  const [u, r] = await Promise.all([
    get('/user'),
    get('/repos/' + platformRepository.fullName),
  ]);
  const identity = MaintenanceGithubIdentitySchema.safeParse({
    revision: 1,
    login: u?.login,
    userId: u?.id,
  });
  if (
    !identity.success ||
    identity.data.login.toLowerCase() !== expectedLogin.toLowerCase() ||
    r?.id !== platformRepository.id ||
    r?.full_name !== platformRepository.fullName ||
    !(
      r.permissions &&
      typeof r.permissions === 'object' &&
      'push' in r.permissions &&
      r.permissions.push === true
    )
  )
    denied();
  return identity.data;
}
export async function updateMaintenanceGithubBot(
  context: RequestContext,
  raw: unknown,
  options: { fetcher?: typeof fetch } = {},
) {
  central();
  const request = UpdateMaintenanceGithubBotSchema.parse(raw),
    digest = technicalDigest(request),
    db = getDatabase();
  const prior = await db.begin(async (tx) => {
    await currentMaintenanceAdmin(context, tx);
    return stored(tx);
  });
  if (prior?.value.requestId === request.requestId) {
    if (prior.value.inputDigest !== digest) throw new QueueError('conflict');
    return publicFacts(prior);
  }
  if ((prior?.value.revision ?? 0) !== request.expectedRevision)
    throw new QueueError('conflict');
  const identity =
    request.action === 'replace'
      ? await verify(
          request.token,
          request.expectedLogin,
          options.fetcher ?? fetch,
        )
      : null;
  return db.begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
    const previous = await stored(tx);
    if (previous?.value.requestId === request.requestId) {
      if (previous.value.inputDigest !== digest)
        throw new QueueError('conflict');
      return publicFacts(previous);
    }
    if ((previous?.value.revision ?? 0) !== request.expectedRevision)
      throw new QueueError('conflict');
    const revision = request.expectedRevision + 1;
    const value = StoredSchema.parse({
      version: 1,
      revision,
      requestId: request.requestId,
      inputDigest: digest,
      identity: identity ? { ...identity, revision } : null,
      verifiedAt: identity ? new Date().toISOString() : null,
      secret:
        request.action === 'replace'
          ? seal(
              request.token,
              encryptionKey(process.env.ALLRICE_MCP_CREDENTIAL_KEY),
              associated(revision),
            )
          : null,
    });
    await tx`insert into allrice_runtime_metadata(key,value) values(${key},${tx.json(JSON.parse(JSON.stringify(value)))}) on conflict(key) do update set value=excluded.value,updated_at=clock_timestamp()`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata) values(${context.organizationId},${context.workspaceId},${owner},${'maintenance.github_bot.' + request.action},'maintenance_github_bot',${owner},'recorded','central_platform_admin',${request.requestId},${tx.json({ revision, identity: value.identity, repository: platformRepository.fullName })})`;
    await currentMaintenanceAdmin(context, tx);
    return publicFacts(await stored(tx));
  });
}
/** Trusted server only. Reconciliation can use a rotated credential for the
 * same exact bot; writes require the frozen revision as well as the identity. */
export async function readMaintenanceGithubBot(
  tx: Tx,
  expected: MaintenanceGithubIdentity,
  intent: 'write' | 'reconcile' = 'write',
) {
  central();
  const frozen = MaintenanceGithubIdentitySchema.parse(expected);
  await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
  const r = await stored(tx);
  if (!r) denied();
  const token = decrypt(r!.value),
    identity = r!.value.identity!;
  if (
    frozen.userId !== identity.userId ||
    frozen.login !== identity.login ||
    (intent === 'write' && frozen.revision !== identity.revision)
  )
    denied();
  return { identity, token };
}
export async function maintenanceGithubIdentity(tx: Tx) {
  central();
  await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
  const r = await stored(tx);
  if (!r) denied();
  decrypt(r!.value);
  return MaintenanceGithubIdentitySchema.parse(r!.value.identity);
}

export async function maintenanceGithubReady(tx: Tx) {
  return publicFacts(await stored(tx)).state === 'configured';
}
