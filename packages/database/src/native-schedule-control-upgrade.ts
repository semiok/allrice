import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { nativeControlCloudEvidenceDigest } from './native-control-cloud-evidence.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
} from './native-schedule-once-state.ts';
import {
  nativeOnceWorkspaceDigest,
  validateNativeOnceWorkspaceSnapshot,
  type NativeOnceWorkspaceSnapshot,
} from './native-schedule-workspace-state.ts';

/** Local operator DB ports only. Never wired to HTTP, a model tool, a scheduler,
 * or a default database. The source operator independently verifies OS exits,
 * both locks, approved artifact bytes/public decoders and original JSONL reads.
 * This module consumes those explicitly reviewed facts; it cannot prove them. */
export const NATIVE_CONTROL_UPGRADE_GENERATION = 'dsh-0.2.1-rc.2-687f282';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(512);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => isAbsolute(v) && resolve(v) === v);
const referenceSchema = z
  .object({
    artifactId: digest,
    profileId: z.enum([
      'allrice-once-control-v1',
      'allrice-recurring-control-v1',
    ]),
    storageId: id,
    stateRoot: path,
  })
  .strict();
const artifactEvidenceSchema = z
  .object({
    kind: z.literal('reviewed-native-control-compatibility-v1'),
    generation: z.literal(NATIVE_CONTROL_UPGRADE_GENERATION),
    beforeReference: referenceSchema,
    afterReference: referenceSchema,
    artifactVerificationDigest: digest,
    publicHistoryVerificationDigest: digest,
  })
  .strict();
export type NativeControlArtifactCompatibilityEvidence = z.infer<
  typeof artifactEvidenceSchema
>;
const journalPinSchema = z
  .object({
    writeId: id,
    rowPin: digest,
    reference: referenceSchema,
    afterDigest: digest,
  })
  .strict();
const rowSetPin = z.object({ count: time, pin: digest }).strict();
const factsSchema = z
  .object({
    reference: referenceSchema,
    partitionPin: digest,
    partitionInvariantPin: digest,
    closeFence: z
      .object({
        closed: z.literal(true),
        epoch: time.refine((v) => v > 0),
        ownerId: id,
        tokenDigest: digest,
        proofId: id,
        auditPin: digest,
        valid: z.literal(true),
      })
      .strict(),
    workspaceSnapshotPin: digest.nullable(),
    latestWorkspaceJournal: journalPinSchema.nullable(),
    protected: z
      .object({
        allrice_native_once_controls: rowSetPin,
        allrice_native_once_occurrences: rowSetPin,
        allrice_native_once_journal: rowSetPin,
        allrice_native_recurring_controls: rowSetPin,
        allrice_native_recurring_occurrences: rowSetPin,
        allrice_native_recurring_journal: rowSetPin,
        allrice_native_recurring_versions: rowSetPin,
        allrice_native_recurring_operations: rowSetPin,
        allrice_automations: rowSetPin,
        allrice_automation_runs: rowSetPin,
      })
      .strict(),
    previousSequence: time,
  })
  .strict();
const planSchema = z
  .object({
    kind: z.literal('native-schedule-control-upgrade-plan-v1'),
    planId: z.uuid(),
    partitionId: id,
    beforeReference: referenceSchema,
    afterReference: referenceSchema,
    generation: z.literal(NATIVE_CONTROL_UPGRADE_GENERATION),
    artifactEvidence: artifactEvidenceSchema,
    artifactEvidenceDigest: digest,
    createdAtMs: time,
    expiresAtMs: time,
    facts: factsSchema,
    workspaceDigest: digest.nullable(),
    historicalCloudAbsenceDigest: digest.optional(),
  })
  .strict();
export type NativeScheduleControlUpgradePlan = z.infer<typeof planSchema>;
const lockSchema = z
  .object({
    path,
    ownerPid: time.refine((v) => v > 0),
    ownerBirth: id,
    tokenDigest: digest,
    acquiredAtMs: time,
    ownershipEvidenceDigest: digest,
  })
  .strict();
