import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessExecutionInput } from '../../src/harness/adapter.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';

/** Actual adapter -> restricted DSH -> pinned pi-ai/@google/genai -> HTTP.
 * Only the Google endpoint is redirected in a private copy of the composition.
 * This proves the wire limit/usage mapping, NOT Google's enforcement, dynamic
 * grants, assistant child admission, retry suppression, paid-provider success,
 * or tenant readiness.
 * No fetch/SDK/client mock, ambient credential, production flag or database. */
describe.sequential(
  'Gemini frozen output bound over real loopback HTTP',
  () => {
    it.each([
      { model: '3.8flash', maxOutputTokens: 3754 },
      { model: 'gemini-3.8-flash', maxOutputTokens: 1024 },
    ])(
      'transmits $model maxOutputTokens=$maxOutputTokens and maps synthetic usage',
      async ({ model, maxOutputTokens }) => {
        const root = await mkdtemp(join(tmpdir(), 'allrice-p25-gemini-wire-'));
        const calls: {
          method?: string;
          path?: string;
          key?: string;
          body: Record<string, unknown>;
        }[] = [];
        const unexpectedEgress: string[] = [];
        const server = createServer((req, res) => {
          void (async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 1000000)
                throw Error('synthetic_gemini_request_too_large');
              chunks.push(Buffer.from(chunk));
            }
            calls.push({
              method: req.method,
              path: req.url,
              key: req.headers['x-goog-api-key'] as string | undefined,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(
              `data: ${JSON.stringify({
                candidates: [
                  {
                    index: 0,
                    content: {
                      role: 'model',
                      parts: [{ text: 'SYNTHETIC_GEMINI_WIRE_RESULT' }],
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 20,
                  cachedContentTokenCount: 4,
                  candidatesTokenCount: 5,
                  thoughtsTokenCount: 2,
                  totalTokenCount: 27,
                },
                modelVersion: 'gemini-3.8-flash',
                responseId: 'synthetic-response-never-google',
              })}\n\n`,
            );
          })().catch(() => {
            res.statusCode = 500;
            res.end();
          });
        });
        // A wrongly resolved HTTPS endpoint must hit a rejecting local proxy, not
        // Google. Only the explicit loopback endpoint bypasses this egress guard.
        const denyProxy = createServer((req, res) => {
          unexpectedEgress.push(req.url ?? 'unknown');
          res.writeHead(403).end();
        });
        denyProxy.on('connect', (req, socket) => {
          unexpectedEgress.push(req.url ?? 'unknown');
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        });
        let adapter: DshHarnessAdapter | undefined;
        let configRoot: string | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          server.listen(0, '127.0.0.1');
          denyProxy.listen(0, '127.0.0.1');
          await Promise.all([
            once(server, 'listening'),
            once(denyProxy, 'listening'),
          ]);
          const address = server.address() as { port: number };
          const proxyAddress = denyProxy.address() as { port: number };
          const source = await readFile(
            resolve(
              import.meta.dirname,
              '../../dsh/allrice-restricted.cordis.yml',
            ),
            'utf8',
          );
          expect(source.split('      google:\n')).toHaveLength(2);
          // Cordis resolves installed plugin names relative to its config. Keep
          // only this ephemeral config below the Worker dependency tree.
          const configParent = resolve(import.meta.dirname, '../../.local');
          await mkdir(configParent, { recursive: true });
          configRoot = await mkdtemp(join(configParent, 'gemini-wire-'));
          const config = join(configRoot, 'loopback.cordis.yml');
          await writeFile(
            config,
            source.replace(
              '      google:\n',
              `      google:\n        baseURL: "http://127.0.0.1:${address.port}/v1beta"\n`,
            ),
            { mode: 0o600 },
          );
          vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '1');
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
          const resolveCredential = vi.fn(async () => ({
            apiKey: 'synthetic-gemini-key-no-live-credential',
          }));
          adapter = new DshHarnessAdapter({
            runtimeCommand: process.execPath,
            runtimeArgs: [
              resolve(
                import.meta.dirname,
                '../../dsh/allrice-jsonrpc-runtime.mjs',
              ),
            ],
            runtimeRoot: join(root, 'runtime'),
            cordisConfig: config,
            credentialResolver: { resolve: resolveCredential },
            requestTimeoutMs: 15000,
          });
          const abort = new AbortController();
          timer = setTimeout(() => abort.abort(), 20000);
          const input: HarnessExecutionInput = {
            kernel: {
              schemaVersion: 1,
              harness: 'dsh',
              employeeAssignmentId: randomUUID(),
              employeeVersionId: randomUUID(),
              sessionId: randomUUID(),
              userMessageId: randomUUID(),
              assistantMessageId: randomUUID(),
              systemInstructions: 'Synthetic protocol test only. No tools.',
              userRequest: 'Return the synthetic bounded response.',
              bootstrapConversation: '',
              authorizedMemoryContext: '',
              grantedCapabilities: ['model:invoke'],
              skillVersionIds: [],
              imageAttachments: [],
            },
            providerSnapshot: {
              provider: 'dsh',
              route: 'gemini',
              authMode: 'allrice_credential',
              model,
              reasoningEffort: 'low',
              credentialReference: 'test:synthetic-gemini',
              // Production Gemini does not consume snapshot.baseUrl. Redirect only
              // the test composition's supported provider baseURL field above.
              baseUrl: null,
            },
            storageObjects: [],
            workDirectory: root,
            executionEnvironment: {
              ALLRICE_ORGANIZATION_ID: randomUUID(),
              ALLRICE_WORKSPACE_ID: randomUUID(),
              ALLRICE_OWNER_ID: randomUUID(),
            },
            signal: abort.signal,
            attempt: 1,
            generation: 0,
            maxOutputTokens,
            tools: [],
            onEvent: async () => {},
          };
          const outcome = await adapter.execute(input);
          expect(resolveCredential).toHaveBeenCalledTimes(1);
          expect(resolveCredential).toHaveBeenCalledWith(
            expect.objectContaining({
              reference: 'test:synthetic-gemini',
              route: 'gemini',
            }),
          );
          expect(unexpectedEgress).toEqual([]);
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({
            method: 'POST',
            key: 'synthetic-gemini-key-no-live-credential',
            body: {
              generationConfig: {
                maxOutputTokens,
                thinkingConfig: { thinkingLevel: 'LOW' },
              },
            },
          });
          expect(calls[0]!.path).toBe(
            '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
          );
          expect(outcome.answer).toBe('SYNTHETIC_GEMINI_WIRE_RESULT');
          expect(outcome.usage).toEqual({
            inputTokens: 16,
            cachedInputTokens: 4,
            outputTokens: 7,
          });
          expect(outcome).toMatchObject({ provider: 'gemini', model });
          expect(outcome).not.toHaveProperty('assistantStatus');
        } finally {
          if (timer) clearTimeout(timer);
          // Only this test's owned host and random directory. Do not delete native
          // files if close cannot prove exit; no broad kill or credential access.
          await adapter?.close();
          server.closeAllConnections();
          denyProxy.closeAllConnections();
          await Promise.all([
            new Promise<void>((done) => server.close(() => done())),
            new Promise<void>((done) => denyProxy.close(() => done())),
          ]);
          vi.unstubAllEnvs();
          if (configRoot)
            await rm(configRoot, { recursive: true, force: true });
          await rm(root, { recursive: true, force: true });
        }
      },
      30000,
    );
  },
);
