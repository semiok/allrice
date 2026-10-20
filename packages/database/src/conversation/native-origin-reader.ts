import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import type postgres from 'postgres';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import {
  NativeRootOriginSchema,
  nativeRootDigest,
  newNativeGeneration,
  type NativeRootOrigin,
} from './native-root-origin.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scope = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
  })
  .strict();
export type NativeOriginReaderScope = z.infer<typeof scope>;
const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal('unbound_chat_first_writer'),
    sourceArtifactId: digest,
    targetArtifactId: digest,
    generation: z.literal(newNativeGeneration),
    profileId: z.literal('restricted'),
    sessionFormat: z.literal(4),
    prerequisites: z
      .object({
        nodeMajor: z.number().int(),
        platform: z.string(),
        arch: z.string(),
        modules: z.string(),
      })
      .strict(),
    evidenceDigest: digest,
    contexts: z
      .array(scope.extend({ origin: NativeRootOriginSchema }).strict())
      .min(1)
      .max(64),
  })
  .strict();

export interface NativeOriginReaderApproval extends NativeOriginReaderScope {
  approvalDigest: string;
  sourceArtifactId: string;
  targetArtifactId: string;
  generation: typeof newNativeGeneration;
  profileId: 'restricted';
  contextId: string;
  originDigest: string;
  sourceOrigin: NativeRootOrigin;
  storageNamespace: string;
  evidenceDigest: string;
}

function fail(): never {
  throw Error('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
}
function absolute(value: string) {
  if (
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes('\0')
  )
    fail();
  return value;
}

/** Independent operator approval, not a code registry or permission grant.
 * One retired source, exact previously unbound chat origins, one verified
 * current target. No version-wide aliases, existing-writer migration or model
 * supplied paths. The storage env is an explicit cleanup protection reference.
 * Read/hash the bounded data file rather than accepting mtime as approval. */
export function configuredNativeOriginReaders(): readonly NativeOriginReaderApproval[] {
  const path = process.env.ALLRICE_DSH_ORIGIN_READER_APPROVAL_PATH?.trim();
  const expected =
    process.env.ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256?.trim();
  const storage = process.env.ALLRICE_DSH_ORIGIN_READER_STORAGE_ROOT?.trim();
  if (!path && !expected && !storage) return [];
  try {
    if (!path || !expected || !storage || !digest.safeParse(expected).success)
      fail();
    absolute(path);
    absolute(storage);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 256 * 1024 ||
      realpathSync(path) !== path
    )
      fail();
    const storageStat = lstatSync(storage);
    if (
      !storageStat.isDirectory() ||
      storageStat.isSymbolicLink() ||
      realpathSync(storage) !== storage
    )
      fail();
    const bytes = readFileSync(path);
    if (
      'sha256:' + createHash('sha256').update(bytes).digest('hex') !==
      expected
    )
      fail();
    const policy = policySchema.parse(JSON.parse(bytes.toString('utf8')));
    if (
      policy.sourceArtifactId === policy.targetArtifactId ||
      !digest.safeParse(process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID).success ||
      process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID !==
        process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID ||
      policy.prerequisites.nodeMajor !==
        Number(process.versions.node.split('.')[0]) ||
      policy.prerequisites.platform !== process.platform ||
      policy.prerequisites.arch !== process.arch ||
      policy.prerequisites.modules !== process.versions.modules
    )
      fail();
    const { contexts, ...proof } = policy;
    const seen = new Set<string>();
    return contexts.map((entry) => {
      const { origin } = entry;
      if (
        seen.has(origin.contextId) ||
        origin.contextKind !== 'chat' ||
        origin.rootSeed !== origin.contextId ||
        origin.artifactId !== policy.sourceArtifactId ||
        origin.profileId !== policy.profileId ||
        origin.distributionGeneration !== policy.generation
      )
        fail();
      seen.add(origin.contextId);
      const storageNamespace = posix.join(
        storage,
        entry.organizationId,
        entry.workspaceId,
        entry.ownerId,
        origin.contextId,
        'sessions',
      );
      return {
        organizationId: entry.organizationId,
        workspaceId: entry.workspaceId,
        ownerId: entry.ownerId,
        approvalDigest: nativeRootDigest({ proof, entry, storageNamespace }),
        sourceArtifactId: policy.sourceArtifactId,
        targetArtifactId: policy.targetArtifactId,
        generation: policy.generation,
        profileId: policy.profileId,
        contextId: origin.contextId,
        originDigest: nativeRootDigest(origin),
        sourceOrigin: origin,
        storageNamespace,
        evidenceDigest: policy.evidenceDigest,
      };
    });
  } catch {
    return fail();
  }
}

function sameScope(
  approval: NativeOriginReaderApproval,
  input: NativeOriginReaderScope,
) {
  return (
    approval.organizationId === input.organizationId &&
    approval.workspaceId === input.workspaceId &&
    approval.ownerId === input.ownerId
  );
}

export function nativeOriginReaderForOrigin(
  origin: NativeRootOrigin,
  input: NativeOriginReaderScope,
) {
  const entries = configuredNativeOriginReaders();
  const entry = entries.find((item) => item.contextId === origin.contextId);
  if (!entry) {
    // A new or unreviewed reference to a retired source is never covered by a
    // different context's proof; it also must not fall back to original code.
    if (entries.some((item) => item.sourceArtifactId === origin.artifactId))
      fail();
    return undefined;
  }
  if (
    !sameScope(entry, input) ||
    entry.originDigest !== nativeRootDigest(origin)
  )
    fail();
  return entry;
}