const processSchema = z
  .object({
    role: z.enum(['web', 'worker']),
    pid: time.refine((v) => v > 0),
    birth: id,
    stopMode: z.literal('normal'),
    stopRequestedAtMs: time,
    exitConfirmedAtMs: time,
    exitEvidenceDigest: digest,
  })
  .strict();
const offlineSchema = z
  .object({
    kind: z.literal('offlineStopped'),
    environment: z.literal('dev'),
    planId: z.uuid(),
    planDigest: digest,
    observedAtMs: time,
    expiresAtMs: time,
    locks: z.array(lockSchema).length(2),
    processes: z.array(processSchema).length(2),
    operatorEvidenceDigest: digest,
  })
  .strict();
export type NativeControlOfflineStoppedAttestation = z.infer<
  typeof offlineSchema
>;
const approvalSchema = z
  .object({
    kind: z.literal('native-control-upgrade-approval-v1'),
    approved: z.literal(true),
    reviewedBy: id,
    reviewedAtMs: time,
    reviewPolicyDigest: digest,
    planId: z.uuid(),
    planDigest: digest,
    artifactEvidenceDigest: digest,
    attestationDigest: digest,
  })
  .strict();
export type NativeControlUpgradeApproval = z.infer<typeof approvalSchema>;
export class NativeScheduleControlUpgradeError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(
      `native_control_upgrade_${code}`,
      cause === undefined ? undefined : { cause },
    );
  }
}
function reject(code: string): never {
  throw new NativeScheduleControlUpgradeError(code);
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) reject('invalid_input');
  return parsed.data;
}
function json(tx: TransactionSql, value: unknown) {
  nativeOnceDigest(value);
  return tx.json(JSON.parse(JSON.stringify(value)));
}
async function bounded<T>(
  db: Sql,
  work: (tx: TransactionSql) => Promise<T>,
  readonly = false,
): Promise<T> {
  return db.begin(
    readonly ? 'isolation level repeatable read read only' : '',
    async (tx) => {
      await tx`select set_config('lock_timeout','1000',true),set_config('statement_timeout','10000',true),
      set_config('idle_in_transaction_session_timeout','10000',true),set_config('TimeZone','UTC',true)`;
      return work(tx);
    },
  ) as Promise<T>;
}
async function now(tx: TransactionSql) {
  const [r] = await tx<
    { now_ms: number }[]
  >`select floor(extract(epoch from clock_timestamp())*1000)::float8 now_ms`;
  return r!.now_ms;
}
async function idle(
  tx: TransactionSql,
  plan: Record<string, unknown>,
  offline?: NativeControlOfflineStoppedAttestation,
) {
  const [r] = await tx<
    { counts: Record<string, number> }[]
  >`select allrice_native_control_upgrade_idle_for(${json(tx, plan)},${offline === undefined ? null : json(tx, offline)}) counts`;
  if (!r || Object.values(r.counts).some((v) => v !== 0)) reject('not_idle');
}
function compatible(
  before: NativeOnceReference,
  after: NativeOnceReference,
  evidence: NativeControlArtifactCompatibilityEvidence,
) {
  if (
    before.artifactId === after.artifactId ||
    !isDeepStrictEqual({ ...before, artifactId: after.artifactId }, after) ||
    !isDeepStrictEqual(evidence.beforeReference, before) ||
    !isDeepStrictEqual(evidence.afterReference, after)
  )
    reject('reference_scope_changed');
}
function validatePlan(value: unknown, expectedDigest: string) {
  const plan = parse(planSchema, value);
  if (
    nativeOnceDigest(plan) !== expectedDigest ||
    plan.artifactEvidenceDigest !== nativeOnceDigest(plan.artifactEvidence) ||
    !isDeepStrictEqual(plan.facts.reference, plan.beforeReference) ||
    plan.expiresAtMs <= plan.createdAtMs ||
    plan.expiresAtMs - plan.createdAtMs > 900_000
  )
    reject('plan_digest_conflict');
  compatible(plan.beforeReference, plan.afterReference, plan.artifactEvidence);
  return plan;
}

