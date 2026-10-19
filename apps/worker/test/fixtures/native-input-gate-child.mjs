// Owned offline fixture: real rc.2 Agent/journal/transport, fixed local responses only.
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
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import {
  createGovernedAssistantNativeRuntime,
  assertAssistantBusinessInputOpen,
  runAssistantBusinessInput,
} from '../../dsh/allrice-assistant-runtime.mjs';
import { deliverDshInput } from '../../dsh/allrice-dsh-inputs.mjs';

const ctx = new Context();
const root = process.env.MET184_INPUT_FIXTURE_ROOT;
if (!root) throw Error('Owned fixture root required');
let steps = 0;
class FixedAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream() {
    steps++;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: `Fixed local response ${steps}` },
    };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
for (const [plugin, config] of [
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
])
  await ctx.plugin(plugin, config);
ctx.llm.registerAdapter(['offline-input-gate'], new FixedAdapter());
const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
let gateScope, inputGate;
const runtime = createGovernedAssistantNativeRuntime(
  ctx,
  (method, params, signal) => {
    if (method === 'input-gate-pause') gateScope = params;
    return transport.request(`allrice/assistant/${method}`, params, signal);
  },
  { controlTools: [] },
);
let handle, gate, id, turn, continueRepair, continueInput;
const errors = [];
ctx.on('agent/error', ({ error }) => errors.push(error.code ?? error.message));
ctx.on('session/event', (session, event) => {
  if (session.id === id && event.type === 'turn/start') {
    turn = `${id}:turn:${event.data.turn}`;
    transport.notify('fixture.turn', { turnId: turn });
  }
});
let stopping = 0;
ctx.on('agent/turn-stopping', async ({ agent, turn: nativeTurn, signal }) => {
  if (agent.id !== id) return;
  stopping++;
  if (stopping === 1) {
    inputGate = await runtime.acquireInputDelivery({
      nativeSessionId: id,
      turn: nativeTurn,
      signal,
    });
    gate = gateScope;
    const wait = new Promise((resolve) => {
      continueRepair = resolve;
    });
    transport.notify('fixture.paused', { gate });
    await wait;
    if (!inputGate.stillCurrent())
      throw Error('Fixture lost original input gate');
    agent.steer(
      createUserMessage({
        source: {
          kind: 'allrice-final-delivery-repair',
          form: 'notice',
          summary: 'Offline host notice',
        },
        content: [
          {
            type: 'text',
            text: 'A fixed local fixture notice, never a human input.',
          },
        ],
      }),
    );
  } else if (stopping === 2) {
    const wait = new Promise((resolve) => {
      continueInput = resolve;
    });
    transport.notify('fixture.repair-reply', { gate, turnId: turn });
    await wait;
    await inputGate.releaseBeforeTurnClose();
    transport.notify('fixture.released', { gate, turnId: turn });
  }
});
transport.onRequest(async (method, params) => {
  if (method === 'fixture/start') {
    id = params.nativeSessionId;
    handle = await ctx.agents.create({
      sessionId: id,
      meta: { cwd: root },
      agentOptions: {
        provider: 'offline-input-gate',
        model: 'fixed-local-data',
        maxTokens: 256,
      },
    });
    runtime.bind({ nativeSessionId: id, runId: params.runId });
    handle.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Original fixture request' }],
      }),
    );
    return { started: true };
  }
  if (method === 'fixture/continue-repair') {
    continueRepair();
    return { continued: true };
  }
  if (method === 'fixture/release-input') {
    continueInput();
    return { continued: true };
  }
  if (method === 'fixture/other-root-open') {
    assertAssistantBusinessInputOpen(runtime, 'session/steer', {
      sessionId: 'historical-other-root',
      inputDelivery: false,
    });
    return { open: true };
  }
  if (method === 'fixture/snapshot') {
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);
    const reader = await ctx.sessionPersistence.open(id, 'read');
    try {
      return {
        events: (await reader.read()).events,
        steps,
        errors,
        networkAttempts:
          globalThis[Symbol.for('allrice.input-gate.networkAttempts')] ?? 0,
      };
    } finally {
      await reader.close();
    }
  }
  if (method === 'session/steer') {
    return runAssistantBusinessInput(runtime, method, params, async () => {
      if (params.inputId !== undefined)
        return deliverDshInput(
          {
            agent: handle.agent,
            sessionId: id,
            flush: () => ctx.sessions.flush(handle.agent.session),
            isCurrent: () => params.turnId === turn,
          },
          params,
        );
      const message = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: params.text }],
      });
      return { messageId: handle.agent.steer(message) };
    });
  }
  if (method.startsWith('allrice/assistant/')) {
    const action = method.slice('allrice/assistant/'.length);
    if (!['joinForFinalDelivery'].includes(action))
      throw Error('Fixture action denied');
    return runtime[action](params);
  }
  if (method === 'shutdown') {
    await handle?.dispose();
    await ctx.fiber.dispose();
    setImmediate(() => {
      void transport.flush().finally(() => process.exit(0));
    });
    return { shutdown: true };
  }
  throw Error('Unknown owned fixture request');
});
transport.start();
