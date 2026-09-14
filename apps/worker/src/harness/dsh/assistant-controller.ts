import { randomUUID } from 'node:crypto';
import {
  AssistantRunConfigurationSchema,
  ModelRunLimitsSchema,
  allRiceToolManifest,
  type ExecutionContext,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import {
  assistantRuntimeEnabled,
  createAssistantRuntime,
  createRuntimeOperationLedger,
  getDatabase,
  runtimePolicyDigest,
  type AssistantAuthorityInput,
  type AssistantWorkerLease,
  type RuntimeBudgetLimit,
} from '@allrice/database';
import type { HarnessExecutionInput } from '../adapter.js';
import { createAssistantWorkerBridge } from './assistant-bridge.js';

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
}): HarnessExecutionInput['assistants'] {
  if (input.configuration === undefined) return undefined;
  const configuration = AssistantRunConfigurationSchema.parse(
    input.configuration,
  );
  if (!configuration.allowAssistants) return undefined;
  if (!assistantRuntimeEnabled()) throw Error('assistant_runtime_disabled');
  const limits = ModelRunLimitsSchema.parse(input.runLimits ?? {});
  // No guessed currency/pricing authority. A cost-limited route is unavailable
  // until a frozen, authoritative price bound is supplied by that route.
  if (limits.maxCostCents !== null)
    throw Error('assistant_cost_bound_unavailable');
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
    maxOutputTokens: Math.max(
      1,
      Math.floor(
        Math.min(limits.maxOutputTokens, limits.maxTotalTokens - 1) /
          (configuration.maxConcurrent + 1),
      ),
    ),
    async bind(nativeSessionId, generation, onToolCall) {
      const [row] = await db<
        {
          execution_spec: unknown;
          employee_version_id: string;
          session_id: string;
          timeout_at: Date;
          configuration: unknown;
          project_id: string | null;
        }[]
      >`
        select r.execution_spec,r.project_id,e.employee_version_id,e.session_id,j.timeout_at,r.input->'assistantConfiguration' as configuration
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
      const worker = { ...input.worker, generation };
      // Entire tree shares these immutable limits; no child receives a fresh cap.
      // Input+output capacities together never exceed the frozen total cap.
      const output = Math.min(
        limits.maxOutputTokens,
        limits.maxTotalTokens - 1,
      );
      const budgets: RuntimeBudgetLimit[] = [
        { metric: 'model_calls', unit: 'calls', capacity: 16 },
        { metric: 'tool_calls', unit: 'calls', capacity: 64 },
        {
          metric: 'input_tokens',
          unit: 'tokens',
          capacity: Math.min(
            limits.maxInputTokens,
            limits.maxTotalTokens - output,
          ),
        },
        { metric: 'output_tokens', unit: 'tokens', capacity: output },
      ].map((budget) => ({
        ...budget,
        currency: null,
        source: { kind: 'worker', sourceId: 'assistant-v1' },
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
      const readOnlyTools = new Set(
        allRiceToolManifest
          .filter(
            (tool) =>
              tool.risk === 'read_only' &&
              tool.transport === 'dsh_broker_native',
          )
          .map((tool) => tool.canonicalName),
      );
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
        proposalTools: new Set(['local.process.execute']),
        onRootTool: onToolCall,
        onReadTool: onToolCall ? (call) => onToolCall(call) : undefined,
      });
      return {
        ...bridge,
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
