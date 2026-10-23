import type postgres from 'postgres';
import { z } from 'zod';
import { getDatabase } from '../core/client.ts';
import { nativeRootDigest } from '../conversation/current-execution-binding.ts';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime();
const base = {
  version: z.literal(1),
  runtimeId: uuid,
  workerBootId: uuid,
  observedAt: time,
};
export const DshCloseContextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('context'),
      contextKind: z.enum([
        'chat',
        'platform_technical',
        'experience_consolidation',
        'platform_employee_test',
      ]),
      contextId: uuid,
      organizationId: uuid,
      workspaceId: uuid,
      ownerId: uuid,
    })
    .strict(),
  z
    .object({
      kind: z.literal('provider'),
      purpose: z.enum([
        'codex_authorization',
        'codex_probe',
        'codex_search',
        'codex_image',
      ]),
      slot: z.union([z.literal(1), z.literal(2)]).optional(),
    })
    .strict(),
]);
export type DshCloseContext = z.infer<typeof DshCloseContextSchema>;
export const DshRuntimeOwnedObservationSchema = z
  .object({
    ...base,
    kind: z.literal('owned'),
    workerId: uuid,
    serviceManifestDigest: digest,
    artifactId: digest,
    profileId: z.enum(['restricted', 'technical']),
    context: DshCloseContextSchema,
  })
  .strict();
export type DshRuntimeOwnedObservation = z.infer<
  typeof DshRuntimeOwnedObservationSchema
