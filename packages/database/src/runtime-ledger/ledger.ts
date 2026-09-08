import { createHash, randomUUID } from 'node:crypto';

import {
  BridgeCapabilities,
  RuntimeBridgePayloadSchema,
  RuntimeAttemptRefSchema,
  RuntimeOperationEventSchema,
  RuntimeOperationSignalSchema,
  RuntimeOperationSnapshotSchema,
  RuntimeScopeSchema,
  RuntimeTaskRefSchema,
  RuntimeUsageObservationSchema,
  RuntimeLocalServiceEventSchema,
  RuntimeLocalCommandResultSchema,
  UuidSchema,
  advanceRuntimeOperation,
  isTerminalRuntimeOperationStatus,
  matchesRuntimeScope,
  runtimeContractEqual,
  type RuntimeAttemptRef,
  type RuntimeOperationEvent,
  type RuntimeOperationSignal,
  type RuntimeOperationSnapshot,
  type RuntimeScope,
  type RuntimeTaskRef,
  type RuntimeUsageObservation,
  type RuntimeLocalServiceEvent,
  type RuntimeActionBinding,
} from '@allrice/contracts';
import { z } from 'zod';

import { getDatabase } from '../core/client.ts';
import {
  RuntimeLedgerError,
  type CreateRuntimeOperationInput,
  type RegisterRuntimeRootInput,
  type RuntimeBudgetLimit,
  type RuntimeLedgerAdmission,
  type RuntimeLedgerLease,
  type RuntimeLedgerReceipt,
  type RuntimeLedgerTransaction,
} from './types.ts';
import { exchangeLocalServiceLocked } from '../local-service-runtime.ts';

