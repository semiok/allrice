// Real rc.2 SDK and actual governed runtime/helper; static responses, no remote provider.
/* global AbortController */
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import {
  createGovernedAssistantNativeRuntime,
  runAssistantBusinessInput,
} from '../../dsh/allrice-assistant-runtime.mjs';
import { deliverDshInput } from '../../dsh/allrice-dsh-inputs.mjs';

const root = process.env.MET184_INPUT_FIXTURE_ROOT;
if (!root) throw Error('Owned fixture root required');
const ctx = new Context();
const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
let config, handle, id, turnId, firstSignal;
let releaseProvider, releasePrepared;
let steps = 0,
  preparedRequests = 0;
const errors = [],
  requests = [],
  toolBodies = [],
  probes = [],
  controlActions = [];
let recoverBodyEntered = 0;
const providerWait = () =>
  new Promise((resolve) => {
    releaseProvider = resolve;
  });
const text = function* (value) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
};
const tool = function* (name) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: `synthetic-tool-${steps}`,
      name,
      arguments: '{}',
    },
  };
};
class FixedAdapter extends LlmAdapter {
  providerRetryPolicy() {
    return { mode: 'always', initialDelayMs: 0, maxDelayMs: 1, jitterRatio: 0 };
  }
  async *stream(options) {
    steps++;
    firstSignal ??= options.signal;
    requests.push({
      step: steps,
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      sameOriginalTurnSignal: options.signal === firstSignal,
      purpose: options.purpose,
    });
    if (
      steps === 2 &&
      ['late-human', 'compaction', 'recover'].includes(config.mode)
    ) {
      const waiting = providerWait();
      transport.notify('fixture.repair-stream', {
        step: steps,
        nativeSessionId: id,
        turnId,
      });
      await waiting;
    }
    if (steps === 2 && config.mode === 'retry') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'SERVER', message: 'Static synthetic failure' },
        },
      };
      return;
    }
    const call =
      steps === 2 && config.mode === 'tool'
        ? 'fixture_business'
        : steps === 2 && config.mode === 'ask'
          ? 'ask_user_question'
          : (steps === 3 && config.mode === 'late-human') ||
              (steps === 2 && config.mode === 'pre-notice-conflict')
            ? 'fixture_business'
            : undefined;
    if (call) yield* tool(call);
    else
      yield* text(
        steps === 1 && config.mode !== 'pass'
          ? config.invalidText
          : config.validText,
      );
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } };
  }
}
for (const [plugin, options] of [
  [LlmRuntime],
  [SessionStore],
  [SessionProjections],
  [SystemPrompt, {}],
  [FsLocal],
  [WorkingDirectory],
  [Tools, {}],
  [AgentRegistry],
  [AgentLoop, { agents: [] }],
  [JsonlPersistence, { root, compression: 'none' }],
  [LlmRetry, {}],
])
  await ctx.plugin(plugin, options);
ctx.llm.registerAdapter(['offline-bounded-repair'], new FixedAdapter());
for (const name of ['fixture_business', 'ask_user_question'])
  ctx.tools.register(
    defineTool({
      name,
      description:
        'Owned static regression fixture; never accesses external data.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.value }],
      },
      timeoutMs: 1000,
      isConcurrencySafe: () => true,
      execute: async () => {
        toolBodies.push({ name, turnId });
        return { value: 'Static owned tool result' };
      },
    }),
  );
const runtime = createGovernedAssistantNativeRuntime(
  ctx,
  (method, params, signal) => {
    controlActions.push(method);
    return transport.request(`allrice/assistant/${method}`, params, signal);
  },
  { controlTools: [] },
);
ctx.on('agent/error', ({ error }) => errors.push(error.code ?? error.message));
ctx.on('session/event', (session, event) => {
  if (session.id === id && event.type === 'turn/start') {
    turnId = `${id}:turn:${event.data.turn}`;
    transport.notify('fixture.turn', { turnId });
  }
});
// A supported request hook can fail after the actual helper consumed its ticket.
// It does not alter the product implementation or substitute a repair driver.
ctx.on(
  'agent/request',
  async (event, next) => {
    const result = await next();
    preparedRequests++;
    if (event.agent.id === id && preparedRequests === 2) {
      if (config.mode === 'prepare-failure')
        throw Error('SYNTHETIC_PREPARE_CALL_REJECTED');
      if (config.mode === 'abort-before-dispatch') {
        const waiting = new Promise((resolve) => {
          releasePrepared = resolve;
        });
        transport.notify('fixture.prepared-request', {
          nativeSessionId: id,
          turnId,
        });
        await waiting;
      }
    }
    return result;
  },
  { prepend: true },
);

