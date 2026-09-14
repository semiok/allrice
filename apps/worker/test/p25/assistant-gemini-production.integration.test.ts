import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalStorageAdapter } from '../../../../packages/storage/src/index.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { getWorkbenchArtifact } from '../../../../packages/database/src/artifact-review.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';
import { getAssistantFailureDiagnostics } from '../../src/harness/dsh/assistant-diagnostics.js';
import {
  correlateP27AssistantDiagnostics,
  type P27DiagnosticAdmission,
  type P27DiagnosticReceipt,
} from '../../../../scripts/acceptance/runtime/p27-assistant-diagnostics.ts';
import type { HarnessExecutionInput } from '../../src/harness/adapter.js';
import { gate } from '../p24/fixture.js';
import { syntheticAssistantPriceSnapshot } from './assistant-pricing.fixture.js';

type GeminiRequest = {
  contents: unknown[];
  generationConfig: { maxOutputTokens: number };
  tools?: unknown[];
};
type GeminiReply = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  usage?: {
    input: number;
    cached: number;
    output: number;
    thinking: number;
  } | null;
  status?: number;
};

/** Actual restricted DSH + pinned Google SDK, but explicitly synthetic HTTP.
 * No Google requests, real credentials, normal browser profiles or tenant flags.
 * A rejecting proxy catches a wrongly resolved remote endpoint. */
