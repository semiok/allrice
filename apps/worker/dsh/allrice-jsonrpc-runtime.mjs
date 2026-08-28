#!/usr/bin/env node
/* global AbortController, AbortSignal, Buffer, fetch, process, setImmediate */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  boot,
  installFailLoud,
  loadEnv,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

const runtimeName = 'allrice-dsh-jsonrpc-runtime';
const codexCredentialKey = credentialKey('llm-pi-ai', 'openai-codex');
const maximumSearchResponseBytes = 2_000_000;
const localNativeTools = [
  {
    canonicalName: 'local.fs.list',
    wireName: 'local_fs_list',
    description:
      'List files and directories inside the local folder explicitly authorized through Rice Bridge. Read-only; paths are relative to the authorized root.',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative directory path. Defaults to .',
      },
      limit: { type: 'integer', description: 'Maximum entries from 1 to 200.' },
    },
  },
  {
    canonicalName: 'local.fs.search',
    wireName: 'local_fs_search',
    description:
      'Search text inside files under the local folder explicitly authorized through Rice Bridge. Read-only and confined to the authorized root.',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative directory path. Defaults to .',
      },
      query: {
        type: 'string',
        required: true,
        description: 'Text to search for.',
      },
      limit: { type: 'integer', description: 'Maximum matches from 1 to 100.' },
    },
  },
  {
    canonicalName: 'local.fs.read',
    wireName: 'local_fs_read',
    description:
      'Read one text file under the local folder explicitly authorized through Rice Bridge. Sensitive paths and paths outside the grant are rejected.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Relative file path.',
      },
      maxBytes: {
        type: 'integer',
        description: 'Maximum bytes from 1 to 200000.',
      },
    },
  },
  {
    canonicalName: 'local.git.status',
    wireName: 'local_git_status',
    description:
      'Read Git working-tree status for a repository inside the Rice Bridge authorized folder. This is a fixed read-only operation, not shell access.',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative repository path. Defaults to .',
      },
    },
  },
  {
    canonicalName: 'local.git.diff',
    wireName: 'local_git_diff',
    description:
      'Read a Git diff for a repository inside the Rice Bridge authorized folder. This is a fixed read-only operation, not shell access.',
    parameters: {
      path: {
        type: 'string',
        description: 'Relative repository path. Defaults to .',
      },
      staged: {
        type: 'boolean',
        description: 'Read the staged diff when true.',
      },
      maxBytes: {
        type: 'integer',
        description: 'Maximum bytes from 1 to 200000.',
      },
    },
  },
];

function toPiCredential(record) {
  if (record === undefined) return undefined;
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    };
  }
  return record.payload;
}

function toCredentialRecord(credential) {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...(credential.key === undefined ? {} : { key: credential.key }),
      ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
    };
  }
  return { kind: 'grant', payload: credential };
}

function codexCredentialStore(ctx) {
  return {
    async read(providerId) {
      if (providerId !== 'openai-codex') return undefined;
      return toPiCredential(
        await ctx.credentials.readRecord(codexCredentialKey),
      );
    },
    async list() {
      const status = await ctx.credentials.describeRecord(codexCredentialKey);
      return status.configured
        ? [
            {
              providerId: 'openai-codex',
              type: status.kind === 'grant' ? 'oauth' : 'api_key',
            },
          ]
        : [];
    },
    async modify(providerId, mutate) {
      if (providerId !== 'openai-codex') {
        throw new Error(`Unsupported credential provider ${providerId}`);
      }
      return toPiCredential(
        await ctx.credentials.modifyRecord(
          codexCredentialKey,
          async (record) => {
            const next = await mutate(toPiCredential(record));
            return next === undefined ? undefined : toCredentialRecord(next);
          },
        ),
      );
    },
    async delete(providerId) {
      if (providerId === 'openai-codex') {
        await ctx.credentials.deleteRecord(codexCredentialKey);
      }
    },
  };
}

function accountIdFromAccessToken(accessToken) {
  const encodedPayload = accessToken.split('.')[1];
  if (!encodedPayload) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
    const auth = payload?.['https://api.openai.com/auth'];
    return typeof auth?.chatgpt_account_id === 'string' &&
      auth.chatgpt_account_id.length > 0
      ? auth.chatgpt_account_id
      : null;
  } catch {
    return null;
  }
}