/** Exact exception for workspaceSnapshot only. The SQL function validates the
 * newest continuous immutable ledger chain and actual current journal-row pin.
 * All old live-writer/COMMIT/reference checks remain unchanged. */
export async function nativeControlWorkspaceUpgradeAllowed(
  tx: TransactionSql,
  input: {
    partitionId: string;
    reference: NativeOnceReference;
    workspaceDigest: string;
    latestWriteId: unknown;
  },
): Promise<boolean> {
  if (
    !referenceSchema.safeParse(input.reference).success ||
    typeof input.latestWriteId !== 'string'
  )
    return false;
  const [r] = await tx<
    { allowed: boolean }[]
  >`select allrice_native_control_upgrade_workspace_allowed(
    ${input.partitionId},${json(tx, input.reference)},${input.workspaceDigest},${input.latestWriteId}) allowed`;
  return r?.allowed === true;
}

/** Prepare AFTER normal service exit and audited Host/backend close. An active
 * lease is never frozen as a usable plan; neither TTL expiry nor a caller's
 * closed=true claim can replace the partition's exact immutable close audit. */
export async function prepareNativeScheduleControlUpgrade(input: {
  db: Sql;
  requestId: string;
  partitionId: string;
  beforeReference: NativeOnceReference;
  afterReference: NativeOnceReference;
  artifactEvidence: NativeControlArtifactCompatibilityEvidence;
  ttlMs?: number;
  historicalCloudAbsenceCredential?: Record<string, unknown>;
}) {
  const { db, ...rawRequest } = input;
  const request = parse(
    z
      .object({
        requestId: z.uuid(),
        partitionId: id,
        beforeReference: referenceSchema,
        afterReference: referenceSchema,
        artifactEvidence: artifactEvidenceSchema,
        ttlMs: z.number().int().min(1).max(900_000),
        historicalCloudAbsenceCredential: z
          .record(z.string(), z.unknown())
          .optional(),
      })
      .strict(),
    { ...rawRequest, ttlMs: input.ttlMs ?? 600_000 },
  );
  // The DB connection is never serialized or included in a digest.
  compatible(
    request.beforeReference,
    request.afterReference,
    request.artifactEvidence,
  );
  return bounded(db, async (tx) => {
    const [p] = await tx<
      {
        reference: NativeOnceReference;
        workspace_snapshot: NativeOnceWorkspaceSnapshot | null;
      }[]
    >`
      select reference,workspace_snapshot from allrice_native_once_partitions where partition_id=${request.partitionId} for update`;
    if (!p || !isDeepStrictEqual(p.reference, request.beforeReference))
      reject('reference_changed');
    const [existing] =
      await tx`select plan_id from allrice_native_control_upgrade_plans where plan_id=${request.requestId}`;
    if (existing) reject('plan_exists_readback_only');
    const [r] = await tx<
      { facts: unknown }[]
    >`select allrice_native_control_upgrade_facts(${request.partitionId}) facts`;
    const facts = parse(factsSchema, r?.facts);
    const cloudCredential = request.historicalCloudAbsenceCredential;
    const historicalCloudAbsenceDigest =
      cloudCredential === undefined
        ? undefined
        : nativeControlCloudEvidenceDigest(cloudCredential);
    if (cloudCredential !== undefined) {
      // Same transaction as the original plan; the deferred FK prevents an
      // orphan credential. The local source operator independently probes OS.
      // The complete credential was validated above with its own bounded
      // digest. Ordinary plan/reference/approval JSON keeps the 64 KiB guard.
      await tx`insert into allrice_native_control_cloud_absences
        (plan_id,partition_id,credential_digest,before_reference,after_reference,credential)
        values(${request.requestId},${request.partitionId},${historicalCloudAbsenceDigest!},
          ${json(tx, request.beforeReference)},${json(tx, request.afterReference)},${tx.json(JSON.parse(JSON.stringify(cloudCredential)))})`;
    }
    await idle(tx, {
      planId: request.requestId,
      partitionId: request.partitionId,
      beforeReference: request.beforeReference,
      afterReference: request.afterReference,
      facts,
      ...(historicalCloudAbsenceDigest === undefined
        ? {}
        : { historicalCloudAbsenceDigest }),
    });
    let workspaceDigest: string | null = null;
    if (p.workspace_snapshot === null) {
      if (facts.latestWorkspaceJournal !== null)
        reject('workspace_snapshot_conflict');
    } else {
      const sessions = await tx<{ control_session_id: string }[]>`
        select control_session_id from allrice_native_once_controls where partition_id=${request.partitionId}
        union select control_session_id from allrice_native_recurring_controls where partition_id=${request.partitionId}`;
      validateNativeOnceWorkspaceSnapshot(p.workspace_snapshot, {
        stateRoot: p.reference.stateRoot,
        controlSessionIds: new Set(sessions.map((v) => v.control_session_id)),
      });
      workspaceDigest = nativeOnceWorkspaceDigest(p.workspace_snapshot);
      const latest = facts.latestWorkspaceJournal;
      const [journal] = await tx<
        { after_snapshot: unknown }[]
      >`select after_snapshot from allrice_native_once_journal
        where partition_id=${request.partitionId} and entry_kind='workspace'
        order by (after_snapshot->>'revision')::bigint desc limit 1`;
      if (
        !latest ||
        latest.afterDigest !== workspaceDigest ||
        !isDeepStrictEqual(journal?.after_snapshot, p.workspace_snapshot) ||
        (!isDeepStrictEqual(latest.reference, p.reference) &&
          !(await nativeControlWorkspaceUpgradeAllowed(tx, {
            partitionId: request.partitionId,
            reference: p.reference,
            workspaceDigest,
            latestWriteId: latest.writeId,
          })))
      )
        reject('workspace_snapshot_conflict');
    }
    const createdAtMs = await now(tx);
    const plan: NativeScheduleControlUpgradePlan = {
      kind: 'native-schedule-control-upgrade-plan-v1',
      planId: request.requestId,
      partitionId: request.partitionId,
      beforeReference: request.beforeReference,
      afterReference: request.afterReference,
      generation: NATIVE_CONTROL_UPGRADE_GENERATION,
      artifactEvidence: request.artifactEvidence,
      artifactEvidenceDigest: nativeOnceDigest(request.artifactEvidence),
      createdAtMs,
      expiresAtMs: createdAtMs + request.ttlMs,
      facts,
      workspaceDigest,
      ...(historicalCloudAbsenceDigest === undefined
        ? {}
        : { historicalCloudAbsenceDigest }),
    };
    const planDigest = nativeOnceDigest(plan);
    await tx`insert into allrice_native_control_upgrade_plans(plan_id,partition_id,plan_digest,plan)
      values(${plan.planId},${plan.partitionId},${planDigest},${json(tx, plan)})`;
    return { plan, planDigest };
  });
}

