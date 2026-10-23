import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { nativeRootDigest } from './native-identity-digest.ts';
import {
  NativeRootOriginSchema,
  type NativeRootOrigin,
} from './native-root-origin.ts';
import {
  ExecutorTransitionScopeSchema,
  ExecutorTransitionReceiptSchema,
  ExecutorTransitionRefSchema,
  executorTransitionRef,
  type ExecutorTransitionScope,
  type ExecutorTransitionRef,
  type ExecutorTransitionReceipt,
} from './native-executor-transition-contract.ts';
import { nativeOriginReaderForOrigin } from './native-origin-reader.ts';
import { readDshRuntimeCloseCoverage } from '../providers/dsh-runtime-close-observations.ts';

type Reader = Sql | TransactionSql;
const same = (a: unknown, b: unknown) =>
  nativeRootDigest(a) === nativeRootDigest(b);
function fail(code: string): never {
  throw Error(`EXECUTOR_TRANSITION_${code}`);
}
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pinSchema = z
  .object({
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
  })
  .strict();
function pinnedJson(pin: z.infer<typeof pinSchema>) {
  if (
    !isAbsolute(pin.path) ||
    normalize(pin.path) !== pin.path ||
    realpathSync(pin.path) !== pin.path
  )
    fail('PROOF_PATH');
  const before = lstatSync(pin.path);
  if (!before.isFile() || before.isSymbolicLink()) fail('PROOF_PATH');
  const bytes = readFileSync(pin.path),
    after = lstatSync(pin.path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== pin.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== pin.sha256
  )
    fail('PROOF_DRIFT');
  return JSON.parse(bytes.toString()) as unknown;
}
type TransitionRow = { receipt: unknown };
type FirstRunRow = { native_execution_binding: unknown };
function resolveTransitionChain(
  scope: ExecutorTransitionScope,
  origin: NativeRootOrigin | null,
  rows: readonly TransitionRow[],
  exact?: ExecutorTransitionRef,
): ExecutorTransitionReceipt | null {
  let prior: ExecutorTransitionReceipt | null = null,
    found: ExecutorTransitionReceipt | null = null;
  for (const row of rows) {
    const receipt = ExecutorTransitionReceiptSchema.parse(row.receipt);
    if (
      !origin ||
      origin.contextKind !== 'chat' ||
      !same(receipt.scope, scope) ||
      receipt.originDigest !== nativeRootDigest(origin) ||
      receipt.sequence !== (prior?.sequence ?? 0) + 1 ||
      receipt.previousDigest !== (prior?.digest ?? null) ||
      (prior &&
        (!same(receipt.from, prior.target) ||
          receipt.storageNamespace !== prior.storageNamespace))
    )
      fail('CHAIN_INVALID');
    if (exact?.requestId === receipt.requestId) {
      if (!same(exact, executorTransitionRef(receipt)))
        fail('REFERENCE_CONFLICT');
      found = receipt;
    }
    prior = receipt;
  }
  if (exact) {
    if (!found) fail('REFERENCE_MISSING');
    return found;
  }
  return prior;
}
/** Only committed database rows are authority. A fabricated prompt/Run JSON
 * cannot supply a receipt, and a valid row still does not register an artifact. */
export async function readChatExecutorTransition(
  tx: Reader,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
  },
  origin: NativeRootOrigin | null,
  exact?: ExecutorTransitionRef,
): Promise<ExecutorTransitionReceipt | null> {
  const scope = ExecutorTransitionScopeSchema.parse({
    contextKind: 'chat',
    contextId: input.sessionId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
  });
  const rows = await tx<
    { receipt: unknown }[]
  >`select receipt from allrice_native_chat_executor_transitions
    where context_id=${scope.contextId} order by sequence`;
  return resolveTransitionChain(scope, origin, rows, exact);
}
export async function readChatTransitionRef(
  tx: Reader,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
  },
  origin: NativeRootOrigin | null,
) {
  const receipt = await readChatExecutorTransition(tx, input, origin);
  return receipt ? executorTransitionRef(receipt) : undefined;
}
/** A historical pin remains the actual first-writer record. The immutable
 * receipt's baseline rows or an earlier transition's actual first Run prove it. */
