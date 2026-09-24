/** Independent production native/PG admission tests. HTTP model replies and
 * query results are synthetic; this is NOT real-provider or external-data proof. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionContextSchema } from '../../../../packages/contracts/src/index.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { runtimePolicyDigest } from '../../../../packages/database/src/runtime-policy.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import type { HarnessToolCall } from '../../src/harness/adapter.js';
import { riceToolDefinitions } from '../../src/tool-broker.js';
import { HandlerError } from '../../src/errors.js';
import { p24Fixture } from '../p24/fixture.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const reads: {
  name: string;
  wire: string;
  args: Record<string, unknown>;
  brokerArgs?: Record<string, unknown>;
}[] = [
  {
    name: 'workspace.skill.read',
    wire: 'workspace_skill_read',
    args: { skill: 'synthetic-read', path: 'references/input.md' },
  },
  {
    name: 'workspace.document.read',
    wire: 'workspace_document_read',
    args: { objectId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
  },
  {
    name: 'workspace.memory.search',
    wire: 'workspace_memory_search',
    args: { query: 'synthetic scoped query' },
  },
  {
    name: 'workspace.session.search',
    wire: 'workspace_session_search',
    args: { query: 'synthetic scoped query' },
  },
  {
    name: 'web.search',
    wire: 'web_search',
    args: { queries: ['synthetic scoped query'] },
    brokerArgs: { query: 'synthetic scoped query', maxResults: 5 },
  },
];
const stableCallId = (childRunId: string, nativeCallId: string) => {
  const h = createHash('sha256')
    .update(`${childRunId}:${nativeCallId}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

integration(
  'P25 independent production native finite-query attribution',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });

    async function exercise(
      name: string,
      read?: (typeof reads)[number],
      recoverRoot = false,
    ) {
      const f = await createAssistantAuthorityFixture(database.db, {
        configure: false,
        allowedTools: ['assistant.delegate', 'assistant.report', name],
      });
      // Remove only this fixture's unused synthetic ledger, never rewrite a
      // frozen live root. The real production controller creates its own caps.
      await database.db.begin(async (tx) => {
        const admitted =
          await tx`select 1 from allrice_assistant_instances where root_run_id=${f.rootRunId}
        union all select 1 from allrice_assistant_usage where root_run_id=${f.rootRunId}
        union all select 1 from allrice_runtime_operations where root_run_id=${f.rootRunId}`;
        expect(admitted).toHaveLength(0);
        await tx`delete from allrice_runtime_budgets where root_run_id=${f.rootRunId}`;
        await tx`delete from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
        await tx`delete from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
      });
      const [policy] = await database.db<
        {
          payload: Record<string, unknown>;
          issued_at: Date;
          expires_at: Date;
        }[]
      >`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: f.context.actor,
        organizationId: f.org,
        workspaceId: f.workspace,
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
      });
      let delegated = false;
      const childRequests: string[] = [];
      const calls: HarnessToolCall[] = [];
      const events: { type: string }[] = [];
      const reply = {
        modelContent:
          'SYNTHETIC_QUERY_RESULT: finite scoped read; no external call',
        summary: 'Synthetic query only',
      };
      const model = await p24Fixture(async (request) => {
        const serialized = JSON.stringify(request.messages);
        if (serialized.includes('ROOT_PRIVATE_READ')) {
          if (recoverRoot) {
            if (calls.length < 2)
              return {
                nativeTool: { name: read!.wire, arguments: read!.args },
              };
            expect(serialized).toContain(
              'Synthetic query temporarily unavailable',
            );
            expect(serialized).toContain('SYNTHETIC_QUERY_RESULT');
            return {
              text: 'Recovered answer from the available query result.',
            };
          }
          if (!delegated) {
            delegated = true;
            return {
              nativeTool: {
                name: 'assistant_delegate',
                arguments: {
                  label: 'Bounded read',
                  text: 'CHILD_FINITE_QUERY: use the selected query once.',
                  tools: ['assistant.report', name],
                },
              },
            };
          }
          return {
            text: 'Root observed the bounded result or explicit denial.',
          };
        }
        childRequests.push(serialized);
        if (childRequests.length === 1 && read)
          return { nativeTool: { name: read.wire, arguments: read.args } };
        return {
          text: 'Child query consumed; no verified artifact is claimed.',
        };
      });
      vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(model.root, 'platform'));
      const adapter = new DshHarnessAdapter({
        runtimeRoot: join(model.root, 'production-runtime'),
        credentialResolver: {
          resolve: async () => ({ apiKey: 'synthetic-only' }),
        },
      });
      const tools = riceToolDefinitions.filter((tool) =>
        ['assistant.delegate', 'assistant.report', name].includes(tool.name),
      );
      expect(tools).toHaveLength(3);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 20000);
      try {
        const outcome = await adapter.execute({
          kernel: {
            schemaVersion: 1,
            harness: 'dsh',
            employeeAssignmentId: f.assignment,
            employeeVersionId: f.version,
            sessionId: f.session,
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            systemInstructions: 'Use the provided finite governed tools only.',
            userRequest: 'ROOT_PRIVATE_READ: delegate the bounded query.',
            bootstrapConversation: '',
            authorizedMemoryContext: '',
            grantedCapabilities: ['model:invoke'],
            skillVersionIds: [],
            imageAttachments: [],
          },
          providerSnapshot: {
            provider: 'dsh',
            authMode: 'allrice_credential',
            route: 'openai-compatible',
            model: 'p24-synthetic',
            reasoningEffort: 'none',
            credentialReference: 'test:synthetic',
            baseUrl: model.baseUrl,
          },
          storageObjects: [],
          workDirectory: model.root,
          executionEnvironment: {
            ALLRICE_ORGANIZATION_ID: f.org,
            ALLRICE_WORKSPACE_ID: f.workspace,
            ALLRICE_OWNER_ID: f.user,
          },
          signal: abort.signal,
          attempt: 1,
          generation: f.worker.generation,
          maxOutputTokens: 1000,
          threadId: `dsh-${f.session}`,
          tools,
          onEvent: async (event) => {
            events.push(event);
          },
          onToolCall: async (call) => {
            calls.push(call);
            if (recoverRoot && calls.length === 1)
              throw new HandlerError(
                'MARKET_DATA_NETWORK_ERROR',
                'Synthetic query temporarily unavailable',
                true,
              );
            return reply;
          },
          assistants: productionAssistantController({
            configuration: f.config,
            database: database.db,
            authorize: assertAssistantAuthority,
            worker: f.worker,
            tools,
            runLimits: { maxOutputTokens: 5000 },
            context,
          }),
        });
        return {
          f,
          calls,
          reply,
          outcome,
          childRequests,
          events,
          tree: await f.runtime.getTree(f.context, { runId: f.rootRunId }),
        };
      } finally {
        clearTimeout(timer);
        await adapter.close();
        await model.close();
      }
    }

    it.each([
      { name: 'market.quote', wire: 'market_quote', args: { symbol: 'BOTZ' } },
      {
        name: 'market.history',
        wire: 'market_history',
        args: { symbol: 'BOTZ', range: '1mo', interval: '1d' },
      },
      reads[4]!,
    ])(
      'delivers the native answer after a failed root $name query and a successful retry',
      async (read) => {
        const { f, calls, outcome, events, tree } = await exercise(
          read.name,
          read,
          true,
        );
        expect(calls).toHaveLength(2);
        expect(
          events.filter((event) => event.type === 'tool.failed'),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.type === 'tool.completed'),
        ).toHaveLength(1);
        expect(outcome).toMatchObject({
          answer: 'Recovered answer from the available query result.',
          assistantStatus: 'completed',
          usageComplete: true,
        });
        expect(tree.instances).toHaveLength(1);
        expect(tree.instances[0]?.status).toBe('completed');
        expect(tree.budgets.every((budget) => budget.reserved === 0)).toBe(
          true,
        );
        const rows =
          await database.db`select metric,settled_amount,result_digest from allrice_assistant_usage where call_id=${stableCallId(f.rootRunId, calls[0]!.id)}`;
        expect(rows).toHaveLength(4);
        for (const row of rows) {
          expect(Number(row.settled_amount)).toBe(
            row.metric === 'tool_calls' ? 1 : 0,
          );
          expect(row.result_digest).toBe(
            runtimePolicyDigest({
              outcome: 'failed',
              code: 'MARKET_DATA_NETWORK_ERROR',
            }),
          );
        }
      },
      45000,
    );

    it.each(reads)(
      'dispatches actual child $name and preserves exact native query attribution',
      async (read) => {
        const { f, calls, reply, outcome, childRequests, tree } =
          await exercise(read.name, read);
        const children = tree.instances.filter(
          (row) => row.parentRunId !== null,
        );
        expect(children).toHaveLength(1);
        const child = children[0]!;
        expect(child.allowedTools).toEqual(['assistant.report', read.name]);
        expect(childRequests).toHaveLength(2);
        expect(childRequests[1]).toContain('SYNTHETIC_QUERY_RESULT');
        expect(
          childRequests.every((value) => !value.includes('ROOT_PRIVATE_READ')),
        ).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          name: read.name,
          arguments: read.brokerArgs ?? read.args,
        });
        const rows = await database.db<
          {
            call_id: string;
            run_id: string;
            metric: string;
            settled_amount: string | null;
            native_call_id: string;
            tool_name: string;
            arguments_digest: string;
            result_digest: string;
          }[]
        >`select * from allrice_assistant_usage where root_run_id=${f.rootRunId} and call_id=${stableCallId(child.runId, calls[0]!.id)}`;
        expect(rows).toHaveLength(4);
        for (const row of rows) {
          expect(row).toMatchObject({
            run_id: child.runId,
            native_call_id: calls[0]!.id,
            tool_name: read.name,
            arguments_digest: runtimePolicyDigest(calls[0]!.arguments),
            result_digest: runtimePolicyDigest(reply),
          });
          expect(Number(row.settled_amount)).toBe(
            row.metric === 'tool_calls' ? 1 : 0,
          );
        }
        expect(tree.results).toHaveLength(1);
        expect(tree.results[0]).toMatchObject({
          status: 'partial',
          usageComplete: true,
        });
        expect(tree.results[0]!.evidence).toEqual([]);
        expect(tree.budgets.every((row) => row.reserved === 0)).toBe(true);
        expect(
          tree.instances.find((row) => row.runId === f.rootRunId),
        ).toMatchObject({ status: 'partial', stoppedAt: expect.any(String) });
        expect(outcome).toMatchObject({
          assistantStatus: 'partial',
          usageComplete: true,
          cacheUsageKnown: false,
          costEstimateAvailable: false,
        });
        expect(outcome.answer).toMatch(/^部分结果/);
        expect(outcome.usage).toEqual({
          inputTokens: tree.budgets.find(
            (row) => row.metric === 'input_tokens',
          )!.spent,
          cachedInputTokens: 0,
          outputTokens: tree.budgets.find(
            (row) => row.metric === 'output_tokens',
          )!.spent,
        });
      },
      45000,
    );

    it.each(['browser.run', 'local.fs.read'])(
      'rejects unsupported child %s before provisioning a Run or native child',
      async (name) => {
        const { f, calls, childRequests, tree } = await exercise(name);
        expect(tree.instances).toHaveLength(1);
        expect(tree.messages).toEqual([]);
        expect(tree.results).toEqual([]);
        expect(calls).toEqual([]);
        expect(childRequests).toEqual([]);
        const children =
          await database.db`select run_id from allrice_runtime_run_links where root_run_id=${f.rootRunId} and run_id<>${f.rootRunId}`;
        expect(children).toEqual([]);
      },
      45000,
    );
  },
);