function authorization(
  plan: NativeScheduleControlUpgradePlan,
  planDigest: string,
  rawApproval: unknown,
  rawOffline: unknown,
  at: number,
) {
  const approval = parse(approvalSchema, rawApproval),
    offline = parse(offlineSchema, rawOffline);
  const attestationDigest = nativeOnceDigest(offline);
  if (
    approval.planId !== plan.planId ||
    approval.planDigest !== planDigest ||
    offline.planId !== plan.planId ||
    offline.planDigest !== planDigest ||
    approval.attestationDigest !== attestationDigest ||
    approval.artifactEvidenceDigest !== plan.artifactEvidenceDigest
  )
    reject('approval_conflict');
  if (
    at >= plan.expiresAtMs ||
    approval.reviewedAtMs < plan.createdAtMs ||
    approval.reviewedAtMs > at ||
    offline.observedAtMs < plan.createdAtMs ||
    offline.observedAtMs > approval.reviewedAtMs ||
    offline.expiresAtMs <= at ||
    offline.expiresAtMs >
      Math.min(plan.expiresAtMs, offline.observedAtMs + 120_000)
  )
    reject('approval_expired');
  const [a, b] = offline.locks;
  if (
    !a ||
    !b ||
    a.path === b.path ||
    a.ownerPid !== b.ownerPid ||
    a.ownerBirth !== b.ownerBirth ||
    offline.locks.some((v) => v.acquiredAtMs > plan.createdAtMs) ||
    new Set(offline.processes.map((v) => v.role)).size !== 2 ||
    new Set(offline.processes.map((v) => v.pid)).size !== 2 ||
    offline.processes.some(
      (v) =>
        v.stopRequestedAtMs > v.exitConfirmedAtMs ||
        v.exitConfirmedAtMs > plan.createdAtMs,
    )
  )
    reject('offline_stop_conflict');
  return {
    approval,
    offline,
    attestationDigest,
    approvalDigest: nativeOnceDigest(approval),
  };
}

