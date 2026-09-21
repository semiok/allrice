import { randomUUID } from 'node:crypto';
import {
  AssistantRunConfigurationSchema,
  AssistantPriceSnapshotSchema,
  AssistantSubscriptionSnapshotSchema,
  DshExecutionSnapshotSchema,
  ModelRunLimitsSchema,
  allRiceToolManifest,
  estimateAssistantUsageCost,
  type AssistantPriceSnapshot,
  type AssistantSubscriptionSnapshot,
  type DshExecutionSnapshot,
  type ExecutionContext,
  type RuntimeTaskRef,
  type StoragePort,
} from '@allrice/contracts';
import {
  assistantRuntimeEnabled,
  createAssistantRuntime,
  createAssistantPricing,
  createRuntimeOperationLedger,
  createLocalCommandOperation,
  waitLocalCommandOperation,
  publishAssistantOutput,
  getDatabase,
  runtimePolicyDigest,
  verifyRouteSubscriptionSnapshot,
  type AssistantAuthorityInput,
  type AssistantWorkerLease,
  type RuntimeBudgetLimit,
} from '@allrice/database';
import type { HarnessExecutionInput } from '../adapter.js';
import { createAssistantWorkerBridge } from './assistant-bridge.js';
import { assistantNativeCheckpointEvidence } from './assistant-recovery.js';
import { assertAssistantProviderOutputBound } from './assistant-provider.js';
import { assertSubscriptionQuotaNotExhausted } from '../../subscription-quota-admission.js';

function assertPriceProvider(
  price: AssistantPriceSnapshot,
  provider: DshExecutionSnapshot,
) {
  const target = price.price.target;
  const model =
    provider.route === 'gemini' && provider.model === '3.8flash'
      ? 'gemini-3.8-flash'
      : provider.model;
  const baseUrl =
    provider.route === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : provider.baseUrl;
  if (
    provider.authMode !== 'allrice_credential' ||
    target.provider !== provider.route ||
    target.model !== model ||
    target.baseUrl !== baseUrl
  )
    throw Error('assistant_price_provider_mismatch');
}

/** Server-owned admission and budget assembly. The browser's preference never
 * supplies authority, tool sets, native IDs, budget amounts or a worker lease. */
