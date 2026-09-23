/** Actual pinned native process and JSON-RPC, synthetic HTTP model (no paid calls). */
import { randomUUID } from 'node:crypto';
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
  it.each(['continue', 'cancel'] as const)(
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
        await client.steer(
          session,
          decision === 'continue' ? '重新检查后继续' : '取消任务',
        );
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
        if (decision === 'continue')
          expect(JSON.stringify(notices)).toContain(
            'Synthetic final answer retained.',
          );
      } finally {
        await client.close();
        await model.close();
      }
    },
    45000,
  );
});
