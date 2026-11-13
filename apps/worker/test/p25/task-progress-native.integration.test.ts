/** Actual pinned native process and JSON-RPC, synthetic HTTP model (no paid calls). */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import {
  initialProgressState,
  observeProgress,
  type ProgressFact,
} from '../../../../packages/database/src/task-progress-policy.ts';
import { p24Fixture } from '../p24/fixture.js';

describe('MET153 actual native progress wire', () => {
  it('retains the native aborted-before-dispatch pair without fabricating a progress finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'progress-skipped-'));
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk; // Consume the synthetic request.
      }
      res.setHeader('content-type', 'text/event-stream');
      const common = {
        id: 'synthetic',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'synthetic',
      };
      for (const chunk of [
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: ['first', 'skipped'].map((id, index) => ({
                  index,
                  id,
                  type: 'function',
                  function: {
                    name: 'platform_repository_review',
                    arguments: '{"action":"inspect"}',
                  },
                })),
              },
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        },
      ])
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      ],
      cwd: root,
      requestTimeoutMs: 15000,
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ALLRICE_PROGRESS_GUARD_ENABLED: '1',
        DSH_CORDIS_CONFIG: resolve(
          import.meta.dirname,
          '../../dsh/allrice-restricted.cordis.yml',
        ),
        DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
        DSH_SESSION_ROOT: join(root, 'sessions'),
        DSH_HOME: root,
        DSH_CWD: root,
        DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
        DSH_MODEL: 'synthetic',
        DSH_OPENAI_COMPATIBLE_MODEL: 'synthetic',
        OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
        OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      },
    });
    const session = `skipped-${randomUUID()}`,
      requests: Record<string, unknown>[] = [],
      notices: DshNotification[] = [];
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.subscribe((notice) => notices.push(notice));
    client.setRequestHandler(async (method, p) => {
      if (method === 'allrice/tool-call') {
        expect(p.toolCallId).toBe('first');
        await firstStarted;
        await client.interrupt(session);
        return {
          modelContent: '{}',
          summary: 'Synthetic canceled first call.',
        };
      }
      expect(method).toBe('allrice/progress');
      requests.push(p);
      if (p.action === 'start' && p.kind === 'tool') {
        if (p.callId === 'first') started();
        else
          return {
            toolStart: 'not_admitted',
            reason: 'admission_closed',
            runId: 'synthetic-run',
            nativeSessionId: session,
            callId: 'skipped',
            rejection: {
              code: 'task_progress_lease_lost',
              message: 'task_progress_lease_lost',
            },
          };
      }
      return { paused: false };
    });
    try {
      await client.initialize({
        cwd: root,
        provider: 'openai-compatible',
        model: 'synthetic',
        nativeTools: ['platform.repository.review'],
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        requireTaskProgress: true,
      });
      await client.prompt(session, 'Synthetic two exclusive tool calls.');
      await expect
        .poll(
          () =>
            notices.some(
              (n) =>
                n.method === 'session.event' &&
                (n.params.event as { type: string }).type === 'turn/end',
            ),
          { timeout: 15000 },
        )
        .toBe(true);
      await client.close(); // Flush the actual Host ledger bridge and require confirmed exit.
      expect(client.closureEvidence()).toMatchObject({
        process: { state: 'exited', exitCode: 0, signal: null },
        wrapperCleanupConfirmed: true,
      });
      expect(
        requests
          .filter((p) => p.kind === 'tool')
          .map((p) => [p.action, p.callId]),
      ).toEqual([
        ['start', 'first'],
        ['finish', 'first'],
        ['start', 'skipped'],
      ]);
      expect(JSON.stringify(notices)).toContain('TOOL_ABORTED_BEFORE_DISPATCH');
      expect(
        notices.filter(
          (n) =>
            n.method === 'session.event' &&
            (n.params.event as { type: string }).type === 'tool/call',
        ),
      ).toHaveLength(2);
      expect(
        notices.filter(
          (n) =>
            n.method === 'session.event' &&
            (n.params.event as { type: string }).type === 'tool/result',
        ),
      ).toHaveLength(2);
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it('carries a maintenance reservation through the actual native provider wire and settles each call', async () => {
    const model = await p24Fixture(async (_request, index) => ({
      ...(index < 3
        ? { nativeTool: { name: 'local_fs_list', arguments: { path: '.' } } }
        : { text: 'Bounded synthetic final.' }),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 1200,
        total_tokens: 1300,
      },
    }));
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      ],
      cwd: model.root,
      requestTimeoutMs: 15000,
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ALLRICE_PROGRESS_GUARD_ENABLED: '1',
        ALLRICE_MAINTENANCE_OUTPUT_TOKENS: '3000',
        DSH_CORDIS_CONFIG: resolve(
          import.meta.dirname,
          '../../dsh/allrice-restricted.cordis.yml',
        ),
        DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
        DSH_SESSION_ROOT: join(model.root, 'sessions'),
        DSH_HOME: model.root,
        DSH_CWD: model.root,
        DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
        DSH_MODEL: 'native-maintenance-budget',
        DSH_CODEX_MODEL: 'gpt-5.6-luna',
        DSH_OPENAI_COMPATIBLE_MODEL: 'native-maintenance-budget',
        OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
        OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
      },
    });
    const notices: DshNotification[] = [],
      starts: Record<string, unknown>[] = [],
      receipts: Record<string, unknown>[] = [];
    client.subscribe((n) => notices.push(n));
    let remaining = 3000;
    client.setRequestHandler(async (method, p) => {
      expect(method).toBe('allrice/progress');
      if (p.action === 'model_prepare') {
        expect(remaining).toBeGreaterThan(0);
        return {
          prepared: true,
          outputTokens: Math.min(Number(p.requestedOutputTokens), remaining),
        };
      }
      if (p.action === 'start' && p.kind === 'model') starts.push(p);
      if (p.action === 'finish' && p.kind === 'model') {
        receipts.push(p);
        remaining -= Number(p.outputTokens);
      }
      return { paused: false };
    });
    try {
      await client.initialize({
        cwd: model.root,
        provider: 'openai-compatible',
        model: 'native-maintenance-budget',
        nativeTools: ['local.fs.list'],
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        requireTaskProgress: true,
      });
      const session = `maintenance-budget-${randomUUID()}`;
      await client.prompt(session, 'Synthetic call budget wire.');
      await expect.poll(() => receipts.length, { timeout: 15000 }).toBe(3);
      expect(starts.map((s) => s.outputTokens)).toEqual([3000, 1800, 600]);
      expect(receipts.map((r) => r.outputTokens)).toEqual([1200, 1200, 1200]);
      expect(remaining).toBe(-600); // Actual overrun preserved, not clamped.
      expect(
        starts.every((s) =>
          /^sha256:[a-f0-9]{64}$/.test(String(s.requestDigest)),
        ),
      ).toBe(true);
      expect(
        model.requests.map((r) => {
          const wire = r as unknown as Record<string, unknown>;
          return wire.max_tokens ?? wire.max_completion_tokens;
        }),
      ).toEqual([3000, 1800, 600]);
    } finally {
      await client.close();
      await model.close();
    }
  }, 45000);

  it.each(['continue', 'cancel', 'pending'] as const)(
    'pauses after actual repeated tool errors and handles %s',
    async (decision) => {
      const model = await p24Fixture(async (_request, index) =>
        index <= 3
          ? { nativeTool: { name: 'local_fs_list', arguments: { path: 42 } } }
          : { text: 'Synthetic final answer retained.' },
      );
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: model.root,
        requestTimeoutMs: 15000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          ALLRICE_PROGRESS_GUARD_ENABLED: '1',
          ALLRICE_QUESTION_RELEASE_MS: '60000',
          ALLRICE_ASK_USER_TIMEOUT: '1',
          DSH_CORDIS_CONFIG: resolve(
            import.meta.dirname,
            '../../dsh/allrice-restricted.cordis.yml',
          ),
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(model.root, 'sessions'),
          DSH_HOME: model.root,
          DSH_CWD: model.root,
          DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
          DSH_MODEL: 'native-progress',
          DSH_CODEX_MODEL: 'gpt-5.6-luna',
          DSH_OPENAI_COMPATIBLE_MODEL: 'native-progress',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
        },
      });
      let state = initialProgressState(),
        pauseId: string | null = null;
      const starts = new Map<string, Record<string, unknown>>();
      const requests: Record<string, unknown>[] = [],
        notices: DshNotification[] = [];
      client.subscribe((notice) => notices.push(notice));
      client.setRequestHandler(async (method, p) => {
        expect(method).toBe('allrice/progress'); // Invalid args never reach the Broker.
        requests.push(p);
        if (p.action === 'start') starts.set(String(p.callId), p);
        if (p.action === 'finish' && p.kind === 'tool') {
          state = observeProgress(state, {
            ...starts.get(String(p.callId)),
            ...p,
          } as unknown as ProgressFact);
          if (state.reason) pauseId ??= randomUUID();
        }
        if (p.action === 'decide') {
          expect(p.pauseId).toBe(pauseId);
          expect(p.decision).toBe(decision);
          pauseId = null;
          state = initialProgressState();
        }
        return {
          paused: !!pauseId,
          pauseId,
          reason: state.reason,
          recent: state.history
            .slice(-3)
            .map((f) => ({ tool: f.name, outcome: f.outcome })),
        };
      });
      const session = `native-progress-${randomUUID()}`;
      try {
        await client.initialize({
          cwd: model.root,
          provider: 'openai-compatible',
          model: 'native-progress',
          nativeTools: ['local.fs.list'],
          expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
          requireTaskProgress: true,
        });
        await client.prompt(
          session,
          'Synthetic repeated failure then user decision.',
        );
        await expect
          .poll(
            () => notices.some((n) => n.method === 'session.user-question'),
            { timeout: 15000 },
          )
          .toBe(true);
        expect(model.requests).toHaveLength(3);
        expect(
          requests.filter((p) => p.action === 'finish' && p.kind === 'tool'),
        ).toHaveLength(3);
        const question = notices.find(
          (n) => n.method === 'session.user-question',
        )!;
        expect(question.params.sessionId).toBe(session);
        expect(JSON.stringify(question)).toContain('runtime-progress');
        if (decision === 'pending') {
          await expect
            .poll(
              () =>
                notices.some(
                  (n) => n.method === 'session.user-question-pending',
                ),
              { timeout: 5000 },
            )
            .toBe(true);
          await expect
            .poll(
              () =>
                notices.filter(
                  (n) =>
                    n.method === 'session.event' &&
                    (n.params.event as { type: string }).type === 'turn/end',
                ).length,
            )
            .toBe(1);
          expect(model.requests).toHaveLength(3);
          expect(
            requests.filter((p) => p.action === 'start' && p.kind === 'model'),
          ).toHaveLength(3);
          expect(requests.some((p) => p.action === 'decide')).toBe(false);
          expect(pauseId).not.toBeNull();
          // DSH has already persisted this message before the pending error.
          const messages = notices.filter(
            (n) =>
              n.method === 'session.event' &&
              (n.params.event as { type: string }).type === 'user/message',
          );
          expect(JSON.stringify(messages)).toContain(
            'Synthetic repeated failure then user decision.',
          );
          await client.prompt(session, '先保留这条新消息，等我确认再继续。');
          await expect
            .poll(
              () =>
                notices.filter(
                  (n) => n.method === 'session.user-question-pending',
                ).length,
              { timeout: 5000 },
            )
            .toBe(2);
          await expect
            .poll(
              () =>
                notices.filter(
                  (n) =>
                    n.method === 'session.event' &&
                    (n.params.event as { type: string }).type === 'turn/end',
                ).length,
            )
            .toBe(2);
          expect(model.requests).toHaveLength(3);
          expect(
            JSON.stringify(
              notices.filter(
                (n) =>
                  n.method === 'session.event' &&
                  (n.params.event as { type: string }).type === 'user/message',
              ),
            ),
          ).toContain('先保留这条新消息，等我确认再继续。');
          return;
        }
        // MET-210: plain text never answers a question; only a typed answer.
        await expect(client.steer(session, '重新检查后继续')).rejects.toThrow(
          'QUESTION_PENDING_USE_ANSWER',
        );
        const turn = notices.findLast(
          (n) =>
            n.method === 'session.event' &&
            (n.params.event as { type?: string }).type === 'turn/start',
        )!.params.event as { data: { turn: number } };
        await expect(
          client.steer(
            session,
            `allrice:user-question:v1:${JSON.stringify({
              questionId: question.params.questionId,
              answers: [
                {
                  id: 'runtime-progress',
                  selected: [
                    decision === 'continue' ? '重新检查后继续' : '取消任务',
                  ],
                },
              ],
            })}`,
            {
              inputId: randomUUID(),
              turnId: `${session}:turn:${turn.data.turn}`,
              kind: 'ask_user',
            },
          ),
        ).resolves.toMatchObject({ status: 'adopted' });
        await expect
          .poll(() => requests.some((p) => p.action === 'decide'), {
            timeout: 10000,
          })
          .toBe(true);
        await expect
          .poll(
            () =>
              notices.some(
                (n) =>
                  n.method === 'session.event' &&
                  (n.params.event as { type: string }).type === 'turn/end',
              ),
            { timeout: 15000 },
          )
          .toBe(true);
        expect(model.requests).toHaveLength(decision === 'continue' ? 4 : 3);
        const context = notices.filter((n) => n.method === 'session.context');
        expect(context.length).toBeGreaterThan(0);
        expect(context.at(-1)?.params.sessionId).toBe(session);
        if (decision === 'continue') {
          expect(context.at(-1)?.params.contextPressure).toEqual(
            (await client.sessionProjection(session)).contextPressure,
          );
          expect(JSON.stringify(notices)).toContain(
            'Synthetic final answer retained.',
          );
        } else {
          // llm/stream cancellation now appends an empty assistant/attempt
          // after the last announced request boundary; its projection advances.
          expect(
            (await client.sessionProjection(session)).asOfSeq,
          ).toBeGreaterThan(Number(context.at(-1)?.params.asOfSeq));
        }
      } finally {
        await client.close();
        await model.close();
      }
    },
    45000,
  );
});
