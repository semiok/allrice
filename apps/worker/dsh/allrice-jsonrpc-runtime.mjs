#!/usr/bin/env node
/* global AbortController, process, setImmediate */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  boot,
  installFailLoud,
  loadEnv,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';

const runtimeName = 'allrice-dsh-jsonrpc-runtime';
const codexCredentialKey = credentialKey('llm-pi-ai', 'openai-codex');

function requiredSessionId(params) {
  if (!params || typeof params.sessionId !== 'string' || !params.sessionId) {
    throw new TypeError('sessionId is required');
  }
  return params.sessionId;
}

class AllRiceHarnessSdkJsonRpcServer extends HarnessSdkJsonRpcServer {
  authorizationNotify = () => undefined;

  async initialize(params) {
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
    record.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await record.handle.agent.whenIdle();
    return { interrupted: true };
  }

  async steer(params) {
    const sessionId = requiredSessionId(params);
    if (typeof params.text !== 'string' || !params.text.trim()) {
      throw new TypeError('steer text is required');
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

  async handleRequest(method, params) {
    switch (method) {
      case 'session/interrupt':
        return this.interrupt(params);
      case 'session/steer':
        return this.steer(params);
      case 'session/compact':
        return this.compact(params);
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
server.authorizationNotify = (notice) =>
  transport.notify('provider.authorization', {
    provider: 'openai-codex',
    message: notice.message,
    url: notice.url ?? null,
    code: notice.code ?? null,
  });
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