export async function assertChatTransitionPin(
  tx: Reader,
  ref: ExecutorTransitionRef,
  pin: Record<string, unknown>,
) {
  const rows = await tx<
    { receipt: unknown }[]
  >`select receipt from allrice_native_chat_executor_transitions
    where context_id=${ref.scope.contextId} and sequence<=${ref.sequence} order by sequence`;
  return assertChatTransitionPinRows(
    ref,
    pin,
    rows,
    async () => {
      const [run] = await tx<
        FirstRunRow[]
      >`select native_execution_binding from allrice_employee_runs
        where run_id=${pin.first_run_id as string} and session_id=${ref.scope.contextId}
        and organization_id=${ref.scope.organizationId} and workspace_id=${ref.scope.workspaceId} and owner_id=${ref.scope.ownerId}`;
      return run;
    },
    async () => {
      const [job] =
        await tx`select 1 from allrice_jobs where id=${pin.first_job_id as string} and run_id=${pin.first_run_id as string}
        and organization_id=${ref.scope.organizationId} and workspace_id=${ref.scope.workspaceId} and owner_id=${ref.scope.ownerId}`;
      return !!job;
    },
  );
}
async function assertChatTransitionPinRows(
  ref: ExecutorTransitionRef,
  pin: Record<string, unknown>,
  rows: readonly TransitionRow[],
  loadRun: () => Promise<FirstRunRow | undefined>,
  loadJob: () => Promise<boolean>,
) {
  const baseline = rows.flatMap((r) => {
    const receipt = ExecutorTransitionReceiptSchema.parse(r.receipt);
    return (receipt.facts.bindings ?? []) as Record<string, unknown>[];
  });
  const pinId = pin.native_session_id;
  if (
    !pinId ||
    pin.context_kind !== 'chat' ||
    pin.context_id !== ref.scope.contextId ||
    pin.organization_id !== ref.scope.organizationId ||
    pin.workspace_id !== ref.scope.workspaceId ||
    pin.owner_id !== ref.scope.ownerId ||
    pin.storage_namespace !== ref.storageNamespace ||
    pin.storage_context_key !== ref.scope.contextId ||
    pin.root_origin_digest !== ref.originDigest
  )
    fail('PIN_SCOPE');
  // SQL jsonb encodes dates differently from the driver. The physical first-
  // writer identity fields below are exact, while bound_at is never changed.
  const keys = [
    'native_session_id',
    'organization_id',
    'workspace_id',
    'owner_id',
    'context_kind',
    'context_id',
    'storage_context_key',
    'storage_namespace',
    'artifact_id',
    'artifact_manifest_digest',
    'distribution_generation',
    'profile_id',
    'first_run_id',
    'first_job_id',
    'first_attempt',
    'binding_basis',
    'root_origin_digest',
    'origin_reader_approval_digest',
  ];
  const eq = (row: Record<string, unknown>) =>
    keys.every((k) => (row[k] ?? null) === (pin[k] ?? null));
  if (baseline.some(eq)) return;
  // A legitimate later content generation has a real immutable first Run.
  const run = await loadRun();
  const value = run?.native_execution_binding as
    | { schemaVersion?: number; transition?: unknown; execution?: unknown }
    | undefined;
  const r =
    value?.schemaVersion === 2
      ? ExecutorTransitionRefSchema.safeParse(value.transition)
      : null;
  if (
    !r?.success ||
    r.data.sequence > ref.sequence ||
    !same(r.data.scope, ref.scope) ||
    !rows.some((row) => same(executorTransitionRef(row.receipt), r.data)) ||
    !same(value?.execution, r.data.target) ||
    pin.artifact_id !== r.data.target.artifactId ||
    pin.artifact_manifest_digest !== pin.artifact_id ||
    pin.profile_id !== 'restricted' ||
    pin.distribution_generation !== r.data.target.generation
  )
    fail('PIN_UNPROVEN');
  const job = await loadJob();
  if (!job) fail('PIN_FIRST_JOB_MISSING');
}
const approvalSchema = z
  .object({
    kind: z.literal('reviewed-chat-executor-transition-v1'),
    requestId: z.uuid(),
    scope: ExecutorTransitionScopeSchema,
    expectedFactsDigest: digest,
    from: ExecutorTransitionReceiptSchema.shape.from,
    target: ExecutorTransitionReceiptSchema.shape.target,
    storageNamespace: z.string(),
    previousDigest: digest.nullable(),
    reviewedBy: z.string().min(1),
    reviewedAtMs: z.number().int(),
    expiresAtMs: z.number().int(),
    artifactProof: pinSchema,
    historyProof: pinSchema,
    closeProof: pinSchema,
  })
  .strict();