export function nativeOriginReaderForBinding(
  input: NativeOriginReaderScope & {
    originReaderApprovalDigest: string;
    artifactId: string;
    contextKind: string;
    contextId: string;
    profileId: string;
    storageNamespace: string;
  },
) {
  const entry = configuredNativeOriginReaders().find(
    (item) => item.approvalDigest === input.originReaderApprovalDigest,
  );
  if (
    !entry ||
    !sameScope(entry, input) ||
    input.contextKind !== 'chat' ||
    input.contextId !== entry.contextId ||
    input.artifactId !== entry.targetArtifactId ||
    input.profileId !== entry.profileId ||
    input.storageNamespace !== entry.storageNamespace
  )
    fail();
  return entry;
}

/** Metadata check only, called after the normal caller/Job admission. Any
 * earlier writer is outside this slice. An already adopted current writer
 * permits later content generations without pretending the namespace is empty. */
export async function checkNativeOriginReaderBindings(
  tx: postgres.TransactionSql,
  approval: NativeOriginReaderApproval,
) {
  const rows =
    await tx`select artifact_id,artifact_manifest_digest,organization_id,workspace_id,owner_id,
      storage_namespace,storage_context_key,distribution_generation,profile_id,binding_basis,
      root_origin_digest,origin_reader_approval_digest
    from allrice_native_session_bindings where context_kind='chat' and context_id=${approval.contextId}`;
  if (
    rows.some(
      (row) =>
        row.artifact_id !== approval.targetArtifactId ||
        row.artifact_manifest_digest !== approval.targetArtifactId ||
        row.organization_id !== approval.organizationId ||
        row.workspace_id !== approval.workspaceId ||
        row.owner_id !== approval.ownerId ||
        row.storage_namespace !== approval.storageNamespace ||
        row.storage_context_key !== approval.contextId ||
        row.distribution_generation !== approval.generation ||
        row.profile_id !== approval.profileId ||
        row.binding_basis !== 'business_root_origin' ||
        row.root_origin_digest !== approval.originDigest ||
        row.origin_reader_approval_digest !== approval.approvalDigest,
    )
  )
    fail();
  return rows.length > 0;
}

/** Read-only deployment observation, never an execution grant or a producer
 * fence. The operator must still stop old producers before switching the exact
 * policy. Startup may recover an admitted target Job; pre-stop additionally
 * rejects unfinished work (including unknown operations) for these contexts. */
export async function inspectNativeOriginReaderStates(
  options: { requireIdle?: boolean } = {},
) {
  const readers = configuredNativeOriginReaders();
  if (!readers.length) return [];
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      const states = [];
      for (const approval of readers) {
        const [context] =
          await tx`select native_root_origin from allrice_chat_sessions
        where id=${approval.contextId} and organization_id=${approval.organizationId}
          and workspace_id=${approval.workspaceId} and owner_id=${approval.ownerId}`;
        // Archived origins still protect their data and reader. Do not revive or
        // rewrite them to make an execution-only admission helper accept them.
        if (
          !context ||
          nativeRootDigest(context.native_root_origin) !== approval.originDigest
        )
          fail();
        const adopted = await checkNativeOriginReaderBindings(tx, approval);
        if (options.requireIdle) {
          const [busy] = await tx`with roots as (
          select run_id from allrice_employee_runs where session_id=${approval.contextId}
        ), subjects as (
          select run_id from roots union select run_id from allrice_runtime_run_links where root_run_id in (select run_id from roots)
        ), busy as (
          select 1 from allrice_runs where id in (select run_id from subjects)
            and state not in ('succeeded','failed','canceled')
          union all select 1 from allrice_jobs where run_id in (select run_id from subjects)
            and status not in ('succeeded','failed','dead_letter','canceled')
          union all select 1 from allrice_runtime_operations where root_run_id in (select run_id from subjects)
            and (coalesce(snapshot->>'status','') not in ('succeeded','failed','canceled','partial') or lease_expires_at>clock_timestamp())
          union all select 1 from allrice_conversation_runtimes where session_id=${approval.contextId}
            and (state='running' or active_run_id is not null)
          union all select 1 from allrice_assistant_model_admissions where root_run_id in (select run_id from subjects)
            and finished_at is null
          union all select 1 from allrice_assistant_instances where root_run_id in (select run_id from roots)
            and (status not in ('completed','partial','failed','canceled') or stopped_at is null)
          union all select 1 from allrice_assistant_messages where root_run_id in (select run_id from roots)
            and status not in ('adopted','canceled')
          union all select 1 from allrice_native_question_waits where run_id in (select run_id from subjects) and state<>'continued'
          union all select 1 from allrice_native_task_dispatches where run_id in (select run_id from subjects) and state<>'completed'
          union all select 1 from allrice_assistant_usage where root_run_id in (select run_id from roots)
            and metric='tool_calls' and amount>0 and settled_amount is null
          union all select 1 from allrice_task_calls where run_id in (select run_id from subjects) and finished_at is null
          union all select 1 from allrice_task_resource_waits where run_id in (select run_id from subjects)
            and (state not in ('completed','failed','canceled') or finished_at is null)
        ) select 1 from busy limit 1`;
          if (busy) throw Error('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
        }
        const sessions = await tx<
          { nativeSessionId: string }[]
        >`select native_session_id as "nativeSessionId"
        from allrice_native_session_bindings where context_kind='chat' and context_id=${approval.contextId}
        order by native_session_id`;
        states.push({
          approval,
          adopted,
          nativeSessionIds: sessions.map((s) => s.nativeSessionId),
        });
      }
      return states;
    },
  );
}