async function boundedJson(response) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumSearchResponseBytes) {
    throw new Error('Codex search response exceeded the 2 MB limit');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumSearchResponseBytes) {
    throw new Error('Codex search response exceeded the 2 MB limit');
  }
  if (!response.ok) {
    throw new Error(`Codex search failed with HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Codex search returned invalid JSON');
  }
}

function requiredSessionId(params) {
  if (!params || typeof params.sessionId !== 'string' || !params.sessionId) {
    throw new TypeError('sessionId is required');
  }
  return params.sessionId;
}

class AllRiceHarnessSdkJsonRpcServer extends HarnessSdkJsonRpcServer {
  authorizationNotify = () => undefined;
  codexModels = null;
  nativeTools = new Set();
  nativeToolsRegistered = new Set();
  pendingUserQuestions = new Map();
  userQuestionNotify = () => undefined;
  toolBrokerRequest = async () => {
    throw new Error('AllRice Tool Broker transport is unavailable');
  };

  installUserQuestionProvider() {
    if (!this.ctx.userQuestions) return;
    this.ctx.userQuestions.registerProvider({
      ask: (request) => {
        const session = [...this.sessions.entries()].find(
          ([, record]) => record.handle.agent === request.agent,
        );
        if (!session) {
          throw new Error(
            'AllRice could not bind the user question to a live Session',
          );
        }
        const [sessionId] = session;
        if (this.pendingUserQuestions.has(sessionId)) {
          throw new Error(
            'A user question is already pending for this Session',
          );
        }
        const questionId = `question-${randomUUID()}`;
        return new Promise((resolveQuestion, rejectQuestion) => {
          const abort = () => {
            this.pendingUserQuestions.delete(sessionId);
            rejectQuestion(
              new Error(
                'ask_user_question was aborted before the user answered',
              ),
            );
          };
          request.signal?.addEventListener('abort', abort, { once: true });
          this.pendingUserQuestions.set(sessionId, {
            questionId,
            questions: request.questions,
            resolve: (answer) => {
              request.signal?.removeEventListener('abort', abort);
              resolveQuestion(answer);
            },
            reject: (error) => {
              request.signal?.removeEventListener('abort', abort);
              rejectQuestion(error);
            },
          });
          this.userQuestionNotify({
            sessionId,
            questionId,
            questions: request.questions.map((question) => ({
              id: question.id,
              question: question.question,
              header: question.header ?? null,
              options: (question.options ?? []).map((option) => ({
                label: option.label,
                description: option.description ?? null,
              })),
              multiSelect: question.multiSelect === true,
            })),
          });
        });
      },
    });
  }

  async initialize(params) {
    const requestedTools = Array.isArray(params?.nativeTools)
      ? params.nativeTools.filter((name) => typeof name === 'string')
      : [];
    this.nativeTools = new Set(requestedTools);
    this.registerNativeTools();
    await super.initialize(params);
    return {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version:
          process.env.DSH_DISTRIBUTION_VERSION ?? 'unapproved-development',
      },
      capabilities: {
        interrupt: true,
        steer: true,
        compact: true,
        recover: true,
        close: true,
      },
    };
  }

  registerNativeTools() {
    if (
      this.nativeTools.has('web.search') &&
      !this.nativeToolsRegistered.has('web.search')
    ) {
      this.nativeToolsRegistered.add('web.search');
      this.ctx.systemPrompt.section({
        name: 'tool:web_search',
        order: 110,
        text: 'Use web_search for current information. Provide one to four focused queries, use returned evidence, and cite relevant URLs as Markdown links.',
      });
      this.ctx.tools.register(
        defineTool({
          name: 'web_search',
          description:
            'Search the current web through the AllRice platform Codex Search Provider. Provide one to four focused queries.',
          parameters: {
            queries: {
              type: 'array',
              required: true,
              items: { type: 'string' },
              description: 'One to four non-empty web search queries.',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: value.content }],
          },
          timeoutMs: 60_000,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            if (
              !Array.isArray(args.queries) ||
              args.queries.length < 1 ||
              args.queries.length > 4 ||
              args.queries.some(
                (query) => typeof query !== 'string' || !query.trim(),
              )
            ) {
              throw new Error(
                'queries must contain one to four non-empty strings',
              );
            }
            const queries = [
              ...new Set(args.queries.map((query) => query.trim())),
            ];
            const results = await Promise.all(
              queries.map((query) =>
                this.searchCodex({ query, maxResults: 5 }),
              ),
            );
            return {
              content: results
                .map((result, index) =>
                  results.length === 1
                    ? result.output
                    : `### ${queries[index]}\n\n${result.output}`,
                )
                .join('\n\n'),
            };
          },
          presentCall: (args) => ({
            card: 'generic',
            title: args.queries.join(', '),
            kind: 'search',
            rawInput: args.queries.join(', '),
          }),
        }),
      );
    }

    const requestedLocalTools = localNativeTools.filter(
      (tool) =>
        this.nativeTools.has(tool.canonicalName) &&
        !this.nativeToolsRegistered.has(tool.canonicalName),
    );
    if (requestedLocalTools.length === 0) return;
    this.ctx.systemPrompt.section({
      name: 'tool:allrice_local_bridge',
      order: 111,
      text: 'Use the local_fs_* and local_git_* tools for files and repositories in the user-authorized Rice Bridge workspace. These tools are read-only, tenant-scoped, and may only access relative paths under the explicit folder grant. Never claim local access without a successful tool result.',
    });
    for (const tool of requestedLocalTools) {
      this.nativeToolsRegistered.add(tool.canonicalName);
      this.ctx.tools.register(
        defineTool({
          name: tool.wireName,
          description: tool.description,
          parameters: tool.parameters,
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: value.content }],
          },
          timeoutMs: 65_000,
          isConcurrencySafe: () => true,
          execute: async (args, exec) => {
            const response = await this.toolBrokerRequest(
              {
                toolCallId: exec.callId,
                name: tool.canonicalName,
                arguments: args,
              },
              exec.signal,
            );
            if (
              !response ||
              typeof response !== 'object' ||
              typeof response.modelContent !== 'string'
            ) {
              throw new Error('AllRice Tool Broker returned an invalid result');
            }
            return { content: response.modelContent };
          },
        }),
      );
    }
  }

  async createSession(sessionId) {
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {
          provider: this.provider,
          model: this.model,
          ...(this.maxTokens === undefined
            ? {}
            : { maxTokens: this.maxTokens }),
        },
      });
      const record = { handle };
      this.sessions.set(sessionId, record);
      return record;
    } catch {
      return super.createSession(sessionId);
    }
  }

  async interrupt(params) {
    const sessionId = requiredSessionId(params);
    const record = this.sessions.get(sessionId);
    if (!record) return { interrupted: false };
    const pendingQuestion = this.pendingUserQuestions.get(sessionId);
    if (pendingQuestion) {
      this.pendingUserQuestions.delete(sessionId);
      pendingQuestion.reject(new Error('User question was interrupted'));
    }
    record.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await record.handle.agent.whenIdle();
    return { interrupted: true };
  }

  async steer(params) {
    const sessionId = requiredSessionId(params);
    if (typeof params.text !== 'string' || !params.text.trim()) {
      throw new TypeError('steer text is required');
    }
    const pendingQuestion = this.pendingUserQuestions.get(sessionId);
    if (pendingQuestion) {
      this.pendingUserQuestions.delete(sessionId);
      const answerText = params.text.trim();
      const answers = pendingQuestion.questions.map((question, index) => {
        if (index > 0) return { id: question.id, selected: [] };
        const selected = (question.options ?? []).find(
          (option) => option.label === answerText,
        );
        return selected
          ? { id: question.id, selected: [selected.label] }
          : { id: question.id, selected: [], custom: answerText };
      });
      pendingQuestion.resolve({ answers });
      this.userQuestionNotify({
        sessionId,
        questionId: pendingQuestion.questionId,
        answered: true,
      });
      return {
        messageId: pendingQuestion.questionId,
        answeredQuestion: true,
      };
    }
    const record = await this.getOrCreateSession(sessionId);
    const message = createUserMessage({
      content: [{ type: 'text', text: params.text }],
      source: { kind: 'user' },
    });
    record.handle.agent.steer(message);
    return { messageId: message.id };
  }

  async compact(params) {
    const sessionId = requiredSessionId(params);
    const record = this.sessions.get(sessionId);
    if (!record) return { compacted: false, reason: 'session_not_live' };
    const result = await this.ctx.compaction.compactNow(
      record.handle.agent,
      new AbortController().signal,
    );
    return {
      compacted: result !== null,
      ...(result === null
        ? { reason: 'no_safe_range' }
        : { compactionId: String(result.compactionId) }),
    };
  }

  async sessionProjection(params) {
    const sessionId = requiredSessionId(params);
    const record = this.sessions.get(sessionId);
    const projections = this.ctx.get('sessionProjections');
    if (!record || !projections) {
      return { asOfSeq: null, contextPressure: null };
    }
    const snapshot = projections.snapshot(record.handle.agent.session);
    const value = snapshot.values?.contextPressure;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { asOfSeq: snapshot.asOfSeq, contextPressure: null };
    }
    const pressureTokens = Number(value.pressureTokens);
    const projectedTokens = Number(value.projectedTokens);
    const contextWindow = Number(value.contextWindow);
    return {
      asOfSeq: snapshot.asOfSeq,
      contextPressure: {
        ...(Number.isInteger(pressureTokens) && pressureTokens >= 0
          ? { pressureTokens }
          : {}),
        ...(Number.isInteger(projectedTokens) && projectedTokens >= 0
          ? { projectedTokens }
          : {}),
        ...(Number.isInteger(contextWindow) && contextWindow > 0
          ? { contextWindow }
          : {}),
      },
    };
  }

  async recover(params) {
    const sessionId = requiredSessionId(params);
    const current = this.sessions.get(sessionId);
    if (current) {
      this.sessions.delete(sessionId);
      await current.handle.dispose();
    }
    const record = await this.createSession(sessionId);
    return {
      recovered: true,
      sequence: record.handle.agent.session.seq,
    };
  }

  async closeSession(params) {
    const sessionId = requiredSessionId(params);
    const record = this.sessions.get(sessionId);
    if (!record) return { closed: false };
    const pendingQuestion = this.pendingUserQuestions.get(sessionId);
    if (pendingQuestion) {
      this.pendingUserQuestions.delete(sessionId);
      pendingQuestion.reject(
        new Error('Session closed while awaiting an answer'),
      );
    }
    this.sessions.delete(sessionId);
    await record.handle.dispose();
    return { closed: true };
  }

  async providerStatus() {
    const status =
      await this.ctx.credentials.describeRecord(codexCredentialKey);
    return {
      provider: 'openai-codex',
      configured: status.configured,
      writable: status.writable,
      kind: status.kind ?? null,
    };
  }

  async authorizeCodex() {
    return this.ctx.authorization.begin({
      key: codexCredentialKey,
      method: 'oauth',
      interaction: {
        notify: (notice) => this.authorizationNotify(notice),
        prompt: async (prompt) => {
          if (prompt.kind === 'select') {
            return (
              prompt.options.find((option) => option.id === 'device_code')
                ?.id ?? prompt.options[0]?.id
            );
          }
          throw new Error(
            'The headless AllRice authorization broker supports device-code login only',
          );
        },
      },
    });
  }

  modelsForCodex() {
    if (this.codexModels) return this.codexModels;
    const models = createModels({
      credentials: codexCredentialStore(this.ctx),
    });
    models.setProvider(openaiCodexProvider());
    this.codexModels = models;
    return models;
  }

  async searchCodex(params) {
    const query = typeof params?.query === 'string' ? params.query.trim() : '';
    if (!query || query.length > 2_000) {
      throw new TypeError('query must contain between 1 and 2000 characters');
    }
    const requestedLimit = Number(params?.maxResults ?? 5);
    const maxResults = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 10)
      : 5;
    const models = this.modelsForCodex();
    const provider = models.getProvider('openai-codex');
    const auth = await models.getAuth('openai-codex');
    const accessToken = auth?.auth.apiKey;
    if (!provider || !accessToken) {
      throw new Error('Codex subscription authorization is required');
    }
    const accountId = accountIdFromAccessToken(accessToken);
    if (!accountId) {
      throw new Error('Codex subscription account could not be resolved');
    }
    const baseUrl = (
      provider.baseUrl ?? 'https://chatgpt.com/backend-api'
    ).replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/codex/alpha/search`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        'content-type': 'application/json',
        'user-agent': 'allrice-codex-search/0.1',
      },
      body: JSON.stringify({
        id: `allrice-search-${Date.now()}`,
        model: process.env.DSH_CODEX_MODEL ?? 'gpt-5.6-luna',
        commands: {
          search_query: [{ q: query }],
          response_length: maxResults <= 3 ? 'short' : 'medium',
        },
        settings: {
          search_context_size: maxResults <= 3 ? 'low' : 'medium',
          allowed_callers: ['direct'],
          external_web_access: true,
        },
        max_output_tokens: 4_000,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await boundedJson(response);
    if (!body || typeof body !== 'object' || typeof body.output !== 'string') {
      throw new Error('Codex search returned an invalid response');
    }
    return {
      provider: 'codex-hosted-search',
      query,
      output: body.output,
      results: Array.isArray(body.results)
        ? body.results.slice(0, maxResults)
        : [],
    };
  }

  async handleRequest(method, params) {
    switch (method) {
      case 'session/interrupt':
        return this.interrupt(params);
      case 'session/steer':
        return this.steer(params);
      case 'session/compact':
        return this.compact(params);
      case 'session/projection':
        return this.sessionProjection(params);
      case 'session/recover':
        return this.recover(params);
      case 'session/close':
        return this.closeSession(params);
      case 'provider/status':
        return this.providerStatus();
      case 'provider/authorize-codex':
        return this.authorizeCodex();
      case 'provider/cancel-codex':
        this.ctx.authorization.cancel(codexCredentialKey);
        return { canceled: true };
      case 'provider/web-search':
        return this.searchCodex(params);
      default:
        return super.handleRequest(method, params);
    }
  }
}

installFailLoud(runtimeName);
loadEnv(runtimeName);
const requested = process.env.DSH_CORDIS_CONFIG ?? process.argv[2];
const configPath = requested
  ? resolveConfigPath(requested, undefined, process.cwd())
  : undefined;
if (!configPath || !existsSync(configPath)) {
  process.stderr.write(`${runtimeName}: DSH_CORDIS_CONFIG is required\n`);
  process.exit(1);
}

const ctx = await boot(runtimeName, resolve(configPath));
await ctx.get('loader')?.await();
const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
const server = new AllRiceHarnessSdkJsonRpcServer(ctx, transport, {
  maxTokensAsSuccess: false,
});
server.installUserQuestionProvider();
server.toolBrokerRequest = (params, signal) =>
  transport.request('allrice/tool-call', params, signal);
server.authorizationNotify = (notice) =>
  transport.notify('provider.authorization', {
    provider: 'openai-codex',
    message: notice.message,
    url: notice.url ?? null,
    code: notice.code ?? null,
  });
server.userQuestionNotify = (notice) =>
  transport.notify(
    notice.answered
      ? 'session.user-question-answered'
      : 'session.user-question',
    notice,
  );
let exiting = false;

async function disposeAndExit(code) {
  if (exiting) return;
  exiting = true;
  await Promise.allSettled([
    Promise.resolve().then(() => transport.flush()),
    Promise.resolve().then(() => ctx.root.fiber.dispose()),
  ]);
  process.exit(code);
}

transport.onRequest(async (method, params) => {
  if (method === 'initialize') await ctx.get('loader')?.await();
  const result = await server.handleRequest(method, params);
  if (method === 'shutdown') setImmediate(() => void disposeAndExit(0));
  return result;
});
transport.start();
process.stdin.on('end', () => void disposeAndExit(0));
process.on('SIGTERM', () => void disposeAndExit(0));
process.on('SIGINT', () => void disposeAndExit(130));
