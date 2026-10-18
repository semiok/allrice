import { afterEach, expect, it, vi } from 'vitest';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { AllRiceSdkRoot } from './allrice-sdk-root.mjs';
import './allrice-dsh-inputs.mjs';
import './allrice-dsh-waits.mjs';

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-public-sdk-root-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context(),
    calls = [],
    notices = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(options) {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'local public SDK fixture' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'local public SDK fixture' },
      };
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
  ctx.llm.registerAdapter(['allrice-fixture'], new Adapter());
  const server = new AllRiceSdkRoot(ctx, {
    notify(method, params) {
      notices.push({ method, params });
    },
    request() {
      throw Error('no external RPC');
    },
  });
  cleanups.push(async () => {
    await server.shutdown().catch(() => {});
    await ctx.fiber.dispose();
  });
  await server.initializeSdk({
    cwd: root,
    provider: 'allrice-fixture',
    model: 'fixed',
  });
  return { server, ctx, calls, notices, root };
}
it('materializes exactly one SDK-owned root concurrently without model input and rejects another root', async () => {
  const h = await host();
  const [a, b] = await Promise.all([
    h.server.ensureRoot('public-root'),
    h.server.ensureRoot('public-root'),
  ]);
  expect(a).toBe(b);
  expect(h.calls).toHaveLength(0);
  expect(h.ctx.agents.roots()).toHaveLength(1);
  await expect(h.server.ensureRoot('foreign-root')).rejects.toThrow(
    'HOST_SINGLE_ROOT_REQUIRED',
  );
  expect(h.server.requireRoot('public-root').agent).toBe(a.agent);
});
it('cold public resume preserves the original prefix, does not replay, and de-duplicates public event forwarding', async () => {
  const h = await host(),
    id = 'public-recover';
  const r = await h.server.ensureRoot(id);
  await h.server.sdk.prompt({
    sessionId: id,
    contentBlocks: [{ type: 'text', text: 'one fixture input' }],
  });
  await h.server.waitRoot(id);
  const before = globalThis.structuredClone(r.agent.session.snapshotEvents()),
    count = h.calls.length;
  await h.server.closeRoot(id);
  expect((await h.server.closeRoot(id)).closed).toBe(false);
  expect(h.ctx.agents.get(SessionId(id))).toBeUndefined();
  const reopened = await h.server.recoverRoot(id);
  expect(
    reopened.agent.session.snapshotEvents().slice(0, before.length),
  ).toEqual(before);
  await h.server.waitRoot(id);
  expect(h.calls).toHaveLength(count);
  const sequences = h.notices
    .filter((n) => n.method === 'session.event')
    .map((n) => n.params.sessionId + ':' + n.params.event.seq);
  expect(new Set(sequences).size).toBe(sequences.length);
});
it('missing historical state refuses resume and never opens an empty replacement', async () => {
  const h = await host();
  await expect(
    h.server.ensureRoot('missing-history', { resumeOnly: true }),
  ).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' });
  expect(h.calls).toHaveLength(0);
  expect(h.ctx.agents.roots()).toHaveLength(0);
  await expect(h.server.ensureRoot('missing-history')).rejects.toThrow(
    'INPUT_SESSION_NOT_LIVE',
  );
});
it('refuses a foreign live Agent and never claims its handle disposal capability', async () => {
  const h = await host(),
    id = SessionId('foreign-live');
  const handle = await h.ctx.agents.create({
    sessionId: id,
    agentOptions: { provider: 'allrice-fixture', model: 'fixed' },
  });
  cleanups.push(() => handle.dispose());
  await expect(h.server.ensureRoot(String(id))).rejects.toBeDefined();
  expect(h.server.roots.size).toBe(0);
  expect(h.calls).toHaveLength(0);
  const cancel = vi.spyOn(handle.agent, 'cancel');
  await h.server.shutdown();
  expect(cancel).not.toHaveBeenCalled();
  expect(h.ctx.agents.get(id)).toBe(handle.agent);
});
it('opening and close share one lifecycle fence and cannot publish a late ready root', async () => {
  const h = await host();
  let entered, release;
  const arrival = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  h.ctx.on('agent/created', async () => {
    entered();
    await gate;
  });
  const opening = h.server.ensureRoot('opening-root');
  const outcome = opening.then(
    () => null,
    (e) => e,
  );
  await arrival;
  const closing = h.server.closeRoot('opening-root');
  release();
  expect(await outcome).toMatchObject({ message: 'SESSION_CLOSING' });
  await closing;
  expect(h.server.phase).toBe('closed');
  expect(h.server.roots.size).toBe(0);
  expect(h.ctx.agents.roots()).toHaveLength(0);
  expect(h.calls).toHaveLength(0);
});
it('new V4 private facts survive actual SDK close and resume while malformed facts are refused', async () => {
  const h = await host(),
    id = 'private-v4-root',
    r = await h.server.ensureRoot(id);
  await h.server.sdk.prompt({
    sessionId: id,
    contentBlocks: [{ type: 'text', text: 'fixture turn' }],
  });
  await h.server.waitRoot(id);
  const inputId = '11111111-1111-4111-8111-111111111111',
    questionId = 'choice',
    turnId = id + ':turn:1';
  for (const [type, data] of [
    [
      'allrice/wait/checkpoint',
      {
        sessionId: id,
        questionId,
        turnId,
        questions: [
          { id: 'q', question: 'fixture', options: [{ label: 'Continue' }] },
        ],
      },
    ],
    [
      'allrice/input/request',
      {
        inputId,
        digest: 'sha256:' + 'a'.repeat(64),
        messageId: questionId,
        turnId,
      },
    ],
    ['allrice/input/answered', { inputId, questionId, turnId }],
    ['allrice/wait/continued', { inputId, questionId }],
  ])
    r.agent.session.append(type, data);
  await h.ctx.sessions.flush(r.agent.session);
  const before = globalThis.structuredClone(r.agent.session.snapshotEvents());
  await h.server.closeRoot(id);
  const restored = await h.server.recoverRoot(id);
  expect(
    restored.agent.session.snapshotEvents().slice(0, before.length),
  ).toEqual(before);
  expect(h.calls).toHaveLength(1);
  restored.agent.session.append('allrice/input/answered', {
    inputId,
    questionId: 'different',
    turnId,
  });
  await h.ctx.sessions.flush(restored.agent.session);
  await h.server.closeRoot(id);
  await expect(h.server.recoverRoot(id)).rejects.toThrow();
  expect(h.calls).toHaveLength(1);
});

