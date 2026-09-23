import { runtimeFeatureEnabled } from '@allrice/contracts';
import { z } from 'zod';
import {
  AssistantPriceSnapshotSchema,
  AssistantPricedUsageSchema,
  RuntimeScopeSchema,
  RuntimeTaskRefSchema,
  assistantCostProjection,
  estimateAssistantUsageCost,
  type AssistantPriceSnapshot,
  type AssistantPricedUsage,
  type RuntimeScope,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { runtimeLedgerInputDigest } from './runtime-ledger/ledger.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
import type { AssistantWorkerLease } from './assistant-runtime.ts';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workerSchema = z
  .object({
    jobId: z.uuid(),
    workerId: z.uuid(),
    leaseToken: z.uuid(),
    generation: z.number().int().nonnegative(),
    fence: z.number().int().positive().optional(),
  })
  .strict();
type Tx = RuntimeLedgerTransaction;
interface Identity {
  scope: RuntimeScope;
  rootRunId: string;
  worker: AssistantWorkerLease;
}
function fail(code: string): never {
  throw new Error(code);
}
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));

/** Evidence storage only. Does NOT authorize a model call, reserve budgets,
 * change RouteOutcome, reconcile old unknown charges, or convert currencies.
 * A caller must first preflight selectAssistantPriceSnapshot BEFORE dispatch.
 * Current native cache presence is unproved. This API accepts unknown cache
 * only and stores a conservative tariff upper bound from confirmed totals.
 * It never labels that estimate as an actual provider charge.
 */