/** No retries, including a lost COMMIT acknowledgement. After any uncertain
 * result use readNativeScheduleControlUpgrade with these exact three digests. */
export async function applyNativeScheduleControlUpgrade(input: {
  db: Sql;
  planId: string;
  planDigest: string;
  approval: NativeControlUpgradeApproval;
  offlineStoppedAttestation: NativeControlOfflineStoppedAttestation;
}) {
  const planId = parse(z.uuid(), input.planId),
    planDigest = parse(digest, input.planDigest);
  const approval = parse(approvalSchema, input.approval),
    offline = parse(offlineSchema, input.offlineStoppedAttestation);
  try {
    return await bounded(input.db, async (tx) => {
      const [r] = await tx<
        { plan: unknown; plan_digest: string }[]
      >`select plan,plan_digest from allrice_native_control_upgrade_plans where plan_id=${planId}`;
      if (!r || r.plan_digest !== planDigest)
        reject('plan_not_found_or_conflict');
      const plan = validatePlan(r.plan, planDigest);
      const [p] =
        await tx`select partition_id from allrice_native_once_partitions where partition_id=${plan.partitionId} for update`;
      if (!p) reject('partition_missing');
      const [prior] =
        await tx`select plan_id from allrice_native_control_upgrades where plan_id=${planId}`;
      if (prior) reject('already_applied_readback_only');
      const auth = authorization(
        plan,
        planDigest,
        approval,
        offline,
        await now(tx),
      );
      await idle(tx, plan, offline);
      const [current] = await tx<
        { facts: unknown }[]
      >`select allrice_native_control_upgrade_facts(${plan.partitionId}) facts`;
      if (!isDeepStrictEqual(current?.facts, plan.facts))
        reject('snapshot_changed');
      const [ledger] = await tx<
        { sequence: string }[]
      >`insert into allrice_native_control_upgrades
        (plan_id,partition_id,plan_digest,before_reference,after_reference,workspace_digest,latest_journal_pin,
         previous_sequence,approval,approval_digest,offline_attestation,attestation_digest)
        values(${planId},${plan.partitionId},${planDigest},${json(tx, plan.beforeReference)},${json(tx, plan.afterReference)},
          ${plan.workspaceDigest},${plan.facts.latestWorkspaceJournal === null ? null : json(tx, plan.facts.latestWorkspaceJournal)},
          ${plan.facts.previousSequence},${json(tx, auth.approval)},${auth.approvalDigest},${json(tx, auth.offline)},${auth.attestationDigest})
        returning sequence::text`;
      const changed =
        await tx`update allrice_native_once_partitions set reference=${json(tx, plan.afterReference)}
        where partition_id=${plan.partitionId} and reference=${json(tx, plan.beforeReference)} and closed
          and allrice_native_control_json_pin(to_jsonb(allrice_native_once_partitions))=${plan.facts.partitionPin}
        returning partition_id`;
      if (changed.length !== 1) reject('reference_cas_lost');
      // Deferred SQL fence rechecks expiry, idle and every protected pin at COMMIT.
      return {
        planId,
        planDigest,
        approvalDigest: auth.approvalDigest,
        attestationDigest: auth.attestationDigest,
        sequence: ledger!.sequence,
        beforeReference: plan.beforeReference,
        afterReference: plan.afterReference,
      };
    });
  } catch (error) {
    if (error instanceof NativeScheduleControlUpgradeError) throw error;
    // Do not infer absence/rollback from a transport error or repeat this write.
    throw new NativeScheduleControlUpgradeError(
      'commit_unknown_readback_only',
      error,
    );
  }
}