>;
const observationBase = { ...base, ownerDigest: digest };
export const DshRuntimeCloseObservationSchema = z.discriminatedUnion('kind', [
  z.object({ ...observationBase, kind: z.literal('close_started') }).strict(),
  z
    .object({
      ...observationBase,
      kind: z.literal('close_request'),
      acknowledged: z.boolean(),
      wrapper: z
        .object({
          version: z.literal(1),
          sdkShutdown: z.boolean(),
          rootDisposed: z.boolean(),
          priorFramesFlushed: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      kind: z.literal('process_closed'),
      fact: z.discriminatedUnion('source', [
        z
          .object({
            source: z.literal('child_close'),
            stdioClosed: z.literal(true),
            exitCode: z
              .number()
              .int()
              .min(-2147483648)
              .max(2147483647)
              .nullable(),
            signal: z
              .string()
              .regex(/^SIG[A-Z0-9]+$/)
              .max(32)
              .nullable(),
            terminationAttempted: z.enum(['SIGTERM', 'SIGKILL']).nullable(),
          })
          .strict(),
        z
          .object({
            source: z.literal('never_spawned'),
            spawnAttempted: z.literal(false),
            reason: z.literal('admission_closed_before_spawn'),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type DshRuntimeCloseObservation = z.infer<
  typeof DshRuntimeCloseObservationSchema
>;
export type DshCloseObservationDetails =
  | { kind: 'close_started' }
  | Pick<
      Extract<DshRuntimeCloseObservation, { kind: 'close_request' }>,
      'kind' | 'acknowledged' | 'wrapper'
    >
  | Pick<
      Extract<DshRuntimeCloseObservation, { kind: 'process_closed' }>,
      'kind' | 'fact'
    >;
const rowSchema = z
  .object({
    runtimeId: uuid,
    workerBootId: uuid,
    kind: z.enum(['owned', 'close_started', 'close_request', 'process_closed']),
    ownerDigest: digest,
    payloadDigest: digest,
    payload: z.unknown(),
  })
  .strict();
type Row = z.infer<typeof rowSchema>;
type Reader = postgres.Sql | postgres.TransactionSql;
type OwnerReceipt = {
  owner: DshRuntimeOwnedObservation;
  ownerDigest: string;
};

function fail(code: string): never {
  throw new Error(code);
}
function validateRow(raw: unknown) {
  const row = rowSchema.parse(raw);
  const payload =
    row.kind === 'owned'
      ? DshRuntimeOwnedObservationSchema.parse(row.payload)
      : DshRuntimeCloseObservationSchema.parse(row.payload);
  if (
    payload.kind !== row.kind ||
    payload.runtimeId !== row.runtimeId ||
    payload.workerBootId !== row.workerBootId ||
    nativeRootDigest(payload) !== row.payloadDigest ||
    nativeRootDigest(row.payload) !== row.payloadDigest ||
    (payload.kind === 'owned'
      ? row.ownerDigest !== row.payloadDigest
      : payload.ownerDigest !== row.ownerDigest)
  )
    fail('DSH_CLOSE_EVIDENCE_INVALID');
  return { ...row, payload };
}
async function readExact(db: Reader, row: Row) {
  const rows = await db<
    Row[]
  >`select runtime_id as "runtimeId",worker_boot_id as "workerBootId",
    observation_kind as kind,owner_digest as "ownerDigest",payload_digest as "payloadDigest",payload
    from allrice_dsh_runtime_close_observations where runtime_id=${row.runtimeId}
      and worker_boot_id=${row.workerBootId} and observation_kind=${row.kind}`;
  if (rows.length !== 1) fail('DSH_CLOSE_EVIDENCE_WRITE_UNCONFIRMED');
  const actual = validateRow(rows[0]);
  if (
    actual.ownerDigest !== row.ownerDigest ||
    actual.payloadDigest !== row.payloadDigest ||
    nativeRootDigest(actual.payload) !== nativeRootDigest(row.payload)
  )
    fail('DSH_CLOSE_EVIDENCE_CONFLICT');
  return actual;
}
async function insert(db: Reader, row: Row) {
  await db`insert into allrice_dsh_runtime_close_observations
    (runtime_id,worker_boot_id,observation_kind,owner_digest,payload_digest,payload)
    values (${row.runtimeId},${row.workerBootId},${row.kind},${row.ownerDigest},${row.payloadDigest},${db.json(row.payload as postgres.JSONValue)})
    on conflict (runtime_id,worker_boot_id,observation_kind) do nothing`;
}
/** Fixed key and bytes. Unknown commit permits a read only, not a new spawn,
 * another runtime UUID, another shutdown or an altered observation. */
async function writeAndRead(row: Row, write: () => Promise<unknown>) {
  try {
    await write();
  } catch (error) {
    // Definite policy rejection is never reinterpreted as a lost commit.
    if (
      error instanceof Error &&
      [
        'NATIVE_CONTEXT_EXECUTION_RETIRED',
        'DSH_CLOSE_CONTEXT_SCOPE_INVALID',
        'DSH_CLOSE_OWNER_ALREADY_OBSERVED',
      ].includes(error.message)
    )
      throw error;
    // A lost commit receipt can only be resolved below.
  }
  return getDatabase().begin('read only', async (tx) => {
    await tx`set local statement_timeout='5000'`;
    await tx`set local lock_timeout='1000'`;
    return readExact(tx, row);
  });
}

export async function reserveDshRuntimeOwner(
  raw: DshRuntimeOwnedObservation,
): Promise<OwnerReceipt> {
  const owner = DshRuntimeOwnedObservationSchema.parse(raw);
  const ownerDigest = nativeRootDigest(owner);
  const row: Row = {
    runtimeId: owner.runtimeId,
    workerBootId: owner.workerBootId,
    kind: 'owned',
    ownerDigest,
    payloadDigest: ownerDigest,
    payload: owner,
  };
  await writeAndRead(row, () =>
    getDatabase().begin(async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local lock_timeout='1000'`;
      if (
        owner.context.kind === 'context' &&
        owner.context.contextKind === 'chat'
      ) {
        const c = owner.context;
        // Identical identity -> Session order as the existing retirement writer.
        await tx`select id from allrice_organizations where id=${c.organizationId} for share`;
        await tx`select id from allrice_workspaces where organization_id=${c.organizationId} and id=${c.workspaceId} for share`;
        await tx`select id from allrice_users where id=${c.ownerId} for share`;
        const [session] =
          await tx`select id from allrice_chat_sessions where id=${c.contextId}
        and organization_id=${c.organizationId} and workspace_id=${c.workspaceId} and owner_id=${c.ownerId} for update`;
        if (!session) fail('DSH_CLOSE_CONTEXT_SCOPE_INVALID');
        const [retired] =
          await tx`select 1 from allrice_native_context_retirements
        where context_kind='chat' and context_id=${c.contextId}`;
        if (retired) fail('NATIVE_CONTEXT_EXECUTION_RETIRED');
      }
      const [used] =
        await tx`select 1 from allrice_dsh_runtime_close_observations
      where runtime_id=${owner.runtimeId} and worker_boot_id=${owner.workerBootId} and observation_kind<>'owned' limit 1`;
      if (used) fail('DSH_CLOSE_OWNER_ALREADY_OBSERVED');
      await insert(tx, row);
    }),
  );
  return { owner, ownerDigest };
}
export async function recordDshRuntimeCloseObservation(
  receipt: OwnerReceipt,
  raw: DshRuntimeCloseObservation,
) {
  const owner = DshRuntimeOwnedObservationSchema.parse(receipt.owner);
  if (receipt.ownerDigest !== nativeRootDigest(owner))
    fail('DSH_CLOSE_OWNER_INVALID');
  const observation = DshRuntimeCloseObservationSchema.parse(raw);
  if (
    observation.runtimeId !== owner.runtimeId ||
    observation.workerBootId !== owner.workerBootId ||
    observation.ownerDigest !== receipt.ownerDigest
  )
    fail('DSH_CLOSE_OWNER_CONFLICT');
  const row: Row = {
    runtimeId: owner.runtimeId,
    workerBootId: owner.workerBootId,
    kind: observation.kind,
    ownerDigest: receipt.ownerDigest,
    payloadDigest: nativeRootDigest(observation),
    payload: observation,
  };
  await writeAndRead(row, () =>
    getDatabase().begin(async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local lock_timeout='1000'`;
      await insert(tx, row);
    }),
  );
}

export function classifyDshRuntimeCloseObservations(
  rawRows: readonly unknown[],
) {
  const groups = new Map<string, ReturnType<typeof validateRow>[]>();
  for (const raw of rawRows) {
    const row = validateRow(raw),
      key = row.runtimeId + '/' + row.workerBootId;
    const group = groups.get(key) ?? [];
    if (group.some((prior) => prior.kind === row.kind))
      fail('DSH_CLOSE_EVIDENCE_DUPLICATE');
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((rows) => {
    const owned = rows.find((r) => r.payload.kind === 'owned');
    if (
      !owned ||
      owned.payload.kind !== 'owned' ||
      rows.some((r) => r.ownerDigest !== owned.payloadDigest)
    )
      return fail('DSH_CLOSE_OWNER_MISSING_OR_CONFLICT');
    const owner = owned.payload;
    const request = rows.find(
      (r) => r.payload.kind === 'close_request',
    )?.payload;
    const closed = rows.find(
      (r) => r.payload.kind === 'process_closed',
    )?.payload;
    if (
      closed?.kind === 'process_closed' &&
      closed.fact.source === 'never_spawned' &&
      rows.some((r) => r.kind === 'close_started' || r.kind === 'close_request')
    )
      fail('DSH_CLOSE_EVIDENCE_NEVER_SPAWNED_CONFLICT');
    const physical =
      closed?.kind !== 'process_closed'
        ? 'unknown'
        : closed.fact.source === 'never_spawned'
          ? 'never_spawned'
          : 'exited';
    const publicCloseConfirmed =
      physical === 'exited' &&
      rows.some((r) => r.kind === 'close_started') &&
      request?.kind === 'close_request' &&
      request.acknowledged &&
      request.wrapper?.version === 1 &&
      request.wrapper.sdkShutdown &&
      request.wrapper.rootDisposed &&
      request.wrapper.priorFramesFlushed &&
      closed?.kind === 'process_closed' &&
      closed.fact.source === 'child_close' &&
      closed.fact.exitCode === 0 &&
      closed.fact.signal === null &&
      closed.fact.terminationAttempted === null;
    return {
      owner,
      ownerDigest: owned.payloadDigest,
      physical,
      publicClose: publicCloseConfirmed
        ? 'confirmed'
        : physical === 'never_spawned'
          ? 'not_started'
          : 'unconfirmed',
      // An explicit derivation, not an invented final-flush ACK.
      finalResponseFlush: publicCloseConfirmed
        ? 'verified_wrapper_normal_exit'
        : 'unconfirmed',
      observations: rows.map((r) => ({
        kind: r.kind,
        payloadDigest: r.payloadDigest,
      })),
    } as const;
  });
}
export async function readDshRuntimeCloseCoverage(
  db: Reader = getDatabase(),
  filter: {
    outsideApprovedArtifacts?: readonly string[];
    context?: {
      contextKind: 'chat';
      contextId: string;
      organizationId: string;
      workspaceId: string;
      ownerId: string;
    };
    workerBootId?: string;
  } = {},
) {
  const outside =
    filter.outsideApprovedArtifacts?.map((id) => digest.parse(id)) ?? null;
  const context = filter.context ?? null;
  const bootId = filter.workerBootId ? uuid.parse(filter.workerBootId) : null;
  const rows = await db<Row[]>`with owners as (
    select runtime_id,worker_boot_id from allrice_dsh_runtime_close_observations
    where observation_kind='owned'
      and (${outside === null} or not (payload->>'artifactId'=any(${outside ?? []}::text[])))
      and (${bootId}::uuid is null or worker_boot_id=${bootId}::uuid)
      and (${context === null} or (
        payload->'context'->>'kind'='context'
        and payload->'context'->>'contextKind'=${context?.contextKind ?? null}
        and payload->'context'->>'contextId'=${context?.contextId ?? null}
        and payload->'context'->>'organizationId'=${context?.organizationId ?? null}
        and payload->'context'->>'workspaceId'=${context?.workspaceId ?? null}
        and payload->'context'->>'ownerId'=${context?.ownerId ?? null})))
    select o.runtime_id as "runtimeId",o.worker_boot_id as "workerBootId",
      o.observation_kind as kind,o.owner_digest as "ownerDigest",o.payload_digest as "payloadDigest",o.payload
    from allrice_dsh_runtime_close_observations o join owners using(runtime_id,worker_boot_id)
    order by o.runtime_id,o.worker_boot_id,o.observation_kind`;
  return classifyDshRuntimeCloseObservations(rows);
}

type RetiredScope = {
  contextKind: 'chat';
  contextId: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
};
export function assertDshCloseArtifactCoverage(
  coverage: ReturnType<typeof classifyDshRuntimeCloseObservations>,
  approvedArtifactIds: readonly string[],
  retiredScopes: readonly RetiredScope[],
) {
  const unresolved = coverage.filter((item) => {
    if (approvedArtifactIds.includes(item.owner.artifactId)) return false;
    if (item.publicClose === 'confirmed' || item.physical === 'never_spawned')
      return false;
    const c = item.owner.context;
    // Discarding a specifically authorized test's future execution preserves
    // the unconfirmed semantic receipt. It never turns unknown into exited.
    const discardedTest =
      item.physical === 'exited' &&
      c.kind === 'context' &&
      c.contextKind === 'chat' &&
      retiredScopes.some(
        (r) =>
          r.contextKind === c.contextKind &&
          r.contextId === c.contextId &&
          r.organizationId === c.organizationId &&
          r.workspaceId === c.workspaceId &&
          r.ownerId === c.ownerId,
      );
    return !discardedTest;
  });
  if (unresolved.length)
    fail(
      'DSH_NATIVE_ARTIFACT_CLOSE_UNCONFIRMED ' +
        JSON.stringify(
          unresolved.map((r) => ({
            runtimeId: r.owner.runtimeId,
            workerBootId: r.owner.workerBootId,
            artifactId: r.owner.artifactId,
            physical: r.physical,
            publicClose: r.publicClose,
          })),
        ),
    );
  return {
    observedRuntimes: coverage.length,
    uncoveredHistory: 'legacy_unknown_not_backfilled' as const,
  };
}
export function assertDshContextPhysicallyClosed(
  coverage: ReturnType<typeof classifyDshRuntimeCloseObservations>,
  scope: RetiredScope,
) {
  if (
    coverage.some(({ owner, physical }) => {
      const c = owner.context;
      return (
        c.kind === 'context' &&
        c.contextKind === scope.contextKind &&
        c.contextId === scope.contextId &&
        c.organizationId === scope.organizationId &&
        c.workspaceId === scope.workspaceId &&
        c.ownerId === scope.ownerId &&
        physical === 'unknown'
      );
    })
  )
    fail('NATIVE_RETIREMENT_CLOSE_OBSERVATION_UNCONFIRMED');
}
