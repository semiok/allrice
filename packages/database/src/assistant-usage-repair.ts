import { z } from 'zod';
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { isPlatformAdmin } from './providers/model-pool.ts';
import { runtimeLedgerInputDigest } from './runtime-ledger/ledger.ts';

function requireEvidence(value: unknown): asserts value {
  if (!value) throw Error('assistant_usage_repair_not_proven');
}

/** Narrow operator repair for the MET-144 pre-dispatch failure regression.
 * Not an ordinary outcome writer or a quota exception. Only a terminal,
 * confirmed-stopped root WITHOUT children or external operations is eligible.
 * The old receipt is retained in audit; missing dispatched receipts stay unknown.
 * Dry-run is the default; commit must bind the exact independently inspected
 * evidence digest. No task is restarted and no failed result becomes success. */
export async function repairStoppedAssistantUsage(
  input: {
    context: RequestContext;
    runId: string;
    decisionId: string;
    expectedEvidenceDigest?: string;
  },
  db = getDatabase(),
) {
  z.uuid().parse(input.runId);
  z.uuid().parse(input.decisionId);
  if (input.expectedEvidenceDigest)
    z.string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(input.expectedEvidenceDigest);
  return db.begin(async (tx) => {
    requireEvidence(await isPlatformAdmin(input.context, tx));
    await tx`select pg_advisory_xact_lock(hashtext(${`tenant:${input.context.organizationId.toLowerCase()}`}))`;
    const [root] = await tx`
      select r.root_run_id,r.cancel_requested_at,a.worker_job_id,a.created_at
      from allrice_runtime_roots r join allrice_assistant_roots a using(root_run_id)
      where r.root_run_id=${input.runId} and r.organization_id=${input.context.organizationId} and r.workspace_id=${input.context.workspaceId!}
      for update of r,a`;
    requireEvidence(root?.cancel_requested_at);
    const [run] =
      await tx`select state from allrice_runs where id=${input.runId} for update`;
    const jobs =
      await tx`select id,status from allrice_jobs where run_id=${input.runId} for update`;
    requireEvidence(
      run?.state === 'failed' &&
        jobs.some((j) => j.id === root.worker_job_id) &&
        jobs.every((j) =>
          ['failed', 'canceled', 'succeeded'].includes(j.status),
        ),
    );
    const instances =
      await tx`select run_id,status,cancel_requested_at,stopped_at from allrice_assistant_instances where root_run_id=${input.runId} for update`;
    requireEvidence(
      instances.length === 1 &&
        instances[0]!.run_id === input.runId &&
        instances[0]!.status === 'canceled' &&
        instances[0]!.cancel_requested_at &&
        instances[0]!.stopped_at,
    );
    const [operation] =
      await tx`select 1 from allrice_runtime_operations where root_run_id=${input.runId} union all select 1 from allrice_runtime_reservations where root_run_id=${input.runId} limit 1`;
    requireEvidence(!operation);
    const [decision] = await tx`
      select d.id,d.status,d.attempt,d.input_tokens,d.output_tokens,d.cached_input_tokens,d.usage_complete,d.cache_usage_known,d.cost_cents,d.created_at,d.completed_at
      from allrice_route_decisions d where d.id=${input.decisionId} and d.run_id=${input.runId}
      and d.organization_id=${input.context.organizationId} and d.workspace_id=${input.context.workspaceId!}
      and exists(select 1 from allrice_route_subscription_snapshots s where s.route_decision_id=d.id)
      for update of d`;
    requireEvidence(
      decision?.status === 'failed' &&
        decision.attempt === 1 &&
        !decision.usage_complete &&
        decision.cost_cents === null &&
        decision.completed_at,
    );
    const [ledger] =
      await tx`select * from allrice_model_usage_ledger where route_decision_id=${input.decisionId} for update`;
    requireEvidence(
      ledger &&
        ledger.organization_id === input.context.organizationId &&
        ledger.workspace_id === input.context.workspaceId &&
        ledger.status === 'failed' &&
        !ledger.usage_complete &&
        !ledger.cache_usage_known &&
        ledger.cost_cents === null &&
        ledger.cached_input_tokens === 0,
    );
    const admissions =
      await tx`select call_id,run_id,requested_output_tokens,granted_output_tokens,input_tokens,request_digest,prepared_at,dispatched_at,finished_at from allrice_assistant_model_admissions where root_run_id=${input.runId} order by call_id limit 1025 for update`;
    const usage =
      await tx`select call_id,run_id,metric,amount,settled_amount from allrice_assistant_usage where root_run_id=${input.runId} order by call_id,metric limit 4097 for update`;
    const budgets =
      await tx`select metric,capacity,reserved,spent from allrice_runtime_budgets where root_run_id=${input.runId} order by metric for update`;
    requireEvidence(
      admissions.length > 0 &&
        admissions.length < 1025 &&
        usage.length < 4097 &&
        budgets.length === 4,
    );
    const unused = new Set<string>();
    for (const call of admissions) {
      requireEvidence(
        call.run_id === input.runId &&
          call.prepared_at >= decision.created_at &&
          call.prepared_at <= instances[0]!.stopped_at &&
          instances[0]!.stopped_at <= decision.completed_at,
      );
      const rows = usage.filter((u) => u.call_id === call.call_id);
      requireEvidence(
        rows.length === 4 && rows.every((u) => u.run_id === input.runId),
      );
      const value = (metric: string) => rows.find((u) => u.metric === metric);
      if (call.dispatched_at) {
        requireEvidence(
          call.finished_at &&
            call.finished_at <= decision.completed_at &&
            rows.every((u) => u.settled_amount !== null) &&
            Number(value('model_calls')?.settled_amount) === 1 &&
            Number(value('tool_calls')?.settled_amount) === 0,
        );
      } else {
        requireEvidence(
          call.finished_at === null &&
            call.input_tokens === null &&
            call.request_digest === null &&
            rows.every((u) => u.settled_amount === null) &&
            Number(value('model_calls')?.amount) === 1 &&
            Number(value('input_tokens')?.amount) === 0 &&
            Number(value('tool_calls')?.amount) === 0 &&
            Number(value('output_tokens')?.amount) ===
              Number(call.granted_output_tokens),
        );
        unused.add(call.call_id);
      }
    }
    // Never manufacture a zero for a legacy call, tool result or sent request.
    requireEvidence(
      unused.size > 0 &&
        usage.every(
          (u) =>
            u.run_id === input.runId &&
            (u.settled_amount !== null || unused.has(u.call_id)),
        ),
    );
    const totals: Record<string, number> = {};
    for (const budget of budgets) {
      requireEvidence(
        ['model_calls', 'tool_calls', 'input_tokens', 'output_tokens'].includes(
          budget.metric,
        ),
      );
      const rows = usage.filter((u) => u.metric === budget.metric);
      const spent = rows.reduce(
        (sum, u) => sum + Number(u.settled_amount ?? 0),
        0,
      );
      const reserved = rows.reduce(
        (sum, u) => sum + (u.settled_amount === null ? Number(u.amount) : 0),
        0,
      );
      requireEvidence(
        Number.isSafeInteger(spent) &&
          Number.isSafeInteger(reserved) &&
          Number(budget.spent) === spent &&
          Number(budget.reserved) === reserved,
      );
      totals[budget.metric] = spent;
    }
    requireEvidence(
      ledger.input_tokens <= totals.input_tokens! &&
        ledger.output_tokens <= totals.output_tokens! &&
        decision.input_tokens <= totals.input_tokens! &&
        decision.output_tokens <= totals.output_tokens! &&
        decision.cached_input_tokens === 0 &&
        !decision.cache_usage_known,
    );
    const evidence = {
      root,
      run,
      jobs,
      instances,
      decision,
      ledger,
      admissions,
      usage,
      budgets,
    };
    const evidenceDigest = runtimeLedgerInputDigest(
      JSON.parse(JSON.stringify(evidence)),
    );
    const result = {
      runId: input.runId,
      decisionId: input.decisionId,
      evidenceDigest,
      unusedCalls: unused.size,
      usage: {
        inputTokens: totals.input_tokens!,
        outputTokens: totals.output_tokens!,
        cachedInputTokens: 0,
      },
      cacheUsageKnown: false,
      usageComplete: true,
    };
    if (!input.expectedEvidenceDigest) return { ...result, applied: false };
    if (input.expectedEvidenceDigest !== evidenceDigest)
      throw Error('assistant_usage_repair_evidence_changed');
    for (const callId of unused)
      await tx`update allrice_assistant_usage set settled_amount=0 where root_run_id=${input.runId} and call_id=${callId} and settled_amount is null`;
    for (const budget of budgets)
      await tx`update allrice_runtime_budgets set reserved=0 where root_run_id=${input.runId} and metric=${budget.metric}`;
    await tx`update allrice_route_decisions set input_tokens=${result.usage.inputTokens},output_tokens=${result.usage.outputTokens},usage_complete=true where id=${input.decisionId}`;
    await tx`update allrice_model_usage_ledger set input_tokens=${result.usage.inputTokens},output_tokens=${result.usage.outputTokens},usage_complete=true where route_decision_id=${input.decisionId}`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${input.context.organizationId},${input.context.workspaceId!},${input.context.actor.id},'model_usage.assistant_reconciliation','route_decision',${input.decisionId},'recorded','confirmed_stopped_undispatched_preparation',${input.context.requestId},${tx.json(JSON.parse(JSON.stringify({ before: evidence, after: result, taskStillFailed: true, quotaUnchanged: true })))})`;
    return { ...result, applied: true };
  });
}
