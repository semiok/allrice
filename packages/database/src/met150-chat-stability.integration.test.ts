import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  RouteDecisionSchema,
  resolveAssistantSubscriptionSnapshot,
} from '@allrice/contracts';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  recordRouteDecision,
  completeRouteDecision,
} from './execution/route-decision.ts';
import { freezeRouteSubscriptionSnapshot } from './execution/route-subscription.ts';
import { appendJobEvent, failJob, completeJob } from './execution/queue.ts';
import { completedBudgetAnswers } from './workspace/budget-answer.ts';
import { getChatSessionHistory } from './workspace/service.ts';
import { boundToolResult } from '../../../apps/worker/src/tool-broker/result-budget.ts';
import { readWorkspaceFile } from '../../../apps/worker/src/tool-broker/handlers/workspace.ts';
import type { RiceToolExecutionInput } from '../../../apps/worker/src/tool-broker/types.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'MET-150 isolated database and full-result storage',
  { timeout: 60_000 },
  () => {
    beforeEach(() => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    });
    afterEach(() => vi.unstubAllEnvs());
    it.each([1, 0])(
      'uses only the current attempt diagnosis for a masked disconnect (%s)',
      async (attempt) => {
        const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
        try {
          const task = await f.prepareOrdinaryTask(
            'Synthetic masked disconnect; no model call.',
          );
          await appendJobEvent({
            ...task.workflowLease,
            type: 'turn.failed',
            payload: {
              attempt,
              threadId: 'dsh-root',
              assistantDiagnostics: {
                version: 1,
                truncated: false,
                failures: [
                  {
                    nativeSessionId: 'dsh-root',
                    callId: randomUUID(),
                    phase: 'finish',
                    code: 'TRANSPORT',
                    stopKind: 'error',
                    inputUsageKnown: false,
                    outputUsageKnown: false,
                    settlementConfirmed: true,
                  },
                ],
              },
            },
          });
          expect(
            await failJob({
              ...task.workflowLease,
              code: 'DSH_UNKNOWN',
              message: 'assistant_model_unknown_no_replay',
              retryable: false,
            }),
          ).toEqual({ retrying: false });
          const [message] =
            await f.db`select m.content,m.error_code,j.attempt,j.status
          from allrice_employee_runs e join allrice_messages m on m.id=e.assistant_message_id
          join allrice_jobs j on j.run_id=e.run_id where e.run_id=${task.runId}`;
          expect(message).toMatchObject({
            error_code: 'DSH_UNKNOWN',
            attempt: 1,
            status: 'failed',
          });
          expect(message!.content.text).toContain(
            attempt === 1 ? '模型连接中断' : 'Rice 暂时无法完成',
          );
        } finally {
          await f.close();
        }
      },
    );
    it('settles a model disconnect once and retains completed output and tool evidence', async () => {
      const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      try {
        const task = await f.prepareOrdinaryTask(
          'Synthetic disconnect; no model call.',
        );
        const [run] =
          await f.db`select assistant_message_id from allrice_employee_runs where run_id=${task.runId}`;
        await appendJobEvent({
          ...task.workflowLease,
          type: 'tool.completed',
          payload: {
            name: 'cloud.mcp.call',
            toolCallId: 'read-once',
            attempt: 1,
            summary: '已读取 CI 状态',
          },
        });
        await appendJobEvent({
          ...task.workflowLease,
          type: 'assistant.text.completed',
          payload: {
            text: '已查到两项 CI 失败。',
            messageId: run!.assistant_message_id,
            attempt: 1,
            nativePayload: { interrupted: false, contentTypes: ['text'] },
          },
        });
        expect(
          await failJob({
            ...task.workflowLease,
            code: 'DSH_TRANSPORT',
            message: 'Synthetic model disconnect',
            retryable: false,
          }),
        ).toEqual({ retrying: false });
        const [job] =
          await f.db`select status,attempt,last_error_code from allrice_jobs where run_id=${task.runId}`;
        expect(job).toMatchObject({
          status: 'failed',
          attempt: 1,
          last_error_code: 'DSH_TRANSPORT',
        });
        const [message] =
          await f.db`select content,status,error_code from allrice_messages where id=${run!.assistant_message_id}`;
        expect(message).toMatchObject({
          status: 'failed',
          error_code: 'DSH_TRANSPORT',
          content: { text: '已查到两项 CI 失败。' },
        });
        const events =
          await f.db`select event_type from allrice_run_events where run_id=${task.runId}`;
        expect(
          events.filter((event) => event.event_type === 'tool.completed'),
        ).toHaveLength(1);
        expect(
          events.some((event) => event.event_type === 'run.retrying'),
        ).toBe(false);
      } finally {
        await f.close();
      }
    });
    it.each([
      'current',
      'old-attempt',
      'other-message',
      'fragment',
      'tool-progress',
    ])(
      'retains only a current whole native reply when settlement fails (%s)',
      async (kind) => {
        const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
        try {
          const task = await f.prepareOrdinaryTask(
            'Synthetic reply retention; no model call.',
          );
          const [run] =
            await f.db`select assistant_message_id from allrice_employee_runs where run_id=${task.runId}`;
          await appendJobEvent({
            ...task.workflowLease,
            type: 'assistant.text.delta',
            payload: {
              text: 'GitHub 正常；Linear 有 3 个项目。',
              messageId:
                kind === 'other-message'
                  ? randomUUID()
                  : run!.assistant_message_id,
              attempt: kind === 'old-attempt' ? 0 : 1,
              sourceEventType:
                kind === 'fragment' ? 'assistant/delta' : 'assistant/message',
              textMode: kind === 'fragment' ? 'append' : 'replace',
              nativePayload: {
                interrupted: false,
                contentTypes:
                  kind === 'tool-progress' ? ['text', 'tool-call'] : ['text'],
              },
            },
          });
          await failJob({
            ...task.workflowLease,
            code: 'ASSISTANT_EXECUTION_UNRESOLVED',
            message: 'Synthetic ledger failure',
            retryable: false,
          });
          const [message] =
            await f.db`select content,status,error_code from allrice_messages where id=${run!.assistant_message_id}`;
          expect(message).toMatchObject({
            status: 'failed',
            error_code: 'ASSISTANT_EXECUTION_UNRESOLVED',
          });
          expect(message!.content.text).toBe(
            kind === 'current'
              ? 'GitHub 正常；Linear 有 3 个项目。'
              : 'Rice 暂时无法完成这次请求，请稍后重试。',
          );
        } finally {
          await f.close();
        }
      },
    );
    it('recovers only identity-proven, complete, same-attempt historical answers without rewriting accounting', async () => {
      const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      try {
        const task = await f.prepareOrdinaryTask(
          'Synthetic budget result; no model call.',
        );
        const frozen = task.binding.executionSnapshot.modelSnapshot!;
        const decision = RouteDecisionSchema.parse({
          schemaVersion: 1,
          id: randomUUID(),
          runId: task.runId,
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          actorId: f.ownerId,
          employeeId: f.employeeId,
          inputChecksum: `sha256:${'a'.repeat(64)}`,
          candidates: [
            {
              id: 'direct:test',
              kind: 'direct',
              name: 'Test',
              bindingId: null,
              requiredCapabilities: [],
              risk: 'low',
              requiresApproval: false,
              authorized: true,
              exclusionReason: null,
              score: 1,
            },
          ],
          selectedKind: 'direct',
          selectedCandidateId: 'direct:test',
          harness: 'dsh',
          provider: 'openai-codex',
          model: frozen.model,
          modelConnectionId: f.connectionId,
          modelCatalogEntryId: f.catalogId,
          modelPolicyRevision: frozen.policyRevision,
          generation: 1,
          attempt: 1,
          reasonCodes: ['direct_no_capability_match'],
          createdAt: new Date().toISOString(),
        });
        await recordRouteDecision(decision, f.db);
        await freezeRouteSubscriptionSnapshot(
          {
            organizationId: f.organizationId,
            workspaceId: f.workspaceId,
            decisionId: decision.id,
            snapshot: resolveAssistantSubscriptionSnapshot({
              sessionId: task.sessionId,
              modelSnapshot: frozen,
              decision,
              providerSnapshot: {
                provider: 'dsh',
                route: 'openai-codex',
                authMode: 'platform_subscription',
                model: frozen.model,
                credentialReference: frozen.credentialReference!,
                baseUrl: null,
                reasoningEffort: frozen.reasoningEffort,
              },
            })!,
          },
          f.db,
        );
        const scope = {
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          ownerId: f.ownerId,
          sessionId: task.sessionId,
          runIds: [task.runId],
        };
        await appendJobEvent({
          ...task.workflowLease,
          type: 'assistant.text.completed',
          payload: {
            text: '已完整生成的答案',
            generation: 1,
            attempt: 1,
            turnId: 'turn-1',
          },
        });
        await appendJobEvent({
          ...task.workflowLease,
          type: 'turn.completed',
          payload: { generation: 1, turnId: 'turn-1' },
        });
        await completeRouteDecision(
          {
            organizationId: f.organizationId,
            workspaceId: f.workspaceId,
            outcome: {
              decisionId: decision.id,
              status: 'failed',
              inputTokens: 478964,
              cachedInputTokens: 377856,
              outputTokens: 10210,
              costCents: null,
              usageComplete: true,
              cacheUsageKnown: true,
              errorCode: 'MODEL_OUTPUT_BUDGET_EXCEEDED',
              completedAt: new Date().toISOString(),
            },
          },
          f.db,
        );
        await failJob({
          ...task.workflowLease,
          code: 'MODEL_OUTPUT_BUDGET_EXCEEDED',
          message: 'Legacy post-flight check',
          retryable: false,
        });
        const before =
          await f.db`select to_jsonb(l) as receipt from allrice_model_usage_ledger l where route_decision_id=${decision.id}`;
        expect(
          (await completedBudgetAnswers(scope, f.db)).get(task.runId),
        ).toBe('已完整生成的答案');
        const history = await getChatSessionHistory(
          f.context,
          f.workspaceId,
          task.sessionId,
        );
        expect(
          history.messages.find((m) => m.runId === task.runId),
        ).toMatchObject({
          status: 'failed',
          content: {
            text: '已完整生成的答案',
            budgetWarning: 'MODEL_OUTPUT_BUDGET_EXCEEDED',
          },
        });
        for (const patch of [
          { organizationId: randomUUID() },
          { workspaceId: randomUUID() },
          { ownerId: randomUUID() },
          { sessionId: randomUUID() },
        ])
          expect(
            (await completedBudgetAnswers({ ...scope, ...patch }, f.db)).size,
          ).toBe(0);
        await f.db`update allrice_jobs set attempt=2 where run_id=${task.runId}`;
        expect((await completedBudgetAnswers(scope, f.db)).size).toBe(0);
        await f.db`update allrice_jobs set attempt=1 where run_id=${task.runId}`;
        await f.db`update allrice_runs set error_code='MODEL_TOKEN_USAGE_UNKNOWN' where id=${task.runId}`;
        expect((await completedBudgetAnswers(scope, f.db)).size).toBe(0);
        expect(
          await f.db`select to_jsonb(l) as receipt from allrice_model_usage_ledger l where route_decision_id=${decision.id}`,
        ).toEqual(before);
      } finally {
        await f.close();
      }
    });
    it('persists a completed answer plus warning in the message and run completion event', async () => {
      const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      try {
        const task = await f.prepareOrdinaryTask('Synthetic warning delivery.');
        const result = {
          answer: '结果已交付',
          budgetWarning: {
            code: 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
            inputTokens: 478964,
            cachedInputTokens: 377856,
            outputTokens: 10210,
          },
        };
        await completeJob({ ...task.workflowLease, result });
        const history = await getChatSessionHistory(
          f.context,
          f.workspaceId,
          task.sessionId,
        );
        expect(
          history.messages.find((m) => m.runId === task.runId),
        ).toMatchObject({
          status: 'completed',
          content: {
            text: '结果已交付',
            budgetWarning: 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED',
          },
        });
        const [event] =
          await f.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='run.succeeded'`;
        expect(event!.payload.result).toEqual(result);
      } finally {
        await f.close();
      }
    });
    it('stores the exact full result, pages it, denies other tenants/owners, and reports storage failure truthfully', async () => {
      const f = await createP27CodexWorkerFixture({ allowCiDatabase: true });
      const storageRoot = await mkdtemp(join(tmpdir(), 'met150-result-'));
      try {
        const task = await f.prepareOrdinaryTask('Synthetic tool result.');
        const input: RiceToolExecutionInput = {
          context: task.execution.context,
          sessionId: task.sessionId,
          storageRoot,
          capabilities: ['network:outbound', 'storage:read'],
          call: { id: 'large-fixture', name: 'market.history', arguments: {} },
        };
        const original = JSON.stringify({
          source: 'fixture',
          points: Array.from({ length: 1000 }, (_, i) => ({
            index: i,
            close: i + 1,
            note: '中文数据'.repeat(10),
          })),
        });
        const bounded = await boundToolResult(input, {
          modelContent: original,
          summary: '1000 points',
          itemCount: 1000,
        });
        expect(bounded.modelContent.length).toBeLessThan(12000);
        const envelope = JSON.parse(bounded.modelContent);
        expect(envelope).toMatchObject({
          truncated: true,
          fullResultStored: true,
          originalCharacters: original.length,
        });
        const objectId = envelope.fullResult.objectId;
        let text = '',
          offset = 0;
        while (true) {
          const page = JSON.parse(
            (
              await readWorkspaceFile({
                input,
                arguments: { objectId, offset, limit: 4000 },
              })
            ).modelContent,
          );
          expect(page.content.length).toBeLessThanOrEqual(4000);
          text += page.content;
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        expect(text).toBe(original);
        for (const context of [
          { ...input.context, organizationId: randomUUID() },
          { ...input.context, workspaceId: randomUUID() },
          {
            ...input.context,
            policySnapshot: {
              ...input.context.policySnapshot,
              subjectId: randomUUID(),
              memberships: [],
              grants: [],
            },
          },
        ])
          await expect(
            readWorkspaceFile({
              input: { ...input, context },
              arguments: { objectId },
            }),
          ).rejects.toThrow();
        await expect(
          readWorkspaceFile({ input, arguments: { objectId, offset: -1 } }),
        ).rejects.toThrow();
        await expect(
          readWorkspaceFile({ input, arguments: { objectId, limit: 4001 } }),
        ).rejects.toThrow();
        await f.db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${f.organizationId},${f.workspaceId},1)
        on conflict(organization_id,workspace_id) do update set limit_bytes=1`;
        const refused = JSON.parse(
          (
            await boundToolResult(
              { ...input, call: { ...input.call, id: 'quota-failure' } },
              { modelContent: original, summary: 'fixture' },
            )
          ).modelContent,
        );
        expect(refused).toMatchObject({
          fullResultStored: false,
          unavailableReason: 'result_storage_unavailable',
        });
        expect(refused.fullResult).toBeUndefined();
      } finally {
        await f.close();
        await rm(storageRoot, { recursive: true, force: true });
      }
    });
  },
);
