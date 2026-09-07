import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RuntimeNativeInputProofSchema,
  UserQuestionRequestSchema,
  type UserQuestionRequest,
} from '@allrice/contracts';
import { DshProtocolClient } from './dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';

describe('P10 pinned DSH native step adoption', () => {
  it('distinguishes persisted inbox admission from actual step entry and deduplicates lost RPC acknowledgements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-p10-dsh-'));
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const requests: string[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(Buffer.concat(chunks).toString());
        const index = requests.length;
        if (index === 1) await firstGate;
        res.setHeader('content-type', 'text/event-stream');
        const common = {
          id: `synthetic-${index}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'p10-test',
        };
        for (const data of [
          {
            ...common,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  ...(index === 3
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_question',
                            type: 'function',
                            function: {
                              name: 'ask_user_question',
                              arguments: JSON.stringify({
                                questions: [
                                  {
                                    id: 'format',
                                    header: 'Format',
                                    question: 'Which format?',
                                    options: [
                                      {
                                        label: 'Text',
                                        description: 'Plain text',
                                      },
                                      {
                                        label: 'JSON',
                                        description: 'Structured data',
                                      },
                                    ],
                                  },
                                ],
                              }),
                            },
                          },
                        ],
                      }
                    : {
                        content:
                          index === 1
                            ? 'First step.'
                            : 'Correction considered.',
                      }),
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...common,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: index === 3 ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          },
        ])
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.end('data: [DONE]\n\n');
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const environment = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      DSH_CORDIS_CONFIG: resolve(
        import.meta.dirname,
        '../../dsh/allrice-restricted.cordis.yml',
      ),
      DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
      DSH_SESSION_ROOT: join(root, 'sessions'),
      DSH_HOME: root,
      DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
      DSH_CWD: root,
      DSH_MODEL: 'p10-test',
      DSH_CODEX_MODEL: 'gpt-5.6-luna',
      DSH_OPENAI_COMPATIBLE_MODEL: 'p10-test',
      DSH_SYSTEM_PROMPT: 'Synthetic protocol test. No tools.',
      OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    };
    const launch = {
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      ],
      cwd: root,
      requestTimeoutMs: 15_000,
      environment,
    };
    let client = new DshProtocolClient(launch);
    const sessionId = `p10-${randomUUID()}`;
    let turnId = '';
    client.subscribe((n) => {
      const event = n.params.event as
        { type?: string; data?: { turn?: number } } | undefined;
      if (n.method === 'session.event' && event?.type === 'turn/start')
        turnId = `${sessionId}:turn:${event.data?.turn}`;
    });
    const initialize = () =>
      client.initialize({
        cwd: root,
        provider: 'openai-compatible',
        model: 'p10-test',
        nativeTools: [],
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
    try {
      await initialize();
      await client.prompt(sessionId, 'Write a short synthetic answer.');
      await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
      expect(turnId).not.toBe('');
      const typed = {
        inputId: randomUUID(),
        turnId,
        kind: 'steer_current' as const,
      };
      const correction = 'P10 unique correction: use corrected data.';
      const pending = RuntimeNativeInputProofSchema.parse(
        await client.steer(sessionId, correction, typed),
      );
      expect(pending.status).toBe('pending');
      expect(await client.steer(sessionId, correction, typed)).toEqual(pending);
      await expect(
        client.steer(sessionId, 'changed body', typed),
      ).rejects.toThrow();
      releaseFirst();
      await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);
      const proof = RuntimeNativeInputProofSchema.parse(
        await client.steer(sessionId, correction, typed),
      );
      expect(proof).toMatchObject({
        status: 'adopted',
        checkpoint: 'step_user_message',
        inputId: typed.inputId,
        turnId,
      });
      expect(requests[0]).not.toContain(correction);
      expect(requests[1]).toContain(correction);
      await client.interrupt(sessionId);
      await client.close();
      // Native session journal, not an in-memory transport acknowledgement.
      const files = await readdir(join(root, 'sessions'), { recursive: true });
      const logs = await Promise.all(
        files
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => readFile(join(root, 'sessions', f), 'utf8')),
      );
      expect(logs.join('\n')).toContain(typed.inputId);
      expect(
        logs.join('\n').match(/"type":"allrice\/input\/request"/g),
      ).toHaveLength(1);
      client = new DshProtocolClient(launch);
      await initialize();
      // Explicit recovery resumes the saved journal without starting a model call.
      await client.recover(sessionId);
      const restored = await client.steer(sessionId, correction, typed);
      expect(restored).toEqual(proof);
      expect(requests).toHaveLength(2);
      let question: UserQuestionRequest | null = null;
      let questionTurn = '';
      client.subscribe((n) => {
        if (n.method === 'session.user-question')
          question = UserQuestionRequestSchema.parse({
            questionId: n.params.questionId,
            questions: n.params.questions,
          });
        const event = n.params.event as
          { type?: string; data?: { turn?: number } } | undefined;
        if (n.method === 'session.event' && event?.type === 'turn/start')
          questionTurn = `${sessionId}:turn:${event.data?.turn}`;
      });
      await client.prompt(sessionId, 'Ask the user for a format.');
      await expect.poll(() => question, { timeout: 15_000 }).not.toBeNull();
      const q = question as unknown as UserQuestionRequest;
      const questionInput = {
        inputId: randomUUID(),
        turnId: questionTurn,
        kind: 'ask_user' as const,
      };
      await expect(
        client.steer(sessionId, 'plain correction', {
          ...questionInput,
          kind: 'steer_current',
        }),
      ).rejects.toThrow('QUESTION_PENDING');
      await expect(
        client.steer(
          sessionId,
          `allrice:user-question:v1:${JSON.stringify({ questionId: 'wrong', answers: [] })}`,
          questionInput,
        ),
      ).rejects.toThrow('QUESTION_ANSWER_INVALID');
      const answer = `allrice:user-question:v1:${JSON.stringify({ questionId: q.questionId, answers: [{ id: 'format', selected: ['JSON'] }] })}`;
      const answered = await client.steer(sessionId, answer, questionInput);
      expect(answered).toMatchObject({
        status: 'adopted',
        checkpoint: 'question_resolved',
      });
      expect(await client.steer(sessionId, answer, questionInput)).toEqual(
        answered,
      );
      await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(4);
      expect(requests[3]).toContain('JSON');
    } finally {
      releaseFirst();
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