function initializeBarrier() {
  let enter, release;
  const arrival = new Promise((resolve) => {
      enter = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const original = HarnessSdkJsonRpcServer.prototype.initialize;
  const spy = vi
    .spyOn(HarnessSdkJsonRpcServer.prototype, 'initialize')
    .mockImplementation(async function (params) {
      const result = await original.call(this, params);
      enter();
      await gate;
      return result;
    });
  return { arrival, release: () => release(), spy };
}
it('concurrent cold recovery shares one SDK initialization and one managed root', async () => {
  const h = await host(),
    id = 'concurrent-recover';
  await h.server.ensureRoot(id);
  await h.server.closeRoot(id);
  const barrier = initializeBarrier(),
    first = h.server.recoverRoot(id);
  await barrier.arrival;
  const second = h.server.recoverRoot(id);
  expect(barrier.spy).toHaveBeenCalledTimes(1);
  await expect(h.server.ensureRoot(id)).rejects.toThrow(
    'INPUT_SESSION_NOT_LIVE',
  );
  expect(h.server.phase).toBe('recovering');
  barrier.release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(h.ctx.agents.roots()).toHaveLength(1);
  expect(h.calls).toHaveLength(0);
});
it.each(['close', 'shutdown'])(
  '%s fences an in-flight cold initialization and leaves no late root',
  async (mode) => {
    const h = await host(),
      id = 'interrupted-recover';
    await h.server.ensureRoot(id);
    await h.server.closeRoot(id);
    const barrier = initializeBarrier(),
      recovery = h.server.recoverRoot(id);
    const outcome = recovery.catch((error) => error);
    await barrier.arrival;
    let settled = false;
    const stop = (
      mode === 'shutdown' ? h.server.shutdown() : h.server.closeRoot(id)
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    barrier.release();
    expect(await outcome).toMatchObject({ message: 'SESSION_CLOSING' });
    await stop;
    expect(h.server.phase).toBe('closed');
    expect(h.ctx.agents.roots()).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    if (mode === 'shutdown')
      await expect(h.server.recoverRoot(id)).rejects.toThrow('SDK_ROOT_FAILED');
  },
);

it('a close paused in receipt flush rejects compact before it can start maintenance', async () => {
  const h = await host(),
    id = 'closing-maintenance';
  await h.server.ensureRoot(id);
  let entered, release;
  const arrival = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  h.server.taskProgress = {
    async flush() {
      entered();
      await gate;
    },
  };
  let compactCalls = 0;
  h.ctx.provide('compaction', {
    async compactNow() {
      compactCalls++;
      return null;
    },
  });
  const closing = h.server.closeRoot(id);
  await arrival;
  await expect(h.server.compactRoot(id)).rejects.toThrow(
    'INPUT_SESSION_NOT_LIVE',
  );
  expect(compactCalls).toBe(0);
  expect(h.calls).toHaveLength(0);
  release();
  await closing;
  expect(h.ctx.agents.roots()).toHaveLength(0);
});

it('an external close fences recovery while its preceding root drain is still pending', async () => {
  const h = await host(),
    id = 'recover-during-drain';
  await h.server.ensureRoot(id);
  let entered, release;
  const arrival = new Promise((r) => {
      entered = r;
    }),
    gate = new Promise((r) => {
      release = r;
    });
  h.server.taskProgress = {
    async flush() {
      entered();
      await gate;
    },
  };
  const recovery = h.server.recoverRoot(id),
    outcome = recovery.catch((error) => error);
  await arrival;
  const closing = h.server.closeRoot(id);
  release();
  await closing;
  expect(await outcome).toMatchObject({ message: 'SESSION_CLOSING' });
  expect(h.server.phase).toBe('closed');
  expect(h.ctx.agents.roots()).toHaveLength(0);
  expect(h.calls).toHaveLength(0);
});

it('a fresh Host binds its recovery target before waiting on SDK initialization', async () => {
  const h = await host(),
    barrier = initializeBarrier();
  const first = h.server.recoverRoot('first-history'),
    outcome = first.catch((error) => error);
  await barrier.arrival;
  await expect(h.server.recoverRoot('foreign-history')).rejects.toThrow(
    'HOST_SINGLE_ROOT_REQUIRED',
  );
  expect(barrier.spy).toHaveBeenCalledTimes(1);
  barrier.release();
  expect(await outcome).toMatchObject({
    name: 'SessionPersistenceNotFoundError',
  });
  expect(h.calls).toHaveLength(0);
  expect(h.ctx.agents.roots()).toHaveLength(0);
});