export function createAssistantPricing(
  options: { database?: ReturnType<typeof getDatabase> } = {},
) {
  const db = options.database ?? getDatabase();
  async function lock(tx: Tx, input: Identity, admitting = false) {
    const scope = RuntimeScopeSchema.parse(input.scope);
    const id = z.uuid().parse(input.rootRunId);
    const worker = workerSchema.parse(input.worker);
    // Shared lock order: runtime root -> assistant root -> live job/run.
    const [root] =
      await tx`select * from allrice_runtime_roots where root_run_id=${id}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} for update`;
    if (
      !root ||
      RuntimeTaskRefSchema.parse(root.task).scope.projectId !== scope.projectId
    )
      fail('ASSISTANT_PRICING_SCOPE_DENIED');
    const [assistant] =
      await tx`select * from allrice_assistant_roots where root_run_id=${id} for update`;
    const [job] =
      await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
      where j.id=${worker.jobId} and j.run_id=${id} and j.worker_id=${worker.workerId}
      and j.lease_token=${worker.leaseToken} and j.status='running'
      and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()
      and j.organization_id=${scope.organizationId} and j.workspace_id=${scope.workspaceId}
      and r.organization_id=j.organization_id and r.workspace_id=j.workspace_id and r.owner_id=j.owner_id
      and r.state in ('running','queued','waiting_approval')
      and (${admitting}=false or j.cancel_requested_at is null) for share of j,r`;
    if (
      !assistant ||
      !job ||
      assistant.worker_job_id !== worker.jobId ||
      assistant.worker_id !== worker.workerId ||
      assistant.worker_lease_digest !==
        runtimeLedgerInputDigest(worker.leaseToken) ||
      Number(assistant.generation) !== worker.generation ||
      Number(assistant.fence) !== (worker.fence ?? 1) ||
      assistant.revoked_at
    )
      fail('ASSISTANT_PRICING_LEASE_LOST');
    const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
    if (
      admitting &&
      (!runtimeFeatureEnabled('ALLRICE_ASSISTANTS_ENABLED') ||
        assistant.configuration.allowAssistants !== true ||
        root.cancel_request_id ||
        root.deadline_at <= clock!.now)
    )
      fail('ASSISTANT_PRICING_ADMISSION_DENIED');
    return clock!.now;
  }
  async function readSnapshot(tx: Tx, rootRunId: string) {
    const [row] =
      await tx`select * from allrice_assistant_price_snapshots where root_run_id=${rootRunId}`;
    if (!row) fail('ASSISTANT_PRICE_UNAVAILABLE');
    const snapshot = AssistantPriceSnapshotSchema.parse(row!.snapshot);
    if (
      runtimeLedgerInputDigest(snapshot) !== row!.snapshot_digest ||
      snapshot.price.currency !== row!.currency
    )
      fail('ASSISTANT_PRICE_SNAPSHOT_CONFLICT');
    return { snapshot, snapshotDigest: String(row!.snapshot_digest) };
  }
  return {
    async freeze(input: Identity & { snapshot: AssistantPriceSnapshot }) {
      const snapshot = AssistantPriceSnapshotSchema.parse(input.snapshot);
      const snapshotDigest = runtimeLedgerInputDigest(snapshot);
      return db.begin(async (tx) => {
        const now = await lock(tx, input, true);
        const [old] =
          await tx`select snapshot_digest from allrice_assistant_price_snapshots where root_run_id=${input.rootRunId}`;
        if (old) {
          if (old.snapshot_digest !== snapshotDigest)
            fail('ASSISTANT_PRICE_SNAPSHOT_CONFLICT');
          await readSnapshot(tx, input.rootRunId);
          return { frozen: false, snapshotDigest };
        }
        // Never retroactively attach today's tariff to already admitted work.
        const [started] =
          await tx`select 1 from allrice_assistant_model_admissions where root_run_id=${input.rootRunId} limit 1`;
        if (
          started ||
          Date.parse(snapshot.selectedAt) > now.getTime() ||
          now.getTime() < Date.parse(snapshot.price.effectiveAt) ||
          now.getTime() >= Date.parse(snapshot.price.expiresAt)
        )
          fail('ASSISTANT_PRICE_FREEZE_TOO_LATE');
        await tx`insert into allrice_assistant_price_snapshots(root_run_id,snapshot_digest,snapshot,currency)
          values(${input.rootRunId},${snapshotDigest},${json(tx, snapshot)},${snapshot.price.currency})`;
        return { frozen: true, snapshotDigest };
      });
    },
    async recordUsage(
      input: Identity & {
        runId: string;
        callId: string;
        snapshotDigest: string;
        requestDigest: string;
        usage: AssistantPricedUsage;
      },
    ) {
      z.uuid().parse(input.runId);
      z.uuid().parse(input.callId);
      digestSchema.parse(input.snapshotDigest);
      digestSchema.parse(input.requestDigest);
      const usage = AssistantPricedUsageSchema.parse(input.usage);
      if (usage.cacheReadTokens !== null || usage.cacheWriteTokens !== null)
        fail('ASSISTANT_PRICING_CACHE_UNCONFIRMED');
      return db.begin(async (tx) => {
        await lock(tx, input);
        const frozen = await readSnapshot(tx, input.rootRunId);
        if (frozen.snapshotDigest !== input.snapshotDigest)
          fail('ASSISTANT_PRICE_SNAPSHOT_CONFLICT');
        const [call] =
          await tx`select a.* from allrice_assistant_model_admissions a
          join allrice_assistant_instances i on i.run_id=a.run_id and i.root_run_id=a.root_run_id
          where a.call_id=${input.callId} and a.root_run_id=${input.rootRunId} and a.run_id=${input.runId} for update of a`;
        if (
          !call ||
          !call.dispatched_at ||
          call.request_digest !== input.requestDigest
        )
          fail('ASSISTANT_PRICING_CALL_CONFLICT');
        const confirmed = await tx<
          { metric: string; settled_amount: string | null }[]
        >`
          select metric,settled_amount from allrice_assistant_usage where root_run_id=${input.rootRunId}
            and run_id=${input.runId} and call_id=${input.callId} for update`;
        const values = new Map(
          confirmed.map((row) => [row.metric, row.settled_amount]),
        );
        if (
          usage.usageComplete &&
          (!call.finished_at || values.get('model_calls') !== '1')
        )
          fail('ASSISTANT_PRICING_USAGE_UNCONFIRMED');
        for (const [metric, amount] of [
          ['input_tokens', usage.inputTokens],
          ['output_tokens', usage.outputTokens],
        ] as const) {
          if (
            amount !== null &&
            (values.get(metric) == null ||
              BigInt(values.get(metric)!) !== BigInt(amount))
          )
            fail('ASSISTANT_PRICING_USAGE_UNCONFIRMED');
        }
        const estimated = estimateAssistantUsageCost(frozen.snapshot, usage);
        const receiptDigest = runtimeLedgerInputDigest({
          rootRunId: input.rootRunId,
          runId: input.runId,
          callId: input.callId,
          snapshotDigest: frozen.snapshotDigest,
          requestDigest: input.requestDigest,
          usage,
          costBasis: estimated.costBasis,
          costPicounits: estimated.costPicounits,
        });
        const [old] =
          await tx`select receipt_digest from allrice_assistant_cost_receipts where call_id=${input.callId}`;
        if (old) {
          if (old.receipt_digest !== receiptDigest)
            fail('ASSISTANT_PRICING_RECEIPT_CONFLICT');
          return { recorded: false, receiptDigest, ...estimated };
        }
        await tx`insert into allrice_assistant_cost_receipts(call_id,root_run_id,run_id,snapshot_digest,request_digest,
          receipt_digest,usage,usage_complete,cache_usage_known,cost_basis,actual_cost_known,cost_picounits)
          values(${input.callId},${input.rootRunId},${input.runId},${frozen.snapshotDigest},${input.requestDigest},
          ${receiptDigest},${json(tx, usage)},${usage.usageComplete},${estimated.cacheUsageKnown},${estimated.costBasis},false,${estimated.costPicounits})`;
        return { recorded: true, receiptDigest, ...estimated };
      });
    },
    /** Whole-root, self-only call receipts; parent adoption never adds cost.
     * This is a current accounting view, NOT proof the tree cannot add work.
     * Caller must finalize/join the tree and reserve monetary budgets separately.
     */
    async summarize(input: Identity) {
      return db.begin(async (tx) => {
        await lock(tx, input);
        const frozen = await readSnapshot(tx, input.rootRunId);
        const calls =
          await tx`select a.call_id,a.dispatched_at,a.finished_at,c.usage_complete,c.cache_usage_known,c.cost_picounits
          from allrice_assistant_model_admissions a left join allrice_assistant_cost_receipts c
            on c.call_id=a.call_id and c.root_run_id=a.root_run_id and c.run_id=a.run_id and c.request_digest=a.request_digest
            and c.snapshot_digest=${frozen.snapshotDigest}
          where a.root_run_id=${input.rootRunId}`;
        const [unsettled] =
          await tx`select 1 from allrice_assistant_usage where root_run_id=${input.rootRunId} and settled_amount is null limit 1`;
        const usageComplete =
          !unsettled &&
          calls.every(
            (call) =>
              call.dispatched_at &&
              call.finished_at &&
              call.usage_complete === true,
          );
        const cacheUsageKnown = calls.every(
          (call) => call.cache_usage_known === true,
        );
        const costKnown =
          usageComplete && calls.every((call) => call.cost_picounits !== null);
        const total = costKnown
          ? calls.reduce((sum, call) => sum + BigInt(call.cost_picounits), 0n)
          : null;
        return {
          snapshotDigest: frozen.snapshotDigest,
          currency: frozen.snapshot.price.currency,
          callCount: calls.length,
          usageComplete,
          cacheUsageKnown,
          quality: costKnown
            ? ('tariff_estimate' as const)
            : ('unknown' as const),
          costBasis: costKnown
            ? ('conservative_upper_bound' as const)
            : ('unknown' as const),
          actualCostKnown: false as const,
          ...(total === null
            ? {
                costPicounits: null,
                costMicrounitsCeiling: null,
                costCentsDecimal: null,
              }
            : assistantCostProjection(total.toString())),
        };
      });
    },
  };
}
