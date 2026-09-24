/** Real pinned DSH process, durable session files and synthetic HTTP model. */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import { dshInboundToolHandler } from '../../src/harness/dsh/tool-bridge.js';
import { p24Fixture } from '../p24/fixture.js';

describe('MET153 native durable question boundary', () => {
  it.each([false, true])(
    'releases and resumes the native question exactly once (application login=%s)',
    async (applicationLogin) => {
      const requestId = randomUUID();
      const connectionId = randomUUID();
      const itemId = applicationLogin ? `app-connect:${requestId}` : 'choice';
      const answerLabel = applicationLogin ? '已连接，继续任务' : 'Continue';
      const model = await p24Fixture(async (request, index) => {
        if (index === 1)
          return {
            nativeTool: {
              name: applicationLogin ? 'cloud_mcp_call' : 'ask_user_question',
              arguments: applicationLogin
                ? {
                    action: 'connect',
                    name: 'Records',
                    endpoint: 'https://mcp.example.test/mcp',
                  }
                : {
                    questions: [
                      {
                        id: 'choice',
                        question: 'Which option?',
                        options: [{ label: 'Continue' }],
                      },
                    ],
                  },
            },
          };
        expect(JSON.stringify(request.messages)).toContain(answerLabel);
        return { text: 'Recovered native answer.' };
      });
      const clients: DshProtocolClient[] = [];
      const launch = async () => {
        const client = new DshProtocolClient({
          command: process.execPath,
          args: [
            resolve(
              import.meta.dirname,
              '../../dsh/allrice-jsonrpc-runtime.mjs',
            ),
          ],
          cwd: model.root,
          requestTimeoutMs: 15000,
          environment: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            DSH_CORDIS_CONFIG: resolve(
              import.meta.dirname,
              '../../dsh/allrice-restricted.cordis.yml',
            ),
            DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
            DSH_SESSION_ROOT: join(model.root, 'sessions'),
            DSH_HOME: model.root,
            DSH_CWD: model.root,
            DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
            DSH_MODEL: 'native-wait',
            DSH_CODEX_MODEL: 'gpt-5.6-luna',
            DSH_OPENAI_COMPATIBLE_MODEL: 'native-wait',
            OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
            OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
          },
        });
        clients.push(client);
        if (applicationLogin)
          client.setRequestHandler(
            dshInboundToolHandler({
              tools: [
                {
                  name: 'cloud.mcp.call',
                  description: 'Connect apps',
                  inputSchema: { type: 'object' },
                },
              ],
              onToolCall: async () => ({
                modelContent: JSON.stringify({
                  needsLogin: true,
                  requestId,
                  connection: { id: connectionId },
                  loginPath: `/workspace/mcp?connectionId=${connectionId}`,
                }),
                summary: 'Login',
              }),
            }),
          );
        await client.initialize({
          cwd: model.root,
          provider: 'openai-compatible',
          model: 'native-wait',
          nativeTools: applicationLogin ? ['cloud.mcp.call'] : [],
          expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        });
        return client;
      };
      try {
        const original = await launch();
        const notices: DshNotification[] = [];
        original.subscribe((n) => notices.push(n));
        const sessionId = `native-wait-${randomUUID()}`;
        await original.prompt(
          sessionId,
          'Ask for a choice, then continue this task.',
        );
        await expect
          .poll(
            () => notices.find((n) => n.method === 'session.user-question'),
            {
              timeout: 15000,
            },
          )
          .toBeTruthy();
        const questionId = String(
          notices.find((n) => n.method === 'session.user-question')!.params
            .questionId,
        );
        const parked = await original.parkQuestion(sessionId, questionId);
        expect(parked.checkpoint).toMatchObject({ sessionId, questionId });
        const turnId = (parked.checkpoint as { turnId: string }).turnId;
        await original.close();
        expect(model.requests).toHaveLength(1);
        const recovered = await launch();
        const after: DshNotification[] = [];
        recovered.subscribe((n) => after.push(n));
        const answer = {
          sessionId,
          questionId,
          turnId,
          inputId: randomUUID(),
          text: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [{ id: itemId, selected: [answerLabel] }] })}`,
        };
        const receipt = await recovered.answerWait(answer);
        expect(receipt.proof).toMatchObject({
          status: 'adopted',
          inputId: answer.inputId,
          turnId,
          checkpoint: 'question_resolved',
        });
        expect((await recovered.answerWait(answer)).proof).toEqual(
          receipt.proof,
        );
        expect(model.requests).toHaveLength(1);
        await recovered.continueWait(answer);
        await expect
          .poll(
            () => JSON.stringify(after).includes('Recovered native answer.'),
            { timeout: 15000 },
          )
          .toBe(true);
        await expect(recovered.continueWait(answer)).rejects.toThrow(
          'NATIVE_WAIT_CHANGED',
        );
        expect(model.requests).toHaveLength(2);
      } finally {
        await Promise.allSettled(clients.map((c) => c.close()));
        await model.close();
      }
    },
    45000,
  );
});