export function productionAssistantController(input: {
  configuration: unknown;
  context: ExecutionContext;
  worker: Omit<AssistantWorkerLease, 'generation'>;
  runLimits: unknown;
  tools: readonly { name: string }[];
  authorize: (input: AssistantAuthorityInput) => Promise<void>;
  database?: ReturnType<typeof getDatabase>;
  storage?: StoragePort;
  signal?: AbortSignal;
  /** Server-selected tariff only; no price or route selection by model/browser. */
  priceSnapshot?: AssistantPriceSnapshot;
  /** Exact server-frozen subscription identity, never an API price substitute. */
  subscriptionSnapshot?: AssistantSubscriptionSnapshot;
  /** INTERNAL ONLY: Worker replay already matched to its persisted route
   * decision, including any frozen fallback. Never a browser/model field. */
  serverPricingProviderSnapshot?: DshExecutionSnapshot;
}): HarnessExecutionInput['assistants'] {
  if (input.configuration === undefined) return undefined;
  const configuration = AssistantRunConfigurationSchema.parse(
    input.configuration,
  );
  if (!configuration.allowAssistants) return undefined;
  if (!assistantRuntimeEnabled()) throw Error('assistant_runtime_disabled');
  const limits = ModelRunLimitsSchema.parse(input.runLimits ?? {});
  const priceSnapshot = input.priceSnapshot
    ? AssistantPriceSnapshotSchema.parse(input.priceSnapshot)
    : undefined;
  const subscriptionSnapshot = input.subscriptionSnapshot
    ? AssistantSubscriptionSnapshotSchema.parse(input.subscriptionSnapshot)
    : undefined;
  if (subscriptionSnapshot && priceSnapshot)
    throw Error('assistant_billing_mode_conflict');
  // The existing RouteOutcome/monthly quota ledger has no currency column.
  // It cannot safely aggregate arbitrary ISO currencies, even with valid tariffs.
  if (priceSnapshot && priceSnapshot.price.currency !== 'USD')
    throw Error('assistant_price_currency_unsupported');
  const pricingProvider = input.serverPricingProviderSnapshot
    ? DshExecutionSnapshotSchema.parse(input.serverPricingProviderSnapshot)
    : undefined;
  if (priceSnapshot && pricingProvider)
    assertPriceProvider(priceSnapshot, pricingProvider);
  const outputCapacity = Math.min(
    limits.maxOutputTokens,
    limits.maxTotalTokens - 1,
  );
  const inputCapacity = Math.min(
    limits.maxInputTokens,
    limits.maxTotalTokens - outputCapacity,
  );
  // Constrain every call to one verified tariff band BEFORE model preparation.
  // Whole-root token capacities also provide the conservative monetary bound.
  const priceBound = priceSnapshot
    ? estimateAssistantUsageCost(priceSnapshot, {
        inputTokens: inputCapacity,
        outputTokens: outputCapacity,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        usageComplete: true,
      })
    : undefined;
  // The downstream legacy ledger is numeric(14,6) cents. Refuse a tariff whose
  // whole-root upper bound cannot be represented; never overflow or report zero.
  if (
    priceBound?.costPicounits !== undefined &&
    (priceBound.costPicounits === null ||
      BigInt(priceBound.costPicounits) > 999999999999990000n)
  )
    throw Error('assistant_cost_projection_out_of_range');
  if (limits.maxCostCents !== null && !subscriptionSnapshot) {
    if (!priceBound?.costPicounits)
      throw Error('assistant_cost_bound_unavailable');
    // Frozen token capacities are shared by the entire tree, never renewed per
    // child. Their conservative price bound must fit the full monetary cap.
    if (
      BigInt(priceBound.costPicounits) >
      BigInt(limits.maxCostCents) * 10000000000n
    )
      throw Error('assistant_cost_bound_exceeds_limit');
  }
  const allowedTools = input.tools.map((tool) => tool.name);
  if (!allowedTools.includes('assistant.delegate'))
    throw Error('assistant_authority_missing');
  const db = input.database ?? getDatabase();
  const runtime = createAssistantRuntime({
    database: db,
    authorize: input.authorize,
  });
  const context = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    actor: input.context.delegatedBy,
    organizationId: input.context.organizationId,
    workspaceId: input.context.workspaceId,
    memberships: input.context.policySnapshot.memberships,
    authenticatedAt: input.context.startedAt,
  };
  return {
    rootRunId: input.context.runId,
    ...(subscriptionSnapshot ? { subscriptionSnapshot } : {}),
    maxOutputTokens: Math.max(
      1,
      Math.floor(
        Math.min(limits.maxOutputTokens, limits.maxTotalTokens - 1) /
          (configuration.maxConcurrent + 1),
      ),
    ),
    async bind(nativeSessionId, generation, onToolCall, inspect) {
      // The Worker queue lease also carries leaseMs (and may grow other queue
      // fields). Project the assistant authority explicitly: never spread that
      // envelope into strict pricing/recovery contracts or forward a stale
      // queue-supplied generation instead of the actual bound native generation.
      const worker: AssistantWorkerLease = {
        workerId: input.worker.workerId,
        jobId: input.worker.jobId,
        leaseToken: input.worker.leaseToken,
        generation,
        ...(input.worker.fence === undefined
          ? {}
          : { fence: input.worker.fence }),
      };
      const [prior] = await db<
        {
          worker_lease_digest: string;
          generation: number;
          task: RuntimeTaskRef;
        }[]
      >`select a.worker_lease_digest,a.generation,r.task from allrice_assistant_roots a join allrice_runtime_roots r using(root_run_id) join allrice_runs run on run.id=r.root_run_id where a.root_run_id=${input.context.runId} and r.organization_id=${context.organizationId} and r.workspace_id=${context.workspaceId} and run.owner_id=${context.actor.id}`;
      if (
        prior &&
        (prior.worker_lease_digest !==
          runtimePolicyDigest(input.worker.leaseToken) ||
          Number(prior.generation) !== generation)
      ) {
        await runtime.quarantineExpired({
          scope: prior.task.scope,
          rootRunId: input.context.runId,
        });
        const tree = await runtime.getTree(context, {
          runId: input.context.runId,
        });
        if (inspect)
          for (const instance of tree.instances) {
            const evidence = await inspect(instance.nativeSessionId).catch(
              () => null,
            );
            if (!evidence) continue; // No journal is uncertainty, never proof of non-execution.
            const checkpoints = assistantNativeCheckpointEvidence(
              evidence,
              tree.messages.filter(
                (message) => message.childRunId === instance.runId,
              ),
            );
            if (checkpoints.length)
              await runtime.recoverNativeEvidence(context, {
                rootRunId: input.context.runId,
                nativeSessionId: instance.nativeSessionId,
                worker,
                checkpoints,
              });
          }
        throw Error('assistant_recovery_required_no_replay');
      }
      const [row] = await db<
        {
          execution_spec: unknown;
          employee_version_id: string;
          session_id: string;
          timeout_at: Date;
          configuration: unknown;
          project_id: string | null;
          provider_snapshot: unknown;
        }[]
      >`
        select r.execution_spec,r.project_id,e.employee_version_id,e.session_id,e.provider_snapshot,j.timeout_at,r.input->'assistantConfiguration' as configuration
        from allrice_runs r join allrice_employee_runs e on e.run_id=r.id
        join allrice_jobs j on j.run_id=r.id and j.id=${input.worker.jobId}
        where r.id=${input.context.runId} and r.organization_id=${input.context.organizationId}
          and r.workspace_id=${input.context.workspaceId} and r.owner_id=${input.context.delegatedBy.id}`;
      if (
        !row ||
        runtimePolicyDigest(row.configuration) !==
          runtimePolicyDigest(configuration)
      )
        throw Error('assistant_frozen_configuration_mismatch');
      if (priceSnapshot) {
        assertPriceProvider(
          priceSnapshot,
          pricingProvider ??
            DshExecutionSnapshotSchema.parse(row.provider_snapshot),
        );
        // Never run across an unquoted tariff interval or silently replace the
        // frozen price midway. The job's actual durable deadline is authoritative.
        if (
          Date.parse(priceSnapshot.price.expiresAt) < row.timeout_at.getTime()
        )
          throw Error('assistant_price_expires_before_deadline');
      }
      let subscriptionSnapshotDigest: string | undefined;
      if (subscriptionSnapshot) {
        if (subscriptionSnapshot.sessionId !== row.session_id)
          throw Error('assistant_subscription_session_mismatch');
        assertAssistantProviderOutputBound(
          pricingProvider ??
            DshExecutionSnapshotSchema.parse(row.provider_snapshot),
          true,
          subscriptionSnapshot,
        );
        // Persisted route proof is authoritative: an in-memory marker alone
        // must never unlock subscription admission or label unknown money N/A.
        const proof = await verifyRouteSubscriptionSnapshot(
          {
            organizationId: context.organizationId,
            workspaceId: context.workspaceId!,
            runId: input.context.runId,
            snapshot: subscriptionSnapshot,
          },
          db,
        );
        subscriptionSnapshotDigest = proof.snapshotDigest;
      }
      const task: RuntimeTaskRef = {
        runId: input.context.runId,
        rootRunId: input.context.runId,
        parentRunId: null,
        chatSessionId: row.session_id,
        scope: {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId!,
          projectId: row.project_id,
        },
        frozenConfiguration: {
          employeeVersionId: row.employee_version_id,
          digest: runtimePolicyDigest(row.execution_spec),
        },
      };
      // Entire tree shares these immutable admission limits. For subscriptions,
      // token capacities are observed thresholds, not remote output guarantees:
      // actual overage is durably recorded by settleUsage and cancels the root.
      const budgets: RuntimeBudgetLimit[] = [
        { metric: 'model_calls', unit: 'calls', capacity: 16 },
        { metric: 'tool_calls', unit: 'calls', capacity: 64 },
        {
          metric: 'input_tokens',
          unit: 'tokens',
          capacity: inputCapacity,
        },
        { metric: 'output_tokens', unit: 'tokens', capacity: outputCapacity },
      ].map((budget) => ({
        ...budget,
        currency: null,
        source: {
          kind: 'worker',
          sourceId: subscriptionSnapshot
            ? 'assistant-subscription-v1'
            : 'assistant-v1',
        },
      })) as RuntimeBudgetLimit[];
      const ledger = createRuntimeOperationLedger({
        database: db,
        admission: async () => {
          throw Error('assistant_operation_authority_required');
        },
      });
      await ledger.createRoot({
        task,
        deadlineAt: row.timeout_at.toISOString(),
        budgets,
      });
      await runtime.configureRoot({
        task,
        configuration,
        nativeSessionId,
        worker,
        allowedTools,
      });
      const pricing = priceSnapshot
        ? createAssistantPricing({ database: db })
        : undefined;
      const priceIdentity = {
        scope: task.scope,
        rootRunId: task.rootRunId,
        worker,
      };
      const frozenPrice =
        pricing && priceSnapshot
          ? await pricing.freeze({ ...priceIdentity, snapshot: priceSnapshot })
          : undefined;
      // Explicit finite queries only. A read_only label does not make a root-
      // owned Browser/Bridge operation cancelable as a child operation.
      const readOnlyTools = new Set([
        'workspace.skill.read',
        'workspace.document.read',
        'workspace.memory.search',
        'workspace.session.search',
        'web.search',
      ]);
      const wireNames = Object.fromEntries(
        allRiceToolManifest.flatMap((tool) =>
          'dshWireName' in tool ? [[tool.canonicalName, tool.dshWireName]] : [],
        ),
      );
      const bridge = createAssistantWorkerBridge({
        runtime,
        task,
        worker,
        context,
        wireNames,
        readOnlyTools,
        beforeModelDispatch: subscriptionSnapshot
          ? async () => {
              const [status] = await db<{ subscription_quota: unknown }[]>`
                select subscription_quota from allrice_provider_status where provider='codex'`;
              assertSubscriptionQuotaNotExhausted(status?.subscription_quota);
            }
          : undefined,
        supportedChildTools: new Set([
          ...readOnlyTools,
          'assistant.delegate',
          'assistant.message',
          'assistant.report',
          'assistant.stop',
          'assistant.development',
          'local.process.execute',
        ]),
        proposalTools: new Set(['local.process.execute']),
        onRootTool: onToolCall,
        onDevelopment: input.storage
          ? ({ transaction, ...request }) =>
              runtime.development.workflow(
                {
                  scope: task.scope,
                  rootRunId: task.rootRunId,
                  worker,
                  context: input.context,
                  ...request,
                },
                input.storage!,
                transaction,
              )
          : undefined,
        onModelUsage:
          pricing && frozenPrice
            ? async (usage) => {
                await pricing.recordUsage({
                  ...priceIdentity,
                  ...usage,
                  snapshotDigest: frozenPrice.snapshotDigest,
                });
              }
            : undefined,
        onReadTool: onToolCall ? (call) => onToolCall(call) : undefined,
        onProposal: async (call, childRunId) => {
          if (call.name !== 'local.process.execute')
            throw Error('assistant_proposal_unavailable');
          const created = await createLocalCommandOperation(
            {
              context: input.context,
              callId: call.id,
              arguments: call.arguments,
              assistant: { runId: childRunId, worker },
              storage: input.storage,
            },
            db,
          );
          const result = await waitLocalCommandOperation(
            created,
            input.signal,
            db,
          );
          return {
            modelContent: JSON.stringify(result),
            summary: `Governed assistant command: ${result.status}`,
          };
        },
        onPublishOutput: input.storage
          ? ({ childRunId, deliveryId, output }) =>
              publishAssistantOutput(
                {
                  context: input.context,
                  assistant: { runId: childRunId, worker },
                  deliveryId,
                  output,
                },
                { database: db, storage: input.storage! },
              )
          : undefined,
      });
      return {
        ...bridge,
        finish: async () => {
          // The adapter joins/stops native loops first. Read receipts while the
          // worker is still live, then let finalization verify the durable tree.
          const costs = await pricing?.summarize(priceIdentity);
          const outcome = await runtime.finalizeRoot({
            scope: task.scope,
            rootRunId: task.rootRunId,
            worker,
          });
          if (subscriptionSnapshotDigest)
            return {
              ...outcome,
              billingMode: 'subscription' as const,
              costBasis: 'not_applicable' as const,
              costEstimateAvailable: false,
              estimatedCostCents: null,
              subscriptionSnapshotDigest,
              actualCostKnown: false as const,
            };
          if (!costs) return outcome;
          const known =
            outcome.usageComplete &&
            costs.usageComplete &&
            costs.costBasis === 'conservative_upper_bound' &&
            costs.costCentsDecimal !== null;
          return {
            ...outcome,
            costEstimateAvailable: known,
            estimatedCostCents: known ? Number(costs.costCentsDecimal) : null,
            costBasis: known
              ? ('conservative_upper_bound' as const)
              : ('unknown' as const),
            priceSnapshotDigest: costs.snapshotDigest,
            costCurrency: costs.currency,
            actualCostKnown: false as const,
            cacheUsageKnown: false,
          };
        },
        cancel: async () => {
          await runtime.cancelRoot(context, {
            runId: task.runId,
            requestId: randomUUID(),
          });
        },
      };
    },
  };
}