/** Without expected digests this only recovers the durable prepared document;
 * it makes no applied claim. Exact receipt readback remains valid after a later
 * legitimate acquire/workspace commit or a subsequent independently approved
 * upgrade. Historical applied status grants no writer/admission permission. */
export async function readNativeScheduleControlUpgrade(input: {
  db: Sql;
  planId: string;
  expected?: {
    planDigest: string;
    approvalDigest: string;
    attestationDigest: string;
  };
}) {
  const planId = parse(z.uuid(), input.planId);
  const expected =
    input.expected === undefined
      ? undefined
      : parse(
          z
            .object({
              planDigest: digest,
              approvalDigest: digest,
              attestationDigest: digest,
            })
            .strict(),
          input.expected,
        );
  return bounded(
    input.db,
    async (tx) => {
      const [r] = await tx<
        { plan: unknown; plan_digest: string }[]
      >`select plan,plan_digest from allrice_native_control_upgrade_plans where plan_id=${planId}`;
      if (!r) return { status: 'not_found' as const };
      const plan = validatePlan(r.plan, r.plan_digest);
      if (plan.historicalCloudAbsenceDigest !== undefined) {
        const [credential] = await tx<
          { credential_digest: string; credential: unknown }[]
        >`
          select credential_digest,credential from allrice_native_control_cloud_absences
          where plan_id=${planId} and partition_id=${plan.partitionId}`;
        if (
          !credential ||
          credential.credential_digest !== plan.historicalCloudAbsenceDigest ||
          nativeControlCloudEvidenceDigest(credential.credential) !==
            plan.historicalCloudAbsenceDigest
        )
          reject('cloud_absence_readback_conflict');
      }
      if (expected && expected.planDigest !== r.plan_digest)
        reject('readback_conflict');
      if (!expected)
        return {
          status: 'plan_only' as const,
          plan,
          planDigest: r.plan_digest,
        };
      const [u] = await tx<
        {
          sequence: string;
          plan_digest: string;
          approval_digest: string;
          attestation_digest: string;
          approval: unknown;
          offline_attestation: unknown;
          before_reference: unknown;
          after_reference: unknown;
          workspace_digest: string | null;
          latest_journal_pin: unknown;
          previous_sequence: string;
        }[]
      >`
      select *,sequence::text,previous_sequence::text from allrice_native_control_upgrades where plan_id=${planId}`;
      if (!u)
        return {
          status: 'not_applied' as const,
          plan,
          planDigest: r.plan_digest,
        };
      if (
        u.plan_digest !== expected.planDigest ||
        u.approval_digest !== expected.approvalDigest ||
        u.attestation_digest !== expected.attestationDigest ||
        nativeOnceDigest(parse(approvalSchema, u.approval)) !==
          u.approval_digest ||
        nativeOnceDigest(parse(offlineSchema, u.offline_attestation)) !==
          u.attestation_digest ||
        !isDeepStrictEqual(u.before_reference, plan.beforeReference) ||
        !isDeepStrictEqual(u.after_reference, plan.afterReference) ||
        u.workspace_digest !== plan.workspaceDigest ||
        !isDeepStrictEqual(
          u.latest_journal_pin,
          plan.facts.latestWorkspaceJournal,
        ) ||
        Number(u.previous_sequence) !== plan.facts.previousSequence
      )
        reject('readback_conflict');
      return {
        status: 'applied' as const,
        plan,
        planDigest: r.plan_digest,
        sequence: u.sequence,
        approvalDigest: u.approval_digest,
        attestationDigest: u.attestation_digest,
        beforeReference: plan.beforeReference,
        afterReference: plan.afterReference,
      };
    },
    true,
  );
}