type Tx = RuntimeLedgerTransaction;
type Json = Parameters<Tx['json']>[0];
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)) as Json);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Exact JSON payload digest, matching P04's codepoint-sorted canonical JSON. */
export function runtimeLedgerInputDigest(value: unknown): string {
  const canonical = (part: unknown): string => {
    if (part === null || typeof part === 'string' || typeof part === 'boolean')
      return JSON.stringify(part);
    if (typeof part === 'number' && Number.isFinite(part))
      return JSON.stringify(part);
    if (Array.isArray(part))
      return `[${Array.from(part, canonical).join(',')}]`;
    if (
      typeof part === 'object' &&
      Object.getPrototypeOf(part) === Object.prototype
    )
      return `{${Object.keys(part)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((part as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    throw new RuntimeLedgerError('invalid_state');
  };
  return `sha256:${hash(canonical(value))}`;
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const leaseDuration = z.number().int().min(1_000).max(300_000);
const maxPayloadBytes = 512_000;

interface RootRow {
  root_run_id: string;
  organization_id: string;
  workspace_id: string;
  task: RuntimeTaskRef;
  deadline_at: Date;
  cancel_request_id: string | null;
  cancel_reason: string | null;
}
interface OperationRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  root_run_id: string;
  snapshot: RuntimeOperationSnapshot;
  initial_snapshot: RuntimeOperationSnapshot;
  next_sequence: string;
  bridge_payload: unknown | null;
  lease_owner: string | null;
  lease_token_hash: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
}
interface BudgetRow {
  metric: RuntimeUsageObservation['metric'];
  unit: RuntimeUsageObservation['unit'];
  currency: string | null;
  capacity: string;
  reserved: string;
  spent: string;
  source: RuntimeUsageObservation['source'];
}

function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxPayloadBytes)
    throw new RuntimeLedgerError('invalid_state');
}

async function now(tx: Tx): Promise<Date> {
  const [row] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  return row!.now;
}

async function lockRoot(tx: Tx, scopeInput: RuntimeScope, rootRunId: string) {
  const scope = RuntimeScopeSchema.parse(scopeInput);
  UuidSchema.parse(rootRunId);
  const [root] = await tx<RootRow[]>`
    select * from allrice_runtime_roots
    where root_run_id = ${rootRunId}
      and organization_id = ${scope.organizationId}
      and workspace_id = ${scope.workspaceId}
    for update
  `;
  if (!root || !matchesRuntimeScope(root.task.scope, scope))
    throw new RuntimeLedgerError('scope_mismatch');
  return root;
}

async function lockOperation(tx: Tx, scope: RuntimeScope, operationId: string) {
  RuntimeScopeSchema.parse(scope);
  UuidSchema.parse(operationId);
  // Discovery is not a lock: all mutations lock root before operation.
  const [reference] = await tx<{ root_run_id: string }[]>`
    select root_run_id from allrice_runtime_operations
    where id = ${operationId} and organization_id = ${scope.organizationId}
      and workspace_id = ${scope.workspaceId}
  `;
  if (!reference) throw new RuntimeLedgerError('scope_mismatch');
  const root = await lockRoot(tx, scope, reference.root_run_id);
  const [row] = await tx<OperationRow[]>`
    select * from allrice_runtime_operations where id = ${operationId} for update
  `;
  if (!row || !matchesRuntimeScope(row.snapshot.binding.task.scope, scope))
    throw new RuntimeLedgerError('scope_mismatch');
  row.snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot);
  return { root, row };
}

function ensureRootAdmits(root: RootRow, at: Date) {
  if (root.cancel_request_id) throw new RuntimeLedgerError('root_canceled');
  if (root.deadline_at <= at) throw new RuntimeLedgerError('deadline_exceeded');
}

async function assertRun(tx: Tx, task: RuntimeTaskRef, active: boolean) {
  const [run] = await tx<{ state: string }[]>`
    select state from allrice_runs where id = ${task.runId}
      and organization_id = ${task.scope.organizationId}
      and workspace_id = ${task.scope.workspaceId} for share
  `;
  if (!run) throw new RuntimeLedgerError('scope_mismatch');
  if (active && !['queued', 'running', 'waiting_approval'].includes(run.state))
    throw new RuntimeLedgerError('unavailable');
}

async function assertTarget(tx: Tx, snapshot: RuntimeOperationSnapshot) {
  const { task, execution } = snapshot.binding;
  const [target] = await tx<{ kind: string; state: string }[]>`
    select kind, state from allrice_execution_targets
    where id = ${execution.targetId}
      and organization_id = ${task.scope.organizationId}
      and workspace_id = ${task.scope.workspaceId} for share
  `;
  if (!target || target.kind !== execution.targetKind)
    throw new RuntimeLedgerError('scope_mismatch');
  if (target.state !== 'online') throw new RuntimeLedgerError('unavailable');
}

async function linkRun(tx: Tx, task: RuntimeTaskRef) {
  const [previous] = await tx<{ task: RuntimeTaskRef }[]>`
    select task from allrice_runtime_run_links where run_id = ${task.runId}
  `;
  if (previous) {
    if (!runtimeContractEqual(task, previous.task))
      throw new RuntimeLedgerError('scope_mismatch');
    return;
  }
  if (task.parentRunId) {
    const [parent] = await tx<{ root_run_id: string; task: RuntimeTaskRef }[]>`
      select root_run_id, task from allrice_runtime_run_links
      where run_id = ${task.parentRunId}
    `;
    if (
      !parent ||
      parent.root_run_id !== task.rootRunId ||
      !matchesRuntimeScope(parent.task.scope, task.scope)
    )
      throw new RuntimeLedgerError('scope_mismatch');
  }
  await tx`
    insert into allrice_runtime_run_links
      (run_id, root_run_id, parent_run_id, organization_id, workspace_id, task)
    values (${task.runId}, ${task.rootRunId}, ${task.parentRunId},
      ${task.scope.organizationId}, ${task.scope.workspaceId}, ${json(tx, task)})
  `;
}

async function append(
  tx: Tx,
  row: OperationRow,
  signal: RuntimeOperationSignal,
) {
  const snapshot = advanceRuntimeOperation(row.snapshot, signal);
  const event = RuntimeOperationEventSchema.parse({
    family: 'allrice.runtime.operation',
    contractVersion: 1,
    eventId: randomUUID(),
    task: snapshot.binding.task,
    attempt: snapshot.binding.attempt,
    execution: snapshot.binding.execution,
    sequence: Number(row.next_sequence),
    occurredAt: (await now(tx)).toISOString(),
    signal,
  });
  await tx`
    insert into allrice_runtime_operation_events (id, operation_id, sequence, payload)
    values (${event.eventId}, ${row.id}, ${event.sequence}, ${json(tx, event)})
  `;
  await tx`
    update allrice_runtime_operations set snapshot = ${json(tx, snapshot)},
      next_sequence = next_sequence + 1, updated_at = clock_timestamp()
    where id = ${row.id}
  `;
  row.snapshot = snapshot;
  row.next_sequence = String(Number(row.next_sequence) + 1);
  return snapshot;
}

function verifyLease(row: OperationRow, token: string) {
  UuidSchema.parse(token);
  if (!row.lease_token_hash || hash(token) !== row.lease_token_hash)
    throw new RuntimeLedgerError('lease_lost');
}

async function cancelLocked(
  tx: Tx,
  root: RootRow,
  requestId: string,
  reason: string,
) {
  const acceptedId = root.cancel_request_id ?? requestId;
  await tx`update allrice_runtime_roots set cancel_request_id=${acceptedId},
    cancel_reason=coalesce(cancel_reason,${reason}),
    cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()) where root_run_id=${root.root_run_id}`;
  const rows = await tx<
    OperationRow[]
  >`select * from allrice_runtime_operations where root_run_id=${root.root_run_id} order by id for update`;
  for (const row of rows) {
    if (
      !isTerminalRuntimeOperationStatus(row.snapshot.status) &&
      row.snapshot.cancelRequestId === null
    )
      await append(tx, row, {
        type: 'operation.cancel_requested',
        requestId: acceptedId,
      });
    // P05 can prove non-execution while holding the scheduling lock when no
    // lease has ever been issued. Dispatched/running operations still require
    // device stop evidence; do not infer their completion from this request.
    if (
      row.snapshot.status === 'cancel_requested' &&
      row.lease_token_hash === null &&
      row.bridge_payload !== null &&
      ['local.process.execute', 'local.fs.changeset'].includes(
        RuntimeBridgePayloadSchema.parse(row.bridge_payload).capability,
      )
    ) {
      const evidence = {
        summary: '取消发生在派发前，动作未执行',
        output: { notExecuted: true },
      };
      const signal: RuntimeOperationSignal = {
        type: 'operation.stopped',
        effects: 'none',
        evidence: {
          id: randomUUID(),
          recordedAt: (await now(tx)).toISOString(),
          digest: runtimeLedgerInputDigest(evidence),
        },
      };
      await append(tx, row, signal);
      const payload = {
        attempt: row.snapshot.binding.attempt,
        signal,
        deviceSequence: null,
        evidence,
      };
      await tx`insert into allrice_runtime_operation_receipts(receipt_id,operation_id,payload,disposition)
        values(${randomUUID()},${row.id},${json(tx, payload)},'applied')`;
    }
  }
  return { requestId: acceptedId, operations: rows.map((row) => row.snapshot) };
}

function receiptContent(receipt: RuntimeLedgerReceipt) {
  return {
    attempt: RuntimeAttemptRefSchema.parse(receipt.attempt),
    signal: RuntimeOperationSignalSchema.parse(receipt.signal),
    deviceSequence:
      receipt.deviceSequence === undefined
        ? null
        : integer.parse(receipt.deviceSequence),
    evidence: receipt.evidence ?? null,
  };
}

/**
 * Server-only adapter, not an HTTP authorization boundary. Required admission is
 * evaluated IN the operation transaction; absence never means allow. Read/root
 * configuration/cancel calls require an authenticated service/user scope upstream.
 * P04 owns current policy/grant checks and atomic exact approval consumption.
 */
export function createRuntimeOperationLedger(options: {
  database?: ReturnType<typeof getDatabase>;
  admission: RuntimeLedgerAdmission;
  /** Trusted server-only private recovery journal; never returned to a client.
   * Atomic with dispatch so ACK loss cannot orphan the authenticated lease. */
  persistLease?: (input: {
    transaction: Tx;
    lease: RuntimeLedgerLease;
  }) => Promise<void>;
}) {
  if (typeof options.admission !== 'function')
    throw new RuntimeLedgerError('unavailable');
  const db = options.database ?? getDatabase();

  async function admit(
    tx: Tx,
    row: OperationRow,
    phase: 'dispatch' | 'heartbeat',
    at: Date,
  ) {
    if (row.bridge_payload !== null) {
      const payload = RuntimeBridgePayloadSchema.parse(row.bridge_payload);
      if (
        payload.capability !== row.snapshot.binding.action ||
        runtimeLedgerInputDigest(payload) !== row.snapshot.binding.inputDigest
      )
        throw new RuntimeLedgerError('scope_mismatch');
    }
    await assertRun(tx, row.snapshot.binding.task, true);
    await assertTarget(tx, row.snapshot);
    const decision = await options.admission({
      transaction: tx,
      binding: row.snapshot.binding,
      phase,
      now: at,
    });
    if (decision?.status === 'waiting_user')
      throw new RuntimeLedgerError('unavailable');
  }

  async function dispatchLocked(
    tx: Tx,
    root: RootRow,
    row: OperationRow,
    owner: string,
    duration: number,
    recoverLeaseToken?: (binding: RuntimeActionBinding) => string,
  ) {
    const at = await now(tx);
    ensureRootAdmits(root, at);
    await assertRun(tx, root.task, true);
    if (row.snapshot.status === 'dispatched' && recoverLeaseToken) {
      const token = UuidSchema.parse(recoverLeaseToken(row.snapshot.binding));
      if (
        row.lease_owner !== owner ||
        !row.lease_expires_at ||
        row.lease_expires_at <= at
      )
        throw new RuntimeLedgerError('lease_lost');
      verifyLease(row, token);
      // The original dispatch already consumed approval. Recovery only verifies
      // current authority; no new event, budget, start or lease extension.
      await admit(tx, row, 'heartbeat', at);
      const recoveredAt = await now(tx);
      ensureRootAdmits(root, recoveredAt);
      if (row.lease_expires_at <= recoveredAt)
        throw new RuntimeLedgerError('lease_lost');
      return {
        snapshot: row.snapshot,
        leaseToken: token,
        leaseExpiresAt: row.lease_expires_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        bridgePayload:
          row.bridge_payload === null
            ? null
            : RuntimeBridgePayloadSchema.parse(row.bridge_payload),
      } satisfies RuntimeLedgerLease;
    }
    if (
      ![
        'ready',
        'waiting_user',
        'waiting_device',
        'waiting_dependency',
      ].includes(row.snapshot.status) ||
      row.lease_token_hash
    )
      throw new RuntimeLedgerError('invalid_state');
    // All configured budget dimensions must have a durable reservation before dispatch.
    const [missing] = await tx<{ missing: boolean }[]>`
      select exists (
        select 1 from allrice_runtime_budgets b
        left join allrice_runtime_reservations r on r.operation_id = ${row.id} and r.metric = b.metric
        where b.root_run_id = ${root.root_run_id} and (r.operation_id is null or r.observation_id is not null)
      ) as missing
    `;
    if (missing?.missing) throw new RuntimeLedgerError('budget_exhausted');
    await admit(tx, row, 'dispatch', at);
    const admittedAt = await now(tx);
    ensureRootAdmits(root, admittedAt);
    if (row.snapshot.status !== 'ready')
      await append(tx, row, { type: 'operation.ready' });
    await append(tx, row, { type: 'operation.dispatched' });
    const leaseToken = recoverLeaseToken
      ? UuidSchema.parse(recoverLeaseToken(row.snapshot.binding))
      : randomUUID();
    const expiresAt = new Date(
      Math.min(admittedAt.getTime() + duration, root.deadline_at.getTime()),
    );
    await tx`
      update allrice_runtime_operations set lease_owner = ${owner},
        lease_token_hash = ${hash(leaseToken)}, lease_expires_at = ${expiresAt}
      where id = ${row.id}
    `;
    await options.persistLease?.({
      transaction: tx,
      lease: {
        snapshot: row.snapshot,
        leaseToken,
        leaseExpiresAt: expiresAt.toISOString(),
        createdAt: row.created_at.toISOString(),
        bridgePayload:
          row.bridge_payload === null
            ? null
            : RuntimeBridgePayloadSchema.parse(row.bridge_payload),
      },
    });
    // Event/lease writes can themselves wait on database locks. Recheck current
    // authority after the last write without consuming the approval a second time.
    await admit(tx, row, 'heartbeat', await now(tx));
    const committedAt = await now(tx);
    ensureRootAdmits(root, committedAt);
    if (expiresAt <= committedAt) throw new RuntimeLedgerError('lease_lost');
    return {
      snapshot: row.snapshot,
      leaseToken,
      leaseExpiresAt: expiresAt.toISOString(),
      createdAt: row.created_at.toISOString(),
      bridgePayload:
        row.bridge_payload === null
          ? null
          : RuntimeBridgePayloadSchema.parse(row.bridge_payload),
    } satisfies RuntimeLedgerLease;
  }

  return {
    async createRoot(input: RegisterRuntimeRootInput) {
      const task = RuntimeTaskRefSchema.parse(input.task);
      if (task.runId !== task.rootRunId)
        throw new RuntimeLedgerError('scope_mismatch');
      const deadlineAt = z.iso.datetime().parse(input.deadlineAt);
      const budgets = input.budgets
        .map((budget) => {
          integer.parse(budget.capacity);
          // Reuse the common metric/unit/currency/source consistency rules.
          RuntimeUsageObservationSchema.parse({
            contractVersion: 1,
            observationId: randomUUID(),
            accountingId: randomUUID(),
            task,
            source: budget.source,
            accountingBoundary: { kind: 'root_run', runId: task.runId },
            aggregation: 'self_only',
            metric: budget.metric,
            unit: budget.unit,
            currency: budget.currency,
            mode: 'delta',
            quality: 'measured',
            amount: budget.capacity,
            state: 'reserved',
            window: {
              id: randomUUID(),
              startedAt: deadlineAt,
              endedAt: deadlineAt,
            },
            observedAt: deadlineAt,
          });
          return budget;
        })
        .sort((a, b) => a.metric.localeCompare(b.metric));
      if (
        !budgets.length ||
        new Set(budgets.map((b) => b.metric)).size !== budgets.length
      )
        throw new RuntimeLedgerError('invalid_usage');
      return db.begin(async (tx) => {
        // Serialize first creation, including before a root row exists.
        await tx`select pg_advisory_xact_lock(hashtextextended(${task.rootRunId}, 703))`;
        await assertRun(tx, task, true);
        const [prior] = await tx<
          RootRow[]
        >`select * from allrice_runtime_roots where root_run_id = ${task.runId} for update`;
        if (prior) {
          const rows = await tx<
            BudgetRow[]
          >`select * from allrice_runtime_budgets where root_run_id = ${task.runId} order by metric`;
          const existing: RuntimeBudgetLimit[] = rows.map((row) => ({
            metric: row.metric,
            unit: row.unit,
            currency: row.currency,
            capacity: Number(row.capacity),
            source: row.source,
          }));
          if (
            !runtimeContractEqual(prior.task, task) ||
            prior.deadline_at.toISOString() !== deadlineAt ||
            !runtimeContractEqual(existing, budgets)
          )
            throw new RuntimeLedgerError('idempotency_conflict');
          return;
        }
        if (new Date(deadlineAt) <= (await now(tx)))
          throw new RuntimeLedgerError('deadline_exceeded');
        await tx`
          insert into allrice_runtime_roots (root_run_id, organization_id, workspace_id, task, deadline_at)
          values (${task.runId},${task.scope.organizationId},${task.scope.workspaceId},${json(tx, task)},${deadlineAt})
        `;
        await linkRun(tx, task);
        for (const budget of budgets)
          await tx`
          insert into allrice_runtime_budgets (root_run_id,metric,unit,currency,capacity,source)
          values (${task.runId},${budget.metric},${budget.unit},${budget.currency},${budget.capacity},${json(tx, budget.source)})
        `;
      });
    },

    async createOperation(input: CreateRuntimeOperationInput) {
      const snapshot = RuntimeOperationSnapshotSchema.parse(input.snapshot);
      if (
        snapshot.status !== 'planned' ||
        snapshot.processId ||
        snapshot.cancelRequestId ||
        snapshot.binding.attempt.attemptNumber !== 1 ||
        snapshot.binding.attempt.fence !== 1
      )
        throw new RuntimeLedgerError('invalid_state');
      const payload =
        input.bridgePayload === undefined
          ? null
          : RuntimeBridgePayloadSchema.parse(input.bridgePayload);
      if (
        (snapshot.binding.execution.targetKind === 'rice_bridge') !==
          (payload !== null) ||
        (payload &&
          (payload.capability !== snapshot.binding.action ||
            runtimeLedgerInputDigest(payload) !== snapshot.binding.inputDigest))
      )
        throw new RuntimeLedgerError('scope_mismatch');
      const reservations = input.reservations.map((r) => ({
        metric: r.metric,
        accountingId: UuidSchema.parse(r.accountingId),
        amount: integer.parse(r.amount),
      }));
      bounded({ snapshot, payload, reservations });
      return db.begin(async (tx) => {
        const root = await lockRoot(
          tx,
          snapshot.binding.task.scope,
          snapshot.binding.task.rootRunId,
        );
        const [prior] = await tx<OperationRow[]>`
          select * from allrice_runtime_operations where organization_id = ${root.organization_id}
            and workspace_id = ${root.workspace_id} and idempotency_key = ${snapshot.idempotencyKey} for update
        `;
        if (prior) {
          const reserved = await tx<
            { metric: string; accounting_id: string; amount: string }[]
          >`select metric,accounting_id,amount from allrice_runtime_reservations where operation_id=${prior.id} order by metric`;
          const canonical = (items: typeof reservations) =>
            [...items].sort((a, b) => a.metric.localeCompare(b.metric));
          if (
            !runtimeContractEqual(prior.initial_snapshot, snapshot) ||
            !runtimeContractEqual(prior.bridge_payload, payload) ||
            !runtimeContractEqual(
              canonical(reservations),
              reserved.map((r) => ({
                metric: r.metric,
                accountingId: r.accounting_id,
                amount: Number(r.amount),
              })),
            )
          )
            throw new RuntimeLedgerError('idempotency_conflict');
          return RuntimeOperationSnapshotSchema.parse(prior.snapshot);
        }
        const at = await now(tx);
        ensureRootAdmits(root, at);
        await assertRun(tx, root.task, true);
        await assertRun(tx, snapshot.binding.task, true);
        await assertTarget(tx, snapshot);
        const decision = await options.admission({
          transaction: tx,
          binding: snapshot.binding,
          phase: 'create',
          now: at,
        });
        ensureRootAdmits(root, await now(tx));
        await linkRun(tx, snapshot.binding.task);
        const budgets = await tx<
          BudgetRow[]
        >`select * from allrice_runtime_budgets where root_run_id=${root.root_run_id} order by metric`;
        if (
          reservations.length !== budgets.length ||
          new Set(reservations.map((r) => r.metric)).size !== budgets.length
        )
          throw new RuntimeLedgerError('invalid_usage');
        for (const budget of budgets) {
          const reservation = reservations.find(
            (r) => r.metric === budget.metric,
          );
          if (!reservation) throw new RuntimeLedgerError('invalid_usage');
          if (
            BigInt(budget.reserved) +
              BigInt(budget.spent) +
              BigInt(reservation.amount) >
            BigInt(budget.capacity)
          )
            throw new RuntimeLedgerError('budget_exhausted');
        }
        const { binding } = snapshot;
        await tx`
          insert into allrice_runtime_operations
            (id,organization_id,workspace_id,run_id,root_run_id,target_id,device_id,attempt_id,
             attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot,bridge_payload)
          values (${binding.attempt.operationId},${root.organization_id},${root.workspace_id},${binding.task.runId},
            ${root.root_run_id},${binding.execution.targetId},${binding.execution.deviceId},${binding.attempt.attemptId},
            ${binding.attempt.attemptNumber},${binding.attempt.generation},${binding.attempt.fence},
            ${snapshot.idempotencyKey},${json(tx, snapshot)},${json(tx, snapshot)},${json(tx, payload)})
        `;
        for (const r of reservations) {
          await tx`insert into allrice_runtime_reservations(operation_id,root_run_id,metric,accounting_id,amount)
            values(${binding.attempt.operationId},${root.root_run_id},${r.metric},${r.accountingId},${r.amount})`;
          await tx`update allrice_runtime_budgets set reserved=reserved+${r.amount} where root_run_id=${root.root_run_id} and metric=${r.metric}`;
        }
        const [row] = await tx<
          OperationRow[]
        >`select * from allrice_runtime_operations where id=${binding.attempt.operationId}`;
        const created = await append(
          tx,
          row!,
          decision?.status === 'waiting_user'
            ? { type: 'operation.waiting', reason: 'user' }
            : { type: 'operation.ready' },
        );
        const finalDecision = await options.admission({
          transaction: tx,
          binding: snapshot.binding,
          phase: 'create',
          now: await now(tx),
        });
        if (finalDecision?.status !== decision?.status)
          throw new RuntimeLedgerError('unavailable');
        ensureRootAdmits(root, await now(tx));
        return created;
      });
    },

    async dispatch(input: {
      scope: RuntimeScope;
      operationId: string;
      leaseOwner: string;
      leaseMs: number;
    }) {
      const owner = UuidSchema.parse(input.leaseOwner),
        duration = leaseDuration.parse(input.leaseMs);
      return db.begin(async (tx) => {
        const { root, row } = await lockOperation(
          tx,
          input.scope,
          input.operationId,
        );
        return dispatchLocked(tx, root, row, owner, duration);
      });
    },

    async claimNextBridgeOperation(input: {
      scope: RuntimeScope;
      deviceId: string;
      leaseMs: number;
      supportsLocalCommand?: boolean;
      supportsProjectDiagnostics?: boolean;
      supportsNpmDependencies?: boolean;
      supportsBackgroundServices?: boolean;
      supportsChangeset?: boolean;
      recoverLeaseToken?: (binding: RuntimeActionBinding) => string;
    }) {
      const scope = RuntimeScopeSchema.parse(input.scope),
        deviceId = UuidSchema.parse(input.deviceId),
        duration = leaseDuration.parse(input.leaseMs);
      // Select candidates without an operation lock; dispatch obtains canonical root→operation locks.
      const candidates = await db<
        { id: string }[]
      >`select id from allrice_runtime_operations
        where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and device_id=${deviceId}
          and (snapshot->>'status' in ('ready','waiting_user','waiting_device','waiting_dependency')
            or (${!!input.recoverLeaseToken} and snapshot->>'status'='dispatched' and lease_expires_at>clock_timestamp()))
          and (${input.supportsProjectDiagnostics === true} or not coalesce(bridge_payload->'arguments' ? 'diagnostics',false))
          and (${input.supportsNpmDependencies === true} or not coalesce(bridge_payload->'arguments' ? 'dependencies',false))
          and (${input.supportsBackgroundServices === true} or not coalesce(bridge_payload->'arguments' ? 'background',false))
          and snapshot->'binding'->>'action'=any(${[...BridgeCapabilities, ...(input.supportsLocalCommand ? ['local.process.execute'] : []), ...(input.supportsChangeset ? ['local.fs.changeset'] : [])]})
        order by updated_at,created_at,id limit 20`;
      for (const candidate of candidates) {
        try {
          return await db.begin(async (tx) => {
            const { root, row } = await lockOperation(tx, scope, candidate.id);
            return dispatchLocked(
              tx,
              root,
              row,
              deviceId,
              duration,
              input.recoverLeaseToken,
            );
          });
        } catch (error) {
          if (
            !(error instanceof RuntimeLedgerError) ||
            ![
              'invalid_state',
              'unavailable',
              'root_canceled',
              'deadline_exceeded',
              'budget_exhausted',
              'lease_lost',
            ].includes(error.code)
          )
            throw error;
          // Bounded fair scanning: updated_at includes the last unsuccessful
          // admission check. Rotate waiting/denied rows, never their binding or
          // approval, so >20 pending rows cannot starve later eligible work.
          await db`update allrice_runtime_operations set updated_at=clock_timestamp()
            where id=${candidate.id} and organization_id=${scope.organizationId}
              and workspace_id=${scope.workspaceId} and device_id=${deviceId}
              and snapshot->>'status' in ('ready','waiting_user','waiting_device','waiting_dependency','dispatched')`;
        }
      }
      return null;
    },

    async readOperation(scope: RuntimeScope, operationId: string) {
      return db.begin(async (tx) => {
        const { row } = await lockOperation(tx, scope, operationId);
        return row.snapshot;
      });
    },

    async exchangeLocalService(input: {
      scope: RuntimeScope;
      operationId: string;
      leaseToken: string;
      attempt: RuntimeAttemptRef;
      events: RuntimeLocalServiceEvent[];
      deliveryOnly?: boolean;
    }) {
      const events = z
        .array(RuntimeLocalServiceEventSchema)
        .max(16)
        .parse(input.events);
      return db.begin(async (tx) => {
        const { root, row } = await lockOperation(
          tx,
          input.scope,
          input.operationId,
        );
        verifyLease(row, input.leaseToken);
        if (
          !runtimeContractEqual(input.attempt, row.snapshot.binding.attempt) ||
          row.snapshot.binding.action !== 'local.process.execute'
        )
          throw new RuntimeLedgerError('scope_mismatch');
        const at = await now(tx);
        let allowed = false;
        if (
          row.snapshot.status === 'running' &&
          !row.snapshot.cancelRequestId &&
          row.lease_expires_at &&
          row.lease_expires_at > at
        ) {
          try {
            ensureRootAdmits(root, at);
            await admit(tx, row, 'heartbeat', at);
            ensureRootAdmits(root, await now(tx));
            allowed = true;
          } catch {
            /* A revoked/ended Run may still request a bounded stop, never more input. */
          }
        }
        const service = await exchangeLocalServiceLocked(tx, {
          snapshot: row.snapshot,
          payload: row.bridge_payload,
          rootDeadlineAt: root.deadline_at,
          events,
          allowed,
          deliveryOnly: input.deliveryOnly === true,
          now: await now(tx),
        });
        if (
          service.acceptedSequence >= 0 &&
          row.snapshot.processId === null &&
          ['running', 'cancel_requested', 'unknown'].includes(
            row.snapshot.status,
          )
        )
          await append(tx, row, {
            type: 'operation.started',
            processId: row.id,
          });
        if (
          !input.deliveryOnly &&
          service.stopRequested &&
          row.snapshot.status === 'running' &&
          row.snapshot.cancelRequestId === null
        )
          await append(tx, row, {
            type: 'operation.cancel_requested',
            requestId: randomUUID(),
          });
        let expiry = row.lease_expires_at ?? at;
        if (!input.deliveryOnly && allowed && !service.stopRequested) {
          if (!row.lease_expires_at || row.lease_expires_at <= (await now(tx)))
            throw new RuntimeLedgerError('lease_lost');
          expiry = new Date(
            Math.min(
              Date.parse(service.hardDeadlineAt),
              (await now(tx)).getTime() + 120_000,
              root.deadline_at.getTime(),
            ),
          );
          await tx`update allrice_runtime_operations set lease_expires_at=${expiry},updated_at=clock_timestamp() where id=${row.id}`;
          await admit(tx, row, 'heartbeat', await now(tx));
          ensureRootAdmits(root, await now(tx));
          const committedAt = await now(tx);
          if (expiry <= committedAt || row.lease_expires_at <= committedAt)
            throw new RuntimeLedgerError('lease_lost');
        }
        return {
          ...service,
          snapshot: row.snapshot,
          leaseExpiresAt: expiry.toISOString(),
        };
      });
    },

    async recordOutput(input: {
      scope: RuntimeScope;
      operationId: string;
      leaseToken: string;
      attempt: RuntimeAttemptRef;
      sequence: number;
      stream: 'stdout' | 'stderr';
      content: string;
    }) {
      const sequence = z.number().int().min(0).max(255).parse(input.sequence);
      const stream = z.enum(['stdout', 'stderr']).parse(input.stream);
      const content = z.string().max(65_536).parse(input.content);
      await db.begin(async (tx) => {
        const { row } = await lockOperation(tx, input.scope, input.operationId);
        verifyLease(row, input.leaseToken);
        if (
          !runtimeContractEqual(row.snapshot.binding.attempt, input.attempt) ||
          row.snapshot.binding.action !== 'local.process.execute'
        )
          throw new RuntimeLedgerError('scope_mismatch');
        const [prior] = await tx<
          { stream: string; content: string }[]
        >`select stream,content from allrice_runtime_operation_output where operation_id=${row.id} and sequence=${sequence}`;
        if (prior) {
          if (prior.stream !== stream || prior.content !== content)
            throw new RuntimeLedgerError('receipt_conflict');
          return;
        }
        const [size] = await tx<
          { next: number; bytes: string }[]
        >`select coalesce(max(sequence)+1,0)::int as next,coalesce(sum(octet_length(content)),0)::text as bytes from allrice_runtime_operation_output where operation_id=${row.id}`;
        if (
          sequence !== size?.next ||
          Number(size.bytes) + Buffer.byteLength(content) > 65_536
        )
          throw new RuntimeLedgerError('receipt_conflict');
        await tx`insert into allrice_runtime_operation_output(operation_id,sequence,stream,content) values(${row.id},${sequence},${stream},${content})`;
      });
    },

    /** Authenticated server adapter's immutable input lookup; never expose unredacted to models. */
    async readOperationInput(scope: RuntimeScope, operationId: string) {
      return db.begin(async (tx) => {
        const { row } = await lockOperation(tx, scope, operationId);
        return {
          snapshot: row.snapshot,
          bridgePayload:
            row.bridge_payload === null
              ? null
              : RuntimeBridgePayloadSchema.parse(row.bridge_payload),
        };
      });
    },

    async readReceipts(scope: RuntimeScope, operationId: string, limit = 200) {
      z.number().int().min(1).max(1000).parse(limit);
      return db.begin(async (tx) => {
        await lockOperation(tx, scope, operationId);
        return tx<
          {
            receipt_id: string;
            payload: unknown;
            disposition: string;
            received_at: Date;
          }[]
        >`
          select receipt_id,payload,disposition,received_at from allrice_runtime_operation_receipts
          where operation_id=${operationId} order by received_at,receipt_id limit ${limit}`;
      });
    },

    async readEvents(
      scope: RuntimeScope,
      operationId: string,
      afterSequence = -1,
      limit = 200,
    ) {
      z.number()
        .int()
        .min(-1)
        .max(Number.MAX_SAFE_INTEGER)
        .parse(afterSequence);
      z.number().int().min(1).max(1000).parse(limit);
      return db.begin(async (tx) => {
        await lockOperation(tx, scope, operationId);
        const rows = await tx<
          { payload: RuntimeOperationEvent }[]
        >`select payload from allrice_runtime_operation_events where operation_id=${operationId} and sequence>${afterSequence} order by sequence limit ${limit}`;
        return rows.map((row) =>
          RuntimeOperationEventSchema.parse(row.payload),
        );
      });
    },

    async startOperation(
      input: Omit<
        RuntimeLedgerReceipt,
        'signal' | 'deviceSequence' | 'evidence'
      >,
    ) {
      UuidSchema.parse(input.receiptId);
      const attempt = RuntimeAttemptRefSchema.parse(input.attempt);
      return db.begin(async (tx) => {
        const { root, row } = await lockOperation(
          tx,
          input.scope,
          input.operationId,
        );
        verifyLease(row, input.leaseToken);
        const content = { attempt, kind: 'execution_preflight' };
        const [prior] = await tx<
          {
            payload: unknown;
            operation_id: string;
            disposition: 'applied' | 'stale' | 'conflict';
          }[]
        >`select payload,operation_id,disposition from allrice_runtime_operation_receipts where receipt_id=${input.receiptId}`;
        if (prior) {
          if (
            prior.operation_id !== row.id ||
            !runtimeContractEqual(prior.payload, content)
          )
            throw new RuntimeLedgerError('receipt_conflict');
          return { snapshot: row.snapshot, mayExecute: false };
        }
        if (!runtimeContractEqual(attempt, row.snapshot.binding.attempt))
          throw new RuntimeLedgerError('lease_lost');
        const at = await now(tx);
        ensureRootAdmits(root, at);
        await assertRun(tx, root.task, true);
        if (
          !row.lease_expires_at ||
          row.lease_expires_at <= at ||
          row.snapshot.status !== 'dispatched'
        )
          throw new RuntimeLedgerError('lease_lost');
        await admit(tx, row, 'heartbeat', at);
        const admittedAt = await now(tx);
        ensureRootAdmits(root, admittedAt);
        if (row.lease_expires_at <= admittedAt)
          throw new RuntimeLedgerError('lease_lost');
        await append(tx, row, { type: 'operation.started', processId: null });
        await tx`insert into allrice_runtime_operation_receipts(receipt_id,operation_id,payload,disposition) values(${input.receiptId},${row.id},${json(tx, content)},'applied')`;
        await admit(tx, row, 'heartbeat', await now(tx));
        const committedAt = await now(tx);
        ensureRootAdmits(root, committedAt);
        if (row.lease_expires_at <= committedAt)
          throw new RuntimeLedgerError('lease_lost');
        return { snapshot: row.snapshot, mayExecute: true };
      });
    },

    async heartbeat(input: {
      scope: RuntimeScope;
      operationId: string;
      leaseToken: string;
      leaseMs: number;
    }) {
      const duration = leaseDuration.parse(input.leaseMs);
      return db.begin(async (tx) => {
        const { root, row } = await lockOperation(
          tx,
          input.scope,
          input.operationId,
        );
        verifyLease(row, input.leaseToken);
        const at = await now(tx);
        ensureRootAdmits(root, at);
        await assertRun(tx, root.task, true);
        if (
          !row.lease_expires_at ||
          row.lease_expires_at <= at ||
          !['dispatched', 'running'].includes(row.snapshot.status)
        )
          throw new RuntimeLedgerError('lease_lost');
        await admit(tx, row, 'heartbeat', at);
        const admittedAt = await now(tx);
        ensureRootAdmits(root, admittedAt);
        if (row.lease_expires_at <= admittedAt)
          throw new RuntimeLedgerError('lease_lost');
        const expiresAt = new Date(
          Math.min(admittedAt.getTime() + duration, root.deadline_at.getTime()),
        );
        await tx`update allrice_runtime_operations set lease_expires_at=${expiresAt},updated_at=clock_timestamp() where id=${row.id}`;
        await admit(tx, row, 'heartbeat', await now(tx));
        const committedAt = await now(tx);
        ensureRootAdmits(root, committedAt);
        if (expiresAt <= committedAt || row.lease_expires_at <= committedAt)
          throw new RuntimeLedgerError('lease_lost');
        return {
          snapshot: row.snapshot,
          leaseExpiresAt: expiresAt.toISOString(),
        };
      });
    },

    async recordReceipt(input: RuntimeLedgerReceipt) {
      UuidSchema.parse(input.receiptId);
      const content = receiptContent(input);
      bounded(content);
      runtimeLedgerInputDigest(content); // Refuse non-JSON evidence instead of silently dropping it.
      // A device reports facts, never server scheduling or authorization intents.
      if (
        ![
          'operation.started',
          'operation.transport_ack',
          'operation.uncertain',
          'operation.outcome',
          'operation.stopped',
        ].includes(content.signal.type)
      )
        throw new RuntimeLedgerError('invalid_state');
      return db.begin(async (tx) => {
        const { row } = await lockOperation(tx, input.scope, input.operationId);
        verifyLease(row, input.leaseToken); // Expired/revoked leases may still deliver facts, never new execution.
        const [previous] = await tx<
          {
            payload: unknown;
            operation_id: string;
            disposition: 'applied' | 'stale' | 'conflict';
          }[]
        >`select payload,operation_id,disposition from allrice_runtime_operation_receipts where receipt_id=${input.receiptId}`;
        if (previous) {
          if (
            previous.operation_id !== row.id ||
            !runtimeContractEqual(previous.payload, content)
          )
            throw new RuntimeLedgerError('receipt_conflict');
          return {
            snapshot: row.snapshot,
            disposition:
              previous.disposition === 'applied'
                ? ('duplicate' as const)
                : previous.disposition,
          };
        }
        let disposition: 'applied' | 'stale' | 'conflict' = 'applied';
        if (
          !runtimeContractEqual(content.attempt, row.snapshot.binding.attempt)
        )
          disposition = 'stale';
        else {
          // A finite service may be stopped locally (Bridge shutdown/lease
          // loss) before the server saw a stop request. Preserve the targeted
          // intent and then its authenticated actual stop fact; never cancel
          // the entire Run or infer process termination from intent alone.
          if (
            content.signal.type === 'operation.stopped' &&
            row.snapshot.status === 'running' &&
            row.bridge_payload !== null
          ) {
            const payload = RuntimeBridgePayloadSchema.parse(
              row.bridge_payload,
            );
            if (
              payload.capability === 'local.process.execute' &&
              payload.arguments.background
            ) {
              const evidence = input.evidence as
                { output?: unknown } | null | undefined;
              const result = RuntimeLocalCommandResultSchema.safeParse(
                evidence?.output,
              );
              const [service] = await tx<
                { container_id: string | null }[]
              >`select container_id from allrice_local_services where operation_id=${row.id}`;
              if (
                !result.success ||
                !['canceled', 'lease_lost'].includes(result.data.reason) ||
                result.data.containerId !== service?.container_id ||
                result.data.imageDigest !== payload.arguments.imageDigest
              )
                throw new RuntimeLedgerError('invalid_state');
              await append(tx, row, {
                type: 'operation.cancel_requested',
                requestId: input.receiptId,
              });
            }
          }
          try {
            advanceRuntimeOperation(row.snapshot, content.signal);
          } catch {
            disposition = 'conflict';
          }
          if (disposition === 'applied') await append(tx, row, content.signal);
        }
        await tx`insert into allrice_runtime_operation_receipts(receipt_id,operation_id,payload,disposition)
          values(${input.receiptId},${row.id},${json(tx, content)},${disposition})`;
        return { snapshot: row.snapshot, disposition };
      });
    },

    async expireLeases(scope: RuntimeScope, rootRunId: string) {
      return db.begin(async (tx) => {
        const root = await lockRoot(tx, scope, rootRunId);
        if (root.deadline_at <= (await now(tx)))
          await cancelLocked(tx, root, randomUUID(), 'deadline');
        const rows = await tx<
          OperationRow[]
        >`select * from allrice_runtime_operations where root_run_id=${rootRunId} and lease_expires_at<=clock_timestamp()
          and snapshot->>'status' in ('dispatched','running','cancel_requested') order by id for update`;
        for (const row of rows)
          await append(tx, row, {
            type: 'operation.uncertain',
            reason: 'lease_lost',
          });
        return rows.map((row) => row.snapshot);
      });
    },

    async cancelRoot(
      scope: RuntimeScope,
      rootRunId: string,
      requestId: string,
      transaction?: Tx,
    ) {
      UuidSchema.parse(requestId);
      const apply = async (tx: Tx) => {
        const root = await lockRoot(tx, scope, rootRunId);
        // Intention only; no operation or process is declared stopped here.
        return cancelLocked(tx, root, requestId, 'user_request');
      };
      // Keep current membership authorization and cancellation atomic without
      // borrowing a second pool connection from a caller's transaction.
      return transaction ? apply(transaction) : db.begin(apply);
    },

    async settleUsage(input: {
      scope: RuntimeScope;
      operationId: string;
      leaseToken: string;
      observation: RuntimeUsageObservation;
    }) {
      const observation = RuntimeUsageObservationSchema.parse(
        input.observation,
      );
      return db.begin(async (tx) => {
        const { root, row } = await lockOperation(
          tx,
          input.scope,
          input.operationId,
        );
        verifyLease(row, input.leaseToken);
        const [reservation] = await tx<
          {
            accounting_id: string;
            amount: string;
            settled_amount: string | null;
            observation: RuntimeUsageObservation | null;
          }[]
        >`select * from allrice_runtime_reservations where operation_id=${row.id} and metric=${observation.metric}`;
        const [budget] = await tx<
          BudgetRow[]
        >`select * from allrice_runtime_budgets where root_run_id=${root.root_run_id} and metric=${observation.metric}`;
        if (
          !reservation ||
          !budget ||
          !runtimeContractEqual(observation.task, row.snapshot.binding.task) ||
          observation.accountingBoundary.kind !== 'operation' ||
          !runtimeContractEqual(
            observation.accountingBoundary.attempt,
            row.snapshot.binding.attempt,
          ) ||
          observation.accountingId !== reservation.accounting_id ||
          !runtimeContractEqual(observation.source, budget.source) ||
          observation.unit !== budget.unit ||
          observation.currency !== budget.currency ||
          observation.aggregation !== 'self_only' ||
          observation.state !== 'settled' ||
          observation.mode !== 'cumulative' ||
          observation.quality !== 'measured' ||
          observation.amount === null
        )
          throw new RuntimeLedgerError('invalid_usage');
        if (reservation.observation) {
          if (!runtimeContractEqual(reservation.observation, observation))
            throw new RuntimeLedgerError('receipt_conflict');
          return { duplicate: true };
        }
        if (!isTerminalRuntimeOperationStatus(row.snapshot.status))
          throw new RuntimeLedgerError('invalid_state');
        // Unknown/estimated usage never releases a reservation. Actual overspend is
        // recorded truthfully and prevents new admission rather than hiding cost.
        const reserved = BigInt(budget.reserved) - BigInt(reservation.amount);
        const spent = BigInt(budget.spent) + BigInt(observation.amount);
        if (reserved + spent > BigInt(Number.MAX_SAFE_INTEGER))
          throw new RuntimeLedgerError('invalid_usage');
        await tx`update allrice_runtime_reservations set settled_amount=${observation.amount},observation_id=${observation.observationId},observation=${json(tx, observation)} where operation_id=${row.id} and metric=${observation.metric}`;
        await tx`update allrice_runtime_budgets set reserved=${String(reserved)},spent=${String(spent)} where root_run_id=${root.root_run_id} and metric=${observation.metric}`;
        if (reserved + spent > BigInt(budget.capacity))
          await cancelLocked(tx, root, randomUUID(), 'budget_exhausted');
        return { duplicate: false };
      });
    },

    async readBudget(scope: RuntimeScope, rootRunId: string) {
      return db.begin(async (tx) => {
        const root = await lockRoot(tx, scope, rootRunId);
        const budgets = await tx<
          BudgetRow[]
        >`select * from allrice_runtime_budgets where root_run_id=${rootRunId} order by metric`;
        const unresolved = await tx<
          { metric: string; count: string }[]
        >`select metric,count(*) from allrice_runtime_reservations where root_run_id=${rootRunId} and observation_id is null group by metric`;
        return {
          cancelRequestId: root.cancel_request_id,
          cancelReason: root.cancel_reason,
          deadlineAt: root.deadline_at.toISOString(),
          budgets: budgets.map((row) => ({
            metric: row.metric,
            unit: row.unit,
            currency: row.currency,
            capacity: Number(row.capacity),
            reserved: Number(row.reserved),
            spent: Number(row.spent),
            // spent is only confirmed settlements, NOT a total usage estimate.
            unresolvedReservations: Number(
              unresolved.find((item) => item.metric === row.metric)?.count ?? 0,
            ),
            usageComplete: !unresolved.some(
              (item) => item.metric === row.metric,
            ),
          })),
        };
      });
    },
  };
}