async function geminiEndpoint(
  respond: (request: GeminiRequest) => Promise<GeminiReply>,
) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p25-gemini-tree-'));
  const requests: GeminiRequest[] = [],
    aborted: GeminiRequest[] = [];
  let egressAttempts = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_000_000) throw Error('synthetic_request_limit');
        chunks.push(Buffer.from(chunk));
      }
      if (
        req.method !== 'POST' ||
        req.url !==
          '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse' ||
        req.headers['x-goog-api-key'] !== 'synthetic-gemini-not-live'
      )
        throw Error('synthetic_endpoint_mismatch');
      const request = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as GeminiRequest;
      requests.push(request);
      res.on('close', () => {
        if (!res.writableFinished) aborted.push(request);
      });
      if (requests.length > 16) throw Error('synthetic_call_limit');
      const reply = await respond(request);
      if (res.destroyed) return;
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: reply.status, message: 'SYNTHETIC_FAILURE' },
          }),
        );
        return;
      }
      const usage =
        reply.usage === undefined
          ? { input: 20, cached: 4, output: 121, thinking: 2 }
          : reply.usage;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          candidates: [
            {
              index: 0,
              content: {
                role: 'model',
                parts: [
                  reply.functionCall
                    ? {
                        functionCall: {
                          id: `synthetic-${randomUUID()}`,
                          ...reply.functionCall,
                        },
                        thoughtSignature: 'c3ludGhldGljLXRlc3Qtb25seQ==',
                      }
                    : { text: reply.text ?? 'SYNTHETIC_ROOT_RESULT' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          ...(usage === null
            ? {}
            : {
                usageMetadata: {
                  promptTokenCount: usage.input,
                  cachedContentTokenCount: usage.cached,
                  candidatesTokenCount: usage.output,
                  thoughtsTokenCount: usage.thinking,
                  totalTokenCount: usage.input + usage.output + usage.thinking,
                },
              }),
          modelVersion: 'gemini-3.8-flash',
          responseId: `synthetic-never-google-${requests.length}`,
        })}\n\n`,
      );
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  const proxy = createServer((_req, res) => {
    egressAttempts++;
    res.writeHead(403).end();
  });
  proxy.on('connect', (_req, socket) => {
    egressAttempts++;
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  let configRoot: string | undefined;
  let adapter: DshHarnessAdapter | undefined;
  async function close() {
    await adapter?.close();
    server.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all(
      [server, proxy].map(
        (s) => new Promise<void>((done) => s.close(() => done())),
      ),
    );
    if (configRoot) await rm(configRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
  try {
    server.listen(0, '127.0.0.1');
    proxy.listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(proxy, 'listening')]);
    const address = server.address() as { port: number };
    const proxyAddress = proxy.address() as { port: number };
    const source = await readFile(
      resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
      'utf8',
    );
    expect(source.split('      google:\n')).toHaveLength(2);
    const parent = resolve(import.meta.dirname, '../../.local');
    await mkdir(parent, { recursive: true });
    configRoot = await mkdtemp(join(parent, 'gemini-tree-'));
    const config = join(configRoot, 'loopback.cordis.yml');
    await writeFile(
      config,
      source.replace(
        '      google:\n',
        `      google:\n        baseURL: "http://127.0.0.1:${address.port}/v1beta"\n`,
      ),
      { mode: 0o600 },
    );
    vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', join(root, 'platform'));
    vi.stubEnv(
      'ALLRICE_DSH_HTTP_PROXY',
      `http://127.0.0.1:${proxyAddress.port}`,
    );
    vi.stubEnv(
      'ALLRICE_DSH_HTTPS_PROXY',
      `http://127.0.0.1:${proxyAddress.port}`,
    );
    vi.stubEnv('ALLRICE_DSH_NO_PROXY', '127.0.0.1,localhost');
    adapter = new DshHarnessAdapter({
      runtimeRoot: join(root, 'runtime'),
      cordisConfig: config,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-gemini-not-live' }),
      },
    });
    return {
      root,
      requests,
      aborted,
      adapter,
      close,
      egressAttempts: () => egressAttempts,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'Gemini parent/children: production native + isolated PG + synthetic Google HTTP',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });

    it.each([
      'dynamic_output',
      'missing_child_usage',
      'revoked',
      'dispatch_error',
      'ordinary_retry',
      'priced_dynamic_output',
      'priced_missing_child_usage',
      'priced_dispatch_error',
      'priced_child_dispatch_error',
      'priced_budget_denied',
      'priced_wrong_model',
      'priced_expiring',
      'priced_wrong_currency',
    ] as const)(
      '%s keeps wire limits, durable state and provider identity honest',
      async (scenario) => {
        const priced = scenario.startsWith('priced_');
        const behavior = scenario.replace(/^priced_/, '');
        const f = await createAssistantAuthorityFixture(database.db, {
          configure: false,
          allowedTools: ['assistant.delegate', 'assistant.report'],
          runtimePolicy: {
            harness: 'dsh',
            provider: 'gemini',
            model: 'gemini-3.8-flash',
            reasoningEffort: 'low',
            timeoutMs: 300000,
            fallbackModels: [],
            credentialReference: 'test:synthetic-gemini',
            baseUrl: null,
          },
        });
        f.config.maxConcurrent = 2;
        await database.db.begin(async (tx) => {
          await tx`update allrice_runs set input=jsonb_set(input,'{assistantConfiguration}',${tx.json(f.config)}) where id=${f.rootRunId}`;
          await tx`delete from allrice_runtime_budgets where root_run_id=${f.rootRunId}`;
          await tx`delete from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
          await tx`delete from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
        });
        const overlap = gate();
        let active = 0,
          maxActive = 0;
        const model = await geminiEndpoint(async (request) => {
          if (behavior === 'dispatch_error' || behavior === 'ordinary_retry')
            return { status: 503 };
          const content = JSON.stringify(request.contents);
          if (!content.includes('ROOT_PRIVATE')) {
            active++;
            maxActive = Math.max(maxActive, active);
            await overlap.promise;
            active--;
            if (
              behavior === 'child_dispatch_error' &&
              content.includes('ANALYZE_B')
            )
              return { status: 503 };
            return {
              usage:
                behavior === 'missing_child_usage'
                  ? null
                  : { input: 1000, cached: 900, output: 5, thinking: 2 },
              functionCall: {
                name: 'assistant_report',
                args: {
                  status: 'completed',
                  summary: 'Synthetic Gemini child result',
                  evidence: [],
                  incomplete: [],
                  output: {
                    name: 'report',
                    content: JSON.stringify({
                      result: content.includes('ANALYZE_A') ? 'A' : 'B',
                    }),
                  },
                },
              },
            };
          }
          for (const label of ['A', 'B']) {
            if (!content.includes(`ANALYZE_${label}`))
              return {
                functionCall: {
                  name: 'assistant_delegate',
                  args: {
                    label,
                    text: `ANALYZE_${label}`,
                    tools: ['assistant.report'],
                  },
                },
              };
          }
          return { text: 'SYNTHETIC_ROOT_RESULT' };
        });
        const storage = new LocalStorageAdapter(join(model.root, 'outputs'));
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 30000);
        try {
          const [frozen] =
            await database.db`select provider_snapshot from allrice_employee_runs where run_id=${f.rootRunId}`;
          expect(frozen!.provider_snapshot).toMatchObject({
            provider: 'dsh',
            route: 'gemini',
            model: 'gemini-3.8-flash',
          });
          const priceSnapshot = priced
            ? syntheticAssistantPriceSnapshot()
            : undefined;
          if (behavior === 'wrong_model')
            priceSnapshot!.price.target.model = 'synthetic-other-model';
          if (behavior === 'wrong_currency')
            priceSnapshot!.price.currency = 'CNY';
          if (behavior === 'expiring')
            priceSnapshot!.price.expiresAt = new Date(
              Date.now() + 1000,
            ).toISOString();
          const makeController = () =>
            productionAssistantController({
              ...(priceSnapshot ? { priceSnapshot } : {}),
              configuration: f.config,
              database: database.db,
              authorize: assertAssistantAuthority,
              storage,
              worker: f.worker,
              tools: [
                { name: 'assistant.delegate' },
                { name: 'assistant.report' },
              ],
              runLimits: {
                maxOutputTokens: 12000,
                // Synthetic root bound is 64.8 cents: 64 is insufficient, 65 fits.
                ...(priced
                  ? { maxCostCents: behavior === 'budget_denied' ? 64 : 65 }
                  : {}),
              },
              context: {
                executionId: randomUUID(),
                runId: f.rootRunId,
                jobId: f.worker.jobId,
                worker: { type: 'worker', id: f.worker.workerId },
                delegatedBy: { type: 'user', id: f.user },
                organizationId: f.org,
                workspaceId: f.workspace,
                startedAt: new Date().toISOString(),
                policySnapshot: {
                  id: f.policy,
                  organizationId: f.org,
                  subjectId: f.user,
                  version: 1,
                  issuedAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                  memberships: f.context.memberships,
                  grants: [
                    {
                      resourceType: 'job',
                      action: 'job:execute',
                      workspaceId: f.workspace,
                    },
                  ],
                },
              },
            });
          if (behavior === 'budget_denied' || behavior === 'wrong_currency') {
            expect(makeController).toThrow(
              behavior === 'budget_denied'
                ? 'assistant_cost_bound_exceeds_limit'
                : 'assistant_price_currency_unsupported',
            );
            expect(model.requests).toHaveLength(0);
            expect(
              await database.db`select 1 from allrice_assistant_model_admissions where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            expect(
              await database.db`select 1 from allrice_assistant_price_snapshots where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            return;
          }
          const input: HarnessExecutionInput = {
            kernel: {
              schemaVersion: 1,
              harness: 'dsh',
              employeeAssignmentId: f.assignment,
              employeeVersionId: f.version,
              sessionId: f.session,
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
              systemInstructions: 'Bounded synthetic tasks only.',
              userRequest:
                'ROOT_PRIVATE: delegate independent A and B tasks, then summarize.',
              bootstrapConversation: '',
              authorizedMemoryContext: '',
              grantedCapabilities: ['model:invoke'],
              skillVersionIds: [],
              imageAttachments: [],
            },
            providerSnapshot: frozen!.provider_snapshot,
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
            maxOutputTokens: 4000,
            threadId: `dsh-${f.session}`,
            tools: ['assistant.delegate', 'assistant.report'].map((name) => ({
              name,
              description: name,
              inputSchema: { type: 'object' },
            })),
            onEvent: async () => {},
            assistants: makeController(),
          };
          if (behavior === 'ordinary_retry') input.assistants = undefined;
          const execution = model.adapter.execute(input);
          execution.catch(() => {});
          if (behavior === 'wrong_model' || behavior === 'expiring') {
            await expect(execution).rejects.toThrow(
              behavior === 'wrong_model'
                ? 'assistant_price_provider_mismatch'
                : 'assistant_price_expires_before_deadline',
            );
            expect(model.requests).toHaveLength(0);
            expect(
              await database.db`select 1 from allrice_assistant_model_admissions where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            expect(
              await database.db`select 1 from allrice_assistant_price_snapshots where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            return;
          }
          if (behavior === 'ordinary_retry') {
            await expect(execution).rejects.toThrow();
            // The governed guard must not silently disable the existing ordinary
            // provider recovery policy (initial call + two configured retries).
            expect(model.requests).toHaveLength(3);
            expect(
              await database.db`select 1 from allrice_assistant_model_admissions where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            return;
          }
          if (behavior === 'dispatch_error') {
            const error = await execution.catch((error: unknown) => error);
            expect(error).toBeInstanceOf(Error);
            expect(getAssistantFailureDiagnostics(error)).toMatchObject({
              version: 1,
              failures: [
                {
                  phase: 'finish',
                  code: 'SERVER',
                  stopKind: 'error',
                  inputUsageKnown: false,
                  outputUsageKnown: false,
                  settlementConfirmed: true,
                },
              ],
              truncated: false,
            });
            expect(model.requests).toHaveLength(1);
            const rows =
              await database.db`select * from allrice_assistant_model_admissions where root_run_id=${f.rootRunId}`;
            expect(rows).toHaveLength(1);
            expect(rows[0]!.dispatched_at).not.toBeNull();
            expect(
              (
                await f.runtime.getTree(f.context, { runId: f.rootRunId })
              ).budgets.some((b) => b.reserved > 0),
            ).toBe(true);
            if (priced) {
              const receipts =
                await database.db`select usage_complete,cost_picounits,cost_basis from allrice_assistant_cost_receipts where root_run_id=${f.rootRunId}`;
              expect(receipts).toHaveLength(1);
              expect(receipts[0]).toMatchObject({
                usage_complete: false,
                cost_picounits: null,
                cost_basis: 'unknown',
              });
            }
            return;
          }
          await expect.poll(() => active, { timeout: 15000 }).toBe(2);
          expect(maxActive).toBe(2);
          await expect
            .poll(
              () =>
                model.requests.filter((r) =>
                  JSON.stringify(r.contents).includes('ROOT_PRIVATE'),
                ).length,
              { timeout: 10000 },
            )
            .toBe(3);
          if (behavior === 'revoked') {
            await database.db`update allrice_memberships set active=false where id=${f.membership}`;
            await expect(execution).rejects.toThrow();
            await expect
              .poll(() => model.aborted.length, { timeout: 10000 })
              .toBe(2);
            expect(
              await database.db`select 1 from allrice_assistant_results where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
            return;
          }
          overlap.release();
          if (behavior === 'child_dispatch_error') {
            const error = await execution.catch((error: unknown) => error);
            expect(error).toMatchObject({
              code: 'ASSISTANT_EXECUTION_UNRESOLVED',
              retryable: false,
            });
            const diagnostics = getAssistantFailureDiagnostics(error)!;
            expect(diagnostics).toMatchObject({
              failures: [
                { phase: 'finish', code: 'SERVER', stopKind: 'error' },
              ],
              truncated: false,
            });
            expect(
              model.requests.filter((request) => {
                const content = JSON.stringify(request.contents);
                return (
                  !content.includes('ROOT_PRIVATE') &&
                  content.includes('ANALYZE_B')
                );
              }),
            ).toHaveLength(1);
            const admissions = await database.db<
              P27DiagnosticAdmission[]
            >`select a.call_id,a.run_id,i.native_session_id,
              a.request_digest,a.dispatched_at is not null as dispatched,a.finished_at is not null as finished
              from allrice_assistant_model_admissions a join allrice_assistant_instances i using(run_id,root_run_id)
              where a.root_run_id=${f.rootRunId}`;
            const receipts = await database.db<
              P27DiagnosticReceipt[]
            >`select call_id,run_id,request_digest,snapshot_digest,
              usage_complete,usage->>'inputTokens' is not null as input_usage_known,
              usage->>'outputTokens' is not null as output_usage_known,
              cache_usage_known,actual_cost_known,cost_picounits is not null as cost_known
              from allrice_assistant_cost_receipts where root_run_id=${f.rootRunId}`;
            expect(
              correlateP27AssistantDiagnostics({
                diagnostics,
                admissions,
                receipts,
                snapshotDigest: receipts[0]!.snapshot_digest,
              }),
            ).toMatchObject({
              status: 'correlated',
              failures: [
                {
                  code: 'SERVER',
                  receiptPresent: true,
                  receiptUsageComplete: false,
                  receiptCostKnown: false,
                },
              ],
            });
            const tree = await f.runtime.getTree(f.context, {
              runId: f.rootRunId,
            });
            expect(tree.budgets.some((budget) => budget.reserved > 0)).toBe(
              true,
            );
            expect(
              tree.instances.find((instance) => instance.runId === f.rootRunId)
                ?.status,
            ).toBe('unknown');
            return;
          }
          if (behavior === 'missing_child_usage') {
            const error = await execution.catch((error: unknown) => error);
            expect(error).toMatchObject({
              code: 'ASSISTANT_EXECUTION_UNRESOLVED',
              retryable: false,
            });
            const diagnostics = getAssistantFailureDiagnostics(error)!;
            expect(diagnostics.failures).toHaveLength(2);
            expect(
              diagnostics.failures.every(
                (failure) =>
                  failure.phase === 'usage' &&
                  failure.code === 'USAGE_INCOMPLETE' &&
                  !failure.inputUsageKnown &&
                  !failure.outputUsageKnown &&
                  failure.settlementConfirmed,
              ),
            ).toBe(true);
            const tree = await f.runtime.getTree(f.context, {
              runId: f.rootRunId,
            });
            expect(tree.budgets.some((b) => b.reserved > 0)).toBe(true);
            expect(
              tree.results.every(
                (r) => r.status === 'partial' && !r.usageComplete,
              ),
            ).toBe(true);
            if (priced) {
              const receipts =
                await database.db`select usage_complete,cost_picounits,cost_basis from allrice_assistant_cost_receipts where root_run_id=${f.rootRunId}`;
              expect(
                receipts.some(
                  (r) =>
                    r.usage_complete === false &&
                    r.cost_picounits === null &&
                    r.cost_basis === 'unknown',
                ),
              ).toBe(true);
            }
            return;
          }
          const result = await execution;
          expect(result).toMatchObject({
            provider: 'gemini',
            model: 'gemini-3.8-flash',
            assistantStatus: 'completed',
            usageComplete: true,
            answer: expect.stringContaining('SYNTHETIC_ROOT_RESULT'),
          });
          const tree = await f.runtime.getTree(f.context, {
            runId: f.rootRunId,
          });
          expect(tree.instances).toHaveLength(3);
          expect(tree.results).toHaveLength(2);
          expect(tree.results.every((r) => r.parentAdoptedSeq !== null)).toBe(
            true,
          );
          expect(tree.budgets.every((b) => b.reserved === 0)).toBe(true);
          const admissions =
            await database.db`select a.*,i.label from allrice_assistant_model_admissions a join allrice_assistant_instances i on i.run_id=a.run_id where a.root_run_id=${f.rootRunId} order by a.prepared_at`;
          expect(admissions).toHaveLength(model.requests.length);
          expect(
            admissions.some((a) => Number(a.granted_output_tokens) < 4000),
          ).toBe(true);
          for (const runId of new Set(admissions.map((a) => a.run_id))) {
            const calls = admissions.filter((a) => a.run_id === runId);
            const requests = model.requests.filter((r) => {
              const content = JSON.stringify(r.contents);
              return runId === f.rootRunId
                ? content.includes('ROOT_PRIVATE')
                : !content.includes('ROOT_PRIVATE') &&
                    content.includes(`ANALYZE_${calls[0]!.label}`);
            });
            expect(
              requests.map((r) => r.generationConfig.maxOutputTokens),
            ).toEqual(calls.map((a) => Number(a.granted_output_tokens)));
            expect(calls.every((a) => a.dispatched_at && a.finished_at)).toBe(
              true,
            );
          }
          for (const report of tree.results) {
            expect(report.evidence).toHaveLength(1);
            const artifact = await getWorkbenchArtifact(
              f.context,
              f.session,
              report.evidence[0]!.id,
              database.db,
            );
            expect(artifact.provenance).toMatchObject({
              kind: 'model_proposal',
              runId: report.runId,
            });
          }
          expect(
            tree.budgets.find((b) => b.metric === 'model_calls')!.spent,
          ).toBe(model.requests.length);
          expect(
            tree.budgets.find((b) => b.metric === 'input_tokens')!.spent,
          ).toBe(2000 + (model.requests.length - 2) * 20);
          expect(
            tree.budgets.find((b) => b.metric === 'output_tokens')!.spent,
          ).toBe(14 + (model.requests.length - 2) * 123);
          if (priced) {
            const receipts =
              await database.db`select c.*,a.request_digest as admitted_digest from allrice_assistant_cost_receipts c join allrice_assistant_model_admissions a using(call_id) where c.root_run_id=${f.rootRunId}`;
            expect(receipts).toHaveLength(model.requests.length);
            expect(
              receipts.every(
                (r) =>
                  r.usage_complete === true &&
                  r.request_digest === r.admitted_digest &&
                  r.cost_basis === 'conservative_upper_bound' &&
                  !r.cache_usage_known &&
                  !r.actual_cost_known,
              ),
            ).toBe(true);
            const total = receipts.reduce(
              (sum, r) => sum + BigInt(r.cost_picounits),
              0n,
            );
            expect(total).toBe(
              BigInt(
                tree.budgets.find((b) => b.metric === 'input_tokens')!.spent,
              ) *
                5000000n +
                BigInt(
                  tree.budgets.find((b) => b.metric === 'output_tokens')!.spent,
                ) *
                  4000000n,
            );
            expect(result).toMatchObject({
              costEstimateAvailable: true,
              cacheUsageKnown: false,
              actualCostKnown: false,
              costBasis: 'conservative_upper_bound',
              costCurrency: 'USD',
              priceSnapshotDigest: expect.stringMatching(
                /^sha256:[a-f0-9]{64}$/,
              ),
              estimatedCostCents: Number(total) / 10000000000,
            });
          } else {
            expect(result.costEstimateAvailable).toBe(false);
            expect(result).not.toHaveProperty('priceSnapshotDigest');
            expect(
              await database.db`select 1 from allrice_assistant_price_snapshots where root_run_id=${f.rootRunId}`,
            ).toHaveLength(0);
          }
        } finally {
          clearTimeout(timer);
          abort.abort();
          overlap.release();
          await model.close();
          expect(model.egressAttempts()).toBe(0);
        }
      },
      45000,
    );
  },
);
