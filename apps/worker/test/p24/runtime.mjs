/* global AbortController, URL, process, setImmediate */
// Test-only host for the pinned native services. It is NOT another Agent loop.
import { resolve } from 'node:path';
import { boot, installFailLoud } from '@deepseek-ai/dsh-app-boot';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';

if (process.env.ALLRICE_P24_TEST !== 'synthetic-only')
  throw new Error('P24 is a test-only host');
const endpoint = new URL(process.env.OPENAI_COMPATIBLE_BASE_URL);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
  throw new Error('P24 model endpoint must be loopback');
installFailLoud('allrice-p24');
const ctx = await boot(
  'allrice-p24',
  resolve(import.meta.dirname, 'poc.cordis.yml'),
);
await ctx.get('loader')?.await();
const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
const governed =
  process.env.ALLRICE_P25_TEST === 'synthetic-only'
    ? (
        await import('../../dsh/allrice-assistant-runtime.mjs')
      ).createGovernedAssistantNativeRuntime(ctx, (method, params, signal) =>
        transport.request(`p25/${method}`, params, signal),
      )
    : null;
const roots = new Map();
const observations = [];
const content = (text) => [{ type: 'text', text }];
const live = (id) => {
  const agent = ctx.agents.get(id);
  if (!agent) throw new Error('agent_not_live');
  return agent;
};
const signal = () => new AbortController().signal;

ctx.on('subagent/start', (info) =>
  observations.push({ event: 'start', ...info }),
);
ctx.on('subagent/end', (info) =>
  observations.push({
    event: 'end',
    id: info.id,
    runId: info.runId,
    stopReason: info.stopReason,
  }),
);
let interactiveRequests = 0;
ctx.on('approval/request', async () => {
  interactiveRequests++;
  return 'allowed-once';
});
ctx.tools.register(
  defineTool({
    name: 'p24_proposal',
    description:
      'Submit a synthetic proposal to the platform. Cannot execute host actions.',
    parameters: { marker: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { content: { type: 'string', required: true } },
      },
      render: (_args, value) => content(value.content),
    },
    timeoutMs: 30_000,
    execute: async (args, exec) => {
      const agent = ctx.agents.requireInitiator();
      const native = await ctx.approval.request({
        agent,
        toolName: 'p24_proposal',
        callId: exec.callId,
        signal: exec.signal,
        reason: 'Synthetic native approval policy probe',
      });
      // Native rejection is never turned into a grant. This separate host request
      // is a proposal only; the test host must independently authorize and execute.
      const result = await transport.request(
        'p24/proposal',
        {
          childId: agent.id,
          parentId: agent.session.header.parentSession,
          callId: exec.callId,
          marker: args.marker,
          nativeOutcome: native,
        },
        exec.signal,
      );
      return {
        content: JSON.stringify({ nativeOutcome: native, platform: result }),
      };
    },
    presentCall: () => ({
      card: 'generic',
      title: 'P24 proposal',
      kind: 'tool',
    }),
  }),
);

async function request(method, p) {
  if (method.startsWith('p25/') && governed) {
    const action = method.slice(4);
    if (
      ![
        'bind',
        'start',
        'followup',
        'drain',
        'inspect',
        'flush',
        'join',
        'finish',
      ].includes(action)
    )
      throw Error('unsupported governed method');
    return governed[action](p);
  }
  if (method === 'ready') return { ready: true };
  if (method === 'create' || method === 'resume') {
    const agentOptions = {
      provider: 'openai-compatible',
      model: 'p24-synthetic',
      ...(governed ? { maxTokens: 1000 } : {}),
    };
    const handle =
      method === 'resume'
        ? await ctx.agents.resume({ resumeSessionId: p.id, agentOptions })
        : await ctx.agents.create({
            sessionId: p.id,
            meta: { cwd: process.env.DSH_CWD },
            agentOptions,
          });
    roots.set(p.id, handle);
    return { id: handle.agent.id };
  }
  if (method === 'start')
    return ctx.subagents.startContinuable({
      provider: 'spawn',
      label: p.label ?? 'P24 synthetic child',
      childId: p.id,
      request: {
        parent: live(p.parentId),
        prompt: content(p.text),
        maxDepth: p.maxDepth ?? 3,
      },
      signal: signal(),
    });
  if (method === 'followup')
    return {
      messageId: await queueHostSubagentPrompt(
        ctx.subagents,
        live(p.parentId),
        p.id,
        content(p.text),
        { kind: 'coordinator', form: 'relay', senderSessionId: p.parentId },
        signal(),
      ),
    };
  if (method === 'message')
    return {
      messageId: await ctx.subagents.sendMessage(
        live(p.id),
        p.targetId,
        content(p.text),
        { signal: signal() },
      ),
    };
  if (method === 'prompt') {
    const message = createUserMessage({
      content: content(p.text),
      source: { kind: 'user' },
    });
    live(p.id).followup(message);
    return { messageId: message.id };
  }
  if (method === 'idle') {
    await live(p.id).whenIdle();
    return { idle: true };
  }
  if (method === 'flush') {
    await ctx.sessions.flush(live(p.id).session);
    return { flushed: true };
  }
  if (method === 'interrupt') {
    ctx.subagents.interrupt(p.id, {
      kind: 'ancestor',
      agent: live(p.parentId),
    });
    return { admitted: true };
  }
  if (method === 'drain') {
    await ctx.subagents.drainContinuableDescendants([live(p.id)]);
    return { drained: true };
  }
  if (method === 'list')
    return { children: await ctx.subagents.listDescendants(p.id, signal()) };
  if (method === 'snapshot') {
    const agent = ctx.agents.get(p.id);
    const safe = new Set([
      'user/message',
      'assistant/message',
      'tool/result',
      'turn/start',
      'turn/end',
      'approval/policy',
      'approval/decided',
    ]);
    return {
      live: !!agent,
      status: agent?.status,
      header: agent?.session.header,
      events:
        agent?.session.snapshotEvents().filter((e) => safe.has(e.type)) ?? [],
      observations,
      interactiveRequests,
    };
  }
  if (method === 'shutdown') {
    for (const handle of roots.values()) {
      await ctx.subagents.drainContinuableDescendants([handle.agent]);
      await handle.dispose();
    }
    setImmediate(async () => {
      await ctx.root.fiber.dispose();
      process.exit(0);
    });
    return { stopped: true };
  }
  throw new Error('unknown_test_method');
}
transport.onRequest(request);
transport.start();
process.stdin.on('end', () => process.exit(0));
