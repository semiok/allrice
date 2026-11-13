import {
  readDshToolResult,
  isMemoryIndexDocuments,
  type EmployeeDocuments,
  type DshNativeSkillSnapshot,
} from '@allrice/contracts';
import { nativeRunScope } from './dsh/run-scope.js';
/** Real pinned DSH child + real JSON-RPC + synthetic loopback provider.
 * Transport contract only; this is not real-model/business acceptance. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { HarnessExecutionInput } from './adapter.js';
import { DshProtocolClient } from './dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';
import { dshInboundToolHandler } from './dsh/tool-bridge.js';

export async function nativeBrokerRoundtrip(input: {
  cordisConfig?: string;
  run?: { id: string; documents: EmployeeDocuments };
  personalMethodToolsOnly?: true;
  systemPrompt?: string;
  progress?: HarnessExecutionInput['progress'];
  denyBeforeModel?: boolean;
  expectedToolNames?: string[];
  nativeTools?: string[];
  nativeSkills?: DshNativeSkillSnapshot[];
  excludedToolNames?: string[];
  initialMessagesExclude?: string;
  expectedBrokerCalls?: number;
  forbiddenToolNames?: string[];
  canonicalName: string;
  prompt?: string;
  fileReadRunId?: string;
  expectedTerminalError?: string;
  wireName: string;
  args: Record<string, unknown>;
  brokerArgs?: Record<string, unknown>;
  invalidArgs: Record<string, unknown>;
  invalidResultIncludes?: string;
  expectedToolError?: string;
  /** The same turn corrects a rejected read by selecting another native tool. */
  followupTool?: {
    canonicalName: string;
    wireName: string;
    args: Record<string, unknown>;
    modelResultIncludes: string;
  };
  modelResultIncludes?: string;
  /** Loopback-only transient provider failures after the first tool result. */
  retryAfterTool?: number;
  /** Fixed real backends may take longer than a transport-only stub. */
  timeoutMs?: number;
  inspectSchema?: (schema: Record<string, unknown>) => void;
  inspectTool?: (tool: {
    description?: string;
    parameters?: Record<string, unknown>;
  }) => void;
  onToolCall?: HarnessExecutionInput['onToolCall'];
}) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-broker-'));
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const received: unknown[] = [];
  const firstTurnRequests = input.followupTool ? 3 : 2;
  const sentinel = `synthetic-broker-${randomUUID()}`;
  let expectedModelContent =
    input.modelResultIncludes ?? input.expectedToolError ?? sentinel;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const requestIndex = requests.length;
      const retries = input.retryAfterTool ?? 0;
      if (requestIndex > 1 && requestIndex <= 1 + retries) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: '503 synthetic transient model failure' },
          }),
        );
        return;
      }
      const index = requestIndex - (requestIndex > 1 ? retries : 0);
      if (index > firstTurnRequests + 2)
        throw Error('synthetic provider call budget exceeded');
      const followup = input.followupTool && index === 2;
      const callsTool =
        index === 1 || followup || index === firstTurnRequests + 1;
      const common = {
        id: `synthetic-${index}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'native-contract',
      };
      res.setHeader('content-type', 'text/event-stream');
      for (const data of [
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                ...(callsTool
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${index}`,
                          type: 'function',
                          function: {
                            name: followup
                              ? input.followupTool!.wireName
                              : input.wireName,
                            arguments: JSON.stringify(
                              followup
                                ? input.followupTool!.args
                                : index === 1
                                  ? input.args
                                  : input.invalidArgs,
                            ),
                          },
                        },
                      ],
                    }
                  : { content: 'Synthetic transport complete.' }),
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
              finish_reason: callsTool ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ])
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      errors.push(error);
      res.statusCode = 500;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [
      resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
    ],
    cwd: root,
    requestTimeoutMs: 15000,
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(input.progress ? { ALLRICE_PROGRESS_GUARD_ENABLED: '1' } : {}),
      DSH_CORDIS_CONFIG:
        input.cordisConfig ??
        resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
      DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
      DSH_SESSION_ROOT: join(root, 'sessions'),
      DSH_HOME: root,
      DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
      DSH_CWD: root,
      DSH_MODEL: 'native-contract',
      DSH_CODEX_MODEL: 'gpt-5.6-luna',
      DSH_OPENAI_COMPATIBLE_MODEL: 'native-contract',
      DSH_SYSTEM_PROMPT:
        input.systemPrompt ??
        'Synthetic protocol test; only the selected tool.',
      OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    },
  });
  const session = `native-${randomUUID()}`;
  const runScope = input.run
    ? nativeRunScope(client, session, input.run.id)
    : undefined;
  let runBound = false;
  let completed = 0;
  let nativeRetries = 0;
  const nativeToolFailures: boolean[] = [];
  const nativeToolErrorCodes: (string | undefined)[] = [];
  const failures: Error[] = [];
  client.onFailure((error) => failures.push(error));
  client.subscribe((notice) => {
    const event = notice.params.event as
      | {
          type?: string;
          data?: {
            message?: { content?: { isError?: boolean }[] };
            error?: { code?: string };
          };
        }
      | undefined;
    if (notice.method === 'session.event' && event?.type === 'turn/end')
      completed++;
    if (notice.method === 'session.event' && event?.type === 'llm/retry')
      nativeRetries++;
    if (notice.method === 'session.event' && event?.type === 'tool/result') {
      nativeToolErrorCodes.push(event.data?.error?.code);
      nativeToolFailures.push(
        readDshToolResult(event.data?.message)?.isError === true,
      );
    }
  });
  const inbound = dshInboundToolHandler({
    ...(input.fileReadRunId
      ? {
          fileReadRoot: {
            nativeSessionId: session,
            runId: input.fileReadRunId,
            signal: new AbortController().signal,
          },
        }
      : {}),
    tools: [
      ...[
        input.canonicalName,
        ...(input.followupTool ? [input.followupTool.canonicalName] : []),
      ].map((name) => ({
        name,
        description: 'synthetic',
        inputSchema: { type: 'object' },
      })),
    ],
    onToolCall: async (call) => {
      received.push(call);
      const followup = input.followupTool && received.length === 2;
      expect(call.name).toBe(
        followup ? input.followupTool!.canonicalName : input.canonicalName,
      );
      expect(call.arguments).toEqual(
        followup ? input.followupTool!.args : (input.brokerArgs ?? input.args),
      );
      const result = input.onToolCall
        ? await input.onToolCall(call)
        : { modelContent: sentinel, summary: 'synthetic only' };
      if (!followup)
        expectedModelContent = input.modelResultIncludes ?? result.modelContent;
      return result;
    },
  });
  client.setRequestHandler((method, params) => {
    if (runScope) params = runScope.check(params);
    if (method === 'allrice/run-authorize' && input.run)
      return Promise.resolve({});
    return method === 'allrice/progress' && input.progress
      ? input.progress(params)
      : inbound(method, params);
  });
  try {
    await client.initialize({
      cwd: root,
      provider: 'openai-compatible',
      model: 'native-contract',
      nativeTools: input.nativeTools ?? [
        input.canonicalName,
        ...(input.followupTool ? [input.followupTool.canonicalName] : []),
      ],
      ...(input.nativeSkills ? { nativeSkills: input.nativeSkills } : {}),
      ...(input.run
        ? {
            requireRunAdmission: true,
            rootSystemInstructions:
              input.systemPrompt ??
              'Synthetic protocol test; only the selected tool.',
            employeeDocumentsSchemaVersion: isMemoryIndexDocuments(
              input.run.documents,
            )
              ? (2 as const)
              : (1 as const),
          }
        : {}),
      ...(input.personalMethodToolsOnly
        ? { personalMethodToolsOnly: true }
        : {}),
      expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      requireTaskProgress: !!input.progress,
    });
    if (input.run) {
      if (isMemoryIndexDocuments(input.run.documents))
        await expect(
          client.beginRun(session, input.run.id, { user: '', memory: '' }),
        ).rejects.toThrow('EMPLOYEE_DOCUMENT_VERSION_MISMATCH');
      await client.beginRun(session, input.run.id, input.run.documents);
      runBound = true;
    }
    if (input.denyBeforeModel) {
      let rejected = false;
      try {
        await client.prompt(session, 'Never admitted to a model.');
      } catch {
        rejected = true;
      }
      if (!rejected)
        await expect.poll(() => completed, { timeout: 15000 }).toBe(1);
      expect(requests).toEqual([]);
      expect(received).toEqual([]);
      return;
    }
    await client.prompt(
      session,
      input.prompt ?? 'Invoke the selected native tool.',
    );
    if (input.expectedTerminalError) {
      await expect.poll(() => failures.length, { timeout: 15000 }).toBe(1);
      expect(failures[0]!.message).toBe(input.expectedTerminalError);
      expect(received).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(nativeToolFailures).toEqual([]);
      return;
    }
    await expect
      .poll(() => requests.length, { timeout: input.timeoutMs ?? 15000 })
      .toBe(firstTurnRequests + (input.retryAfterTool ?? 0));
    await expect
      .poll(() => completed, { timeout: input.timeoutMs ?? 15000 })
      .toBe(1);
    const tools = requests[0]!.tools as {
      function?: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
    }[];
    expect(tools.some((tool) => tool.function?.name === input.wireName)).toBe(
      true,
    );
    if (input.expectedToolNames)
      expect(tools.map((t) => t.function?.name).toSorted()).toEqual(
        input.expectedToolNames.toSorted(),
      );
    for (const request of requests) {
      const names = (request.tools as typeof tools).map(
        (tool) => tool.function?.name,
      );
      for (const name of input.excludedToolNames ?? [])
        expect(names).not.toContain(name);
    }
    if (input.initialMessagesExclude)
      expect(JSON.stringify(requests[0]!.messages)).not.toContain(
        input.initialMessagesExclude,
      );
    for (const name of input.forbiddenToolNames ?? [])
      expect(tools.some((tool) => tool.function?.name === name)).toBe(false);
    input.inspectSchema?.(
      tools.find((tool) => tool.function?.name === input.wireName)!.function!
        .parameters!,
    );
    input.inspectTool?.(
      tools.find((tool) => tool.function?.name === input.wireName)!.function!,
    );
    if (input.systemPrompt)
      expect(JSON.stringify(requests[0]!.messages)).toContain(
        JSON.stringify(input.systemPrompt).slice(1, -1),
      );
    expect(received).toHaveLength(input.expectedBrokerCalls ?? 1);
    if (input.expectedToolError) expect(nativeToolFailures[0]).toBe(true);
    if (input.fileReadRunId && input.expectedToolError)
      expect(nativeToolErrorCodes[0]).toBe(input.expectedToolError);
    for (const request of requests.slice(1, 2 + (input.retryAfterTool ?? 0)))
      expect(JSON.stringify(request)).toContain(
        JSON.stringify(expectedModelContent).slice(1, -1),
      );
    expect(JSON.stringify(requests[1 + (input.retryAfterTool ?? 0)])).toContain(
      JSON.stringify(expectedModelContent).slice(1, -1),
    );
    if (input.followupTool) {
      expect(JSON.stringify(requests[2])).toContain(
        input.followupTool.modelResultIncludes,
      );
      expect(nativeToolFailures).toEqual([true, false]);
    }
    expect(failures).toEqual([]);
    expect(client.processState().state).toBe('running');
    await client.prompt(session, 'Reject invalid arguments before the Broker.');
    await expect
      .poll(() => requests.length, { timeout: 15000 })
      .toBe(firstTurnRequests + 2 + (input.retryAfterTool ?? 0));
    await expect.poll(() => completed, { timeout: 15000 }).toBe(2);
    if (input.invalidResultIncludes)
      expect(
        JSON.stringify(
          requests[firstTurnRequests + 1 + (input.retryAfterTool ?? 0)],
        ),
      ).toContain(input.invalidResultIncludes);
    expect(received).toHaveLength(input.expectedBrokerCalls ?? 1);
    expect(nativeRetries).toBe(input.retryAfterTool ?? 0);
    expect(errors).toEqual([]);
  } finally {
    try {
      runScope?.unsubscribe();
      try {
        if (runBound) await client.endRun(session);
      } finally {
        await client.close().catch((error: unknown) => {
          if (!input.expectedTerminalError) throw error;
          expect(failures).toHaveLength(1);
          // A terminal protocol has no semantic shutdown acknowledgement.
        });
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await rm(root, { recursive: true, force: true });
    }
  }
}