transport.onRequest(async (method, params) => {
  if (method === 'fixture/start') {
    config = params;
    id = config.nativeSessionId;
    handle = await ctx.agents.create({
      sessionId: id,
      meta: { cwd: root },
      agentOptions: {
        provider: 'offline-bounded-repair',
        model: 'static-only',
        maxTokens: 256,
      },
    });
    runtime.bind({
      nativeSessionId: id,
      runId: config.runId,
      deliveryMode: 'checked_native_v1',
    });
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Original owned fixture request' }],
      }),
    );
    return { started: true };
  }
  if (method === 'fixture/release-provider') {
    releaseProvider();
    return { continued: true };
  }
  if (method === 'fixture/cancel-prepared') {
    handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    releasePrepared();
    return { canceled: true };
  }
  if (method === 'fixture/probe-rebind') {
    return runtime.bind({
      nativeSessionId: id,
      runId: config.runId,
      deliveryMode: 'checked_native_v1',
    });
  }
  if (method === 'fixture/probe-recover') {
    // The production entry must guard before recoverRoot mutates its Agent.
    // This probe fails if its destructive body could be entered.
    return runAssistantBusinessInput(
      runtime,
      'session/recover',
      { sessionId: id },
      () => {
        recoverBodyEntered++;
        throw Error('SYNTHETIC_RECOVER_BODY_ENTERED');
      },
    );
  }
  if (method === 'fixture/probe-compaction') {
    try {
      for await (const chunk of ctx.llm.stream({
        sessionId: id,
        provider: 'offline-bounded-repair',
        model: 'static-only',
        maxTokens: 128,
        messages: [],
        purpose: 'compaction',
        signal: new AbortController().signal,
      })) {
        void chunk; // must never reach provider
      }
      throw Error('Synthetic compaction unexpectedly passed');
    } catch (error) {
      probes.push({ kind: 'compaction', code: error.code ?? error.message });
      return probes.at(-1);
    }
  }
  if (method === 'fixture/snapshot') {
    await handle.agent.whenIdle();
    let flushError;
    try {
      await runtime.flush();
    } catch (error) {
      flushError = {
        code: error.code ?? error.message,
        message: error.message,
        causes: error.errors?.map((entry) => entry.code ?? entry.message),
      };
    }
    await ctx.sessions.flush(handle.agent.session);
    const reader = await ctx.sessionPersistence.open(id, 'read');
    try {
      return {
        events: (await reader.read()).events,
        steps,
        requests,
        toolBodies,
        probes,
        controlActions,
        preparedRequests,
        errors,
        flushError,
        recoverBodyEntered,
        networkAttempts:
          globalThis[Symbol.for('allrice.input-gate.networkAttempts')] ?? 0,
      };
    } finally {
      await reader.close();
    }
  }
  if (method === 'session/steer')
    return runAssistantBusinessInput(runtime, method, params, () =>
      deliverDshInput(
        {
          agent: handle.agent,
          sessionId: id,
          flush: () => ctx.sessions.flush(handle.agent.session),
          isCurrent: () => params.turnId === turnId,
        },
        params,
      ),
    );
  if (method === 'shutdown') {
    await handle?.dispose();
    await ctx.fiber.dispose();
    setImmediate(() => {
      void transport.flush().finally(() => process.exit(0));
    });
    return { shutdown: true };
  }
  throw Error('Unknown owned bounded-repair fixture request');
});
transport.start();