/** LOCAL OPERATOR ONLY. No default DB, HTTP/model tool, automatic scheduler or
 * env-derived target. Explicit review SHA is out-of-band authority; the pinned
 * evidence is independently created/reviewed, not manufactured by this function.
 * The Worker still independently measures/registers target before execution. */
export async function applyReviewedChatExecutorTransition(input: {
  db: Sql;
  approvalFile: z.infer<typeof pinSchema>;
}) {
  const approval = approvalSchema.parse(
    pinnedJson(pinSchema.parse(input.approvalFile)),
  );
  const evidence = [
    approval.artifactProof,
    approval.historyProof,
    approval.closeProof,
  ].map(pinnedJson) as Record<string, unknown>[];
  const [artifact, history, close] = evidence;
  if (
    artifact?.kind !== 'verified-native-artifact-v1' ||
    artifact.artifactId !== approval.target.artifactId ||
    artifact.manifestDigest !== approval.target.artifactId ||
    artifact.generation !== approval.target.generation ||
    artifact.profileId !== 'restricted' ||
    artifact.verified !== true ||
    !digest.safeParse(artifact.measurementDigest).success
  )
    fail('TARGET_PROOF');
  if (
    history?.kind !== 'full-native-chat-history-read-v1' ||
    !same(history.scope, approval.scope) ||
    history.targetArtifactId !== approval.target.artifactId ||
    history.storageNamespace !== approval.storageNamespace ||
    history.requestId !== approval.requestId ||
    history.expectedFactsDigest !== approval.expectedFactsDigest ||
    history.complete !== true ||
    history.missing !== 0 ||
    history.privateFactsVerified !== true ||
    !Array.isArray(history.nativeSessionIds) ||
    !history.nativeSessionIds.length
  )
    fail('HISTORY_PROOF');
  if (
    close?.kind !== 'reviewed-native-chat-offline-v1' ||
    !same(close.scope, approval.scope) ||
    close.requestId !== approval.requestId ||
    close.expectedFactsDigest !== approval.expectedFactsDigest ||
    close.webStoppedNormally !== true ||
    close.workerStoppedNormally !== true ||
    close.allOwnedProcessesAbsent !== true ||
    close.unconfirmedOwners !== 0 ||
    close.deploymentLockVerified !== true ||
    close.qaLockVerified !== true
  )
    fail('CLOSE_PROOF');
  try {
    return await input.db.begin(async (tx) => {
      await tx`select set_config('lock_timeout','1000',true),set_config('statement_timeout','10000',true)`;
      const s = approval.scope;
      await tx`select id from allrice_organizations where id=${s.organizationId} for share`;
      await tx`select id from allrice_workspaces where id=${s.workspaceId} and organization_id=${s.organizationId} for share`;
      await tx`select id from allrice_users where id=${s.ownerId} for share`;
      await tx`select id from allrice_memberships where organization_id=${s.organizationId} and user_id=${s.ownerId} and active and (workspace_id is null or workspace_id=${s.workspaceId}) for share`;
      const [chat] =
        await tx`select native_root_origin from allrice_chat_sessions where id=${s.contextId}
      and organization_id=${s.organizationId} and workspace_id=${s.workspaceId} and owner_id=${s.ownerId} and archived_at is null for update`;
      if (!chat) fail('SCOPE');
      await tx`select a.id from allrice_employee_assignments a join allrice_chat_sessions c on c.employee_assignment_id=a.id where c.id=${s.contextId} and a.active for share of a`;
      const origin = NativeRootOriginSchema.parse(chat.native_root_origin);
      if (
        origin.contextKind !== 'chat' ||
        origin.profileId !== 'restricted' ||
        origin.distributionGeneration !== approval.target.generation
      )
        fail('U2_REQUIRED');
      const current = await readChatExecutorTransition(
        tx,
        { ...s, sessionId: s.contextId },
        origin,
      );
      const [prior] =
        await tx`select receipt from allrice_native_chat_executor_transitions where request_id=${approval.requestId}`;
      if (prior) fail('ALREADY_APPLIED_READBACK_ONLY');
      const [f] = await tx<
        { facts: Record<string, unknown>; now: number }[]
      >`select allrice_native_chat_executor_facts(${s.contextId},null) facts,
      floor(extract(epoch from clock_timestamp())*1000)::float8 now`;
      if (
        !f ||
        f.now < approval.reviewedAtMs ||
        f.now > approval.expiresAtMs ||
        approval.expiresAtMs - approval.reviewedAtMs > 900000 ||
        approval.previousDigest !== (current?.digest ?? null) ||
        nativeRootDigest(f.facts) !== approval.expectedFactsDigest
      )
        fail('FACTS_OR_APPROVAL_CHANGED');
      const pins = f.facts.bindings as Record<string, unknown>[];
      if (
        !Array.isArray(pins) ||
        !pins.length ||
        pins.some(
          (p) =>
            p.storage_namespace !== approval.storageNamespace ||
            p.distribution_generation !== approval.target.generation ||
            p.organization_id !== s.organizationId ||
            p.workspace_id !== s.workspaceId ||
            p.owner_id !== s.ownerId ||
            p.context_kind !== 'chat' ||
            p.context_id !== s.contextId ||
            p.profile_id !== 'restricted' ||
            p.storage_context_key !== s.contextId ||
            p.root_origin_digest !== nativeRootDigest(origin) ||
            p.artifact_manifest_digest !== p.artifact_id ||
            p.binding_basis !== 'business_root_origin',
        ) ||
        !same(
          [...(history.nativeSessionIds as string[])].sort(),
          pins.map((p) => p.native_session_id).sort(),
        )
      )
        fail('HISTORY_SCOPE');
      const from = current?.target ?? {
        artifactId: pins[0]!.artifact_id,
        generation: origin.distributionGeneration,
        profileId: 'restricted',
      };
      if (
        !same(from, approval.from) ||
        (current && approval.storageNamespace !== current.storageNamespace)
      )
        fail('SOURCE_EXECUTOR');
      if (!current) {
        const reader = nativeOriginReaderForOrigin(origin, s);
        if (
          approval.from.artifactId !==
            (reader?.targetArtifactId ?? origin.artifactId) ||
          pins.some(
            (p) =>
              p.artifact_id !== approval.from.artifactId ||
              p.origin_reader_approval_digest !==
                (reader?.approvalDigest ?? null),
          )
        )
          fail('SOURCE_EXECUTOR');
      }
      if (current) {
        for (const pin of pins)
          await assertChatTransitionPin(
            tx,
            executorTransitionRef(current),
            pin,
          );
      }
      // C's real immutable observations must exist; absent schema/read failure
      // rejects. Old evidence cannot be promoted by an env flag or test fixture.
      const closed = await readDshRuntimeCloseCoverage(tx, { context: s });
      if (
        !closed.some((c) => c.publicClose === 'confirmed') ||
        closed.some(
          (c) =>
            c.publicClose !== 'confirmed' && c.physical !== 'never_spawned',
        )
      )
        fail('CLOSE_UNCONFIRMED');
      const proofBody = {
        schemaVersion: 1 as const,
        kind: 'chat-executor-transition' as const,
        requestId: approval.requestId,
        sequence: (current?.sequence ?? 0) + 1,
        previousDigest: approval.previousDigest,
        scope: s,
        originDigest: nativeRootDigest(origin),
        from: approval.from,
        target: approval.target,
        storageNamespace: approval.storageNamespace,
        factsDigest: nativeRootDigest(f.facts),
        facts: f.facts,
        approvalDigest: nativeRootDigest(approval),
        historyEvidenceDigest: nativeRootDigest(history),
        closeEvidenceDigest: nativeRootDigest(close),
        appliedAt: new Date(f.now).toISOString(),
      };
      const receipt = ExecutorTransitionReceiptSchema.parse({
        ...proofBody,
        digest: nativeRootDigest(proofBody),
      });
      await tx`insert into allrice_native_chat_executor_transitions(request_id,context_id,organization_id,workspace_id,owner_id,sequence,receipt,digest,approval)
      values(${receipt.requestId},${s.contextId},${s.organizationId},${s.workspaceId},${s.ownerId},${receipt.sequence},${tx.json(receipt as never)},${receipt.digest},${tx.json(approval as never)})`;
      return receipt;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('EXECUTOR_TRANSITION_')
    )
      throw error;
    throw new Error('EXECUTOR_TRANSITION_COMMIT_UNKNOWN_READBACK_ONLY', {
      cause: error,
    });
  }
}

/** Same read-only transaction as reference coverage. Not an authorization
 * bypass for archived/retired origins or a blanket artifact alias. */
export async function verifiedChatExecutorTransitions(tx: Reader) {
  // One full reference scan is already a read-only stable database snapshot.
  // Load each relation once; the exact same pure validators serve the one-chat
  // path and the batched scanner. No per-chat or per-pin round trips.
  const transitions = await tx<
    {
      id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      native_root_origin: unknown;
      receipt: unknown;
    }[]
  >`select c.id,c.organization_id,c.workspace_id,c.owner_id,c.native_root_origin,t.receipt
    from allrice_native_chat_executor_transitions t join allrice_chat_sessions c on c.id=t.context_id
    order by c.id,t.sequence`;
  if (!transitions.length) return [];
  const bindings = await tx<
    Record<string, unknown>[]
  >`select b.* from allrice_native_session_bindings b
    where b.context_kind='chat' and exists(select 1 from allrice_native_chat_executor_transitions t where t.context_id=b.context_id)`;
  const runs = await tx<
    {
      run_id: string;
      session_id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      native_execution_binding: unknown;
    }[]
  >`select er.run_id,er.session_id,er.organization_id,er.workspace_id,er.owner_id,er.native_execution_binding
    from allrice_employee_runs er where exists(select 1 from allrice_native_session_bindings b
      where b.first_run_id=er.run_id and b.context_kind='chat'
      and exists(select 1 from allrice_native_chat_executor_transitions t where t.context_id=b.context_id))`;
  const jobs = await tx<
    {
      id: string;
      run_id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
    }[]
  >`select j.id,j.run_id,j.organization_id,j.workspace_id,j.owner_id from allrice_jobs j
    where exists(select 1 from allrice_native_session_bindings b where b.first_job_id=j.id and b.context_kind='chat'
      and exists(select 1 from allrice_native_chat_executor_transitions t where t.context_id=b.context_id))`;
  const byChat = new Map<string, (typeof transitions)[number][]>();
  const pinsByChat = new Map<string, Record<string, unknown>[]>();
  for (const row of transitions) {
    const group = byChat.get(row.id) ?? [];
    group.push(row);
    byChat.set(row.id, group);
  }
  for (const pin of bindings) {
    const id = String(pin.context_id),
      group = pinsByChat.get(id) ?? [];
    group.push(pin);
    pinsByChat.set(id, group);
  }
  const runById = new Map(runs.map((row) => [row.run_id, row]));
  const jobById = new Map(jobs.map((row) => [row.id, row]));
  const result: ExecutorTransitionRef[] = [];
  for (const [id, rows] of byChat) {
    const c = rows[0]!,
      scope = ExecutorTransitionScopeSchema.parse({
        contextKind: 'chat',
        contextId: id,
        organizationId: c.organization_id,
        workspaceId: c.workspace_id,
        ownerId: c.owner_id,
      });
    const origin = NativeRootOriginSchema.parse(c.native_root_origin);
    const receipt = resolveTransitionChain(scope, origin, rows);
    if (!receipt) fail('REFERENCE_MISSING');
    const ref = executorTransitionRef(receipt);
    for (const pin of pinsByChat.get(id) ?? []) {
      await assertChatTransitionPinRows(
        ref,
        pin,
        rows,
        async () => {
          const run = runById.get(String(pin.first_run_id));
          return run &&
            run.session_id === scope.contextId &&
            run.organization_id === scope.organizationId &&
            run.workspace_id === scope.workspaceId &&
            run.owner_id === scope.ownerId
            ? run
            : undefined;
        },
        async () => {
          const job = jobById.get(String(pin.first_job_id));
          return (
            !!job &&
            job.run_id === pin.first_run_id &&
            job.organization_id === scope.organizationId &&
            job.workspace_id === scope.workspaceId &&
            job.owner_id === scope.ownerId
          );
        },
      );
    }
    result.push(ref);
  }
  return result;
}

/** Unknown commit outcome: this is the only permitted retry, and is read-only. */
export async function readAppliedChatExecutorTransition(input: {
  db: Reader;
  scope: ExecutorTransitionScope;
  requestId: string;
  approvalDigest: string;
}) {
  const scope = ExecutorTransitionScopeSchema.parse(input.scope);
  const [row] =
    await input.db`select t.receipt,c.native_root_origin from allrice_native_chat_executor_transitions t join allrice_chat_sessions c on c.id=t.context_id where t.request_id=${z.uuid().parse(input.requestId)} and t.context_id=${scope.contextId}`;
  if (!row) return null;
  const ref = executorTransitionRef(row.receipt);
  const receipt = await readChatExecutorTransition(
    input.db,
    { ...scope, sessionId: scope.contextId },
    NativeRootOriginSchema.parse(row.native_root_origin),
    ref,
  );
  if (!receipt || receipt.approvalDigest !== digest.parse(input.approvalDigest))
    fail('READBACK_CONFLICT');
  return receipt;
}
