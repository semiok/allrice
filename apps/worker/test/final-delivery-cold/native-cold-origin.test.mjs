import process from 'node:process';
import { afterEach, expect, it, vi } from 'vitest';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import Subagents from '@deepseek-ai/dsh-subagent';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createGovernedAssistantNativeRuntime } from '../../dsh/allrice-assistant-runtime.mjs';
import { verifyRestoredFinalReplyOrigin } from '../../dsh/allrice-final-reply-origin.mjs';
const H = dirname(fileURLToPath(import.meta.url)),
  cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const digest = (text) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
async function fixture({
  missing = false,
  changeOrigin,
  changeEvents,
  injectBindOrigin = false,
  disableReader = false,
} = {}) {
  const manifest = JSON.parse(
    await readFile(join(H, 'fixtures/manifest.json'), 'utf8'),
  );
  const bytes = await readFile(join(H, 'fixtures/same-turn-real-sdk.jsonl'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    manifest.journalSha256,
  );
  const path = await mkdtemp(join(tmpdir(), 'allrice-cold-native-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  let lines = bytes
    .toString()
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  changeEvents?.(lines);
  const destination = join(path, manifest.relativePersistencePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
  const ctx = new Context(),
    models = [],
    bridges = [];
  class ForbiddenModel extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    stream(...args) {
      models.push(args);
      throw Error('MODEL_FORBIDDEN_COLD_RECONCILIATION');
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
    [Subagents, {}],
    [JsonlPersistence, { root: path, compression: 'none' }],
  ])
    await ctx.plugin(plugin, config);
  ctx.llm.registerAdapter(['cold-origin-offline'], new ForbiddenModel());
  const origin = {
    schemaVersion: 1,
    rootRunId: manifest.rootRunId,
    nativeSessionId: manifest.nativeSessionId,
    starts: [
      {
        runEventId: randomUUID(),
        runEventSequence: 7,
        turnId: manifest.nativeSessionId + ':turn:1',
      },
    ],
  };
  changeOrigin?.(origin);
  const reader = vi.fn(async () => (missing ? null : origin));
  const native = createGovernedAssistantNativeRuntime(
    ctx,
    async (action, params) => {
      bridges.push({ action, params });
      if (action.startsWith('model-')) throw Error('MODEL_ADMISSION_FORBIDDEN');
      return { recorded: true };
    },
    {
      controlTools: [],
      ...(disableReader ? {} : { restoreFinalDeliveryOrigin: reader }),
    },
  );
  // Match a fresh Host: bind before native resume; agent/created records tail.
  native.bind({
    nativeSessionId: manifest.nativeSessionId,
    runId: manifest.rootRunId,
    ...(injectBindOrigin
      ? {
          origin,
          eventBoundary: 0,
          restoredReplyOrigin: { turns: [1], lowerBoundary: 0 },
          completionToken: randomUUID(),
        }
      : {}),
  });
  const handle = await ctx.agents.resume({
    resumeSessionId: manifest.nativeSessionId,
    agentOptions: { provider: 'cold-origin-offline', model: 'forbidden' },
  });
  cleanups.push(async () => {
    await handle.dispose();
    await ctx.fiber.dispose();
    expect(models).toEqual([]);
  });
  return {
    manifest,
    agent: handle.agent,
    native,
    reader,
    origin,
    path,
    bridges,
    models,
    lines,
  };
}
it('actual SDK resumes the durable reply and native mints a fresh one-use token without any model/tool dispatch', async () => {
  const h = await fixture(),
    before = h.agent.session.snapshotEvents().length;
  const joined = await h.native.joinForFinalDelivery({
    nativeSessionId: h.manifest.nativeSessionId,
  });
  expect(h.reader).toHaveBeenCalledExactlyOnceWith({
    nativeSessionId: h.manifest.nativeSessionId,
    rootRunId: h.manifest.rootRunId,
  });
  expect(joined.answer).toContain('下载财务表');
  expect(joined.durableSeq).toBe(20);
  expect(joined.textDigest).toBe(digest(joined.answer));
  expect(joined.completionToken).toMatch(/^[a-f0-9-]{36}$/);
  expect(joined.rootBinding.runId).toBe(h.manifest.rootRunId);
  expect(h.agent.session.snapshotEvents()).toHaveLength(before);
  const receipt = await h.native.finish({
    nativeSessionId: h.manifest.nativeSessionId,
    completionToken: joined.completionToken,
    candidateDigest: joined.textDigest,
    factSetDigest: digest('current-facts-read-again'),
  });
  expect(receipt.released).toBe(true);
  expect(receipt.publicMessageId).toBe(joined.publicMessageId);
  expect(
    h.bridges.every(
      ({ action }) =>
        !['model-prepare', 'model-dispatch', 'tool', 'proposal'].includes(
          action,
        ),
    ),
  ).toBe(true);
  await expect(
    h.native.finish({
      nativeSessionId: h.manifest.nativeSessionId,
      completionToken: joined.completionToken,
    }),
  ).rejects.toThrow();
  const events = h.agent.session.snapshotEvents();
  expect(events.filter((e) => e.type === 'turn/start')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'assistant/message')).toHaveLength(3);
  expect(JSON.stringify(events)).not.toContain(joined.completionToken);
  expect(JSON.stringify(events)).not.toContain(joined.rootBinding.bindingId);
  if (process.env.ALLRICE_COLD_ORIGIN_EVIDENCE)
    await writeFile(
      join(
        process.env.ALLRICE_COLD_ORIGIN_EVIDENCE,
        'real-sdk-cold-reconciliation.json',
      ),
      JSON.stringify(
        {
          syntheticOnly: true,
          sdk: '0.2.1-rc.2',
          sourceJournalSha256: h.manifest.journalSha256,
          actualProviderCalls: 0,
          newToolDispatches: 0,
          newTurnStarts: 0,
          durableSeq: joined.durableSeq,
          publicMessageId: joined.publicMessageId,
          originControlReferences: h.origin.starts,
          finishedReceipt: receipt,
          privateCapabilitiesPersisted: false,
        },
        null,
        2,
      ) + '\n',
    );
});
it('cold bind without the private reader still fails; serialized bind origin cannot manufacture capability', async () => {
  const h = await fixture({ disableReader: true, injectBindOrigin: true });
  await expect(
    h.native.joinForFinalDelivery({
      nativeSessionId: h.manifest.nativeSessionId,
      origin: h.origin,
    }),
  ).rejects.toThrow('assistant_completion_public_message_required');
  expect(h.reader).not.toHaveBeenCalled();
});
for (const [name, options] of [
  ['missing current-Run controls', { missing: true }],
  ['wrong Run', { changeOrigin: (o) => (o.rootRunId = randomUUID()) }],
  [
    'wrong native session',
    { changeOrigin: (o) => (o.nativeSessionId = 'other') },
  ],
  [
    'unknown turn',
    {
      changeOrigin: (o) => (o.starts[0].turnId = o.nativeSessionId + ':turn:2'),
    },
  ],
  [
    'not completed',
    { changeEvents: (lines) => (lines.at(-1).data.reason = { kind: 'error' }) },
  ],
  [
    'interrupted final',
    {
      changeEvents: (lines) =>
        (lines.findLast(
          (e) => e.type === 'assistant/message',
        ).data.interrupted = true),
    },
  ],
  [
    'foreign later turn',
    {
      changeEvents: (lines) =>
        lines.push({
          type: 'turn/start',
          seq: 23,
          time: 1792432696000,
          data: { turn: 2 },
        }),
    },
  ],
])
  it(`actual cold runtime rejects ${name} without prompting`, async () => {
    const h = await fixture(options);
    await expect(
      h.native.joinForFinalDelivery({
        nativeSessionId: h.manifest.nativeSessionId,
      }),
    ).rejects.toThrow('assistant_completion_origin_unavailable');
    expect(h.models).toEqual([]);
  });
it('validator rejects a seeded/forked session and out-of-order or duplicate control references', async () => {
  const h = await fixture(),
    session = {
      id: h.agent.session.id,
      header: { ...h.agent.session.header },
      snapshotEvents: () => h.agent.session.snapshotEvents(),
    };
  expect(() =>
    verifyRestoredFinalReplyOrigin(
      { ...session, header: { ...session.header, isSeeded: true } },
      { runId: h.manifest.rootRunId },
      h.origin,
    ),
  ).toThrow('origin_unavailable');
  expect(() =>
    verifyRestoredFinalReplyOrigin(
      session,
      { runId: h.manifest.rootRunId },
      { ...h.origin, starts: [h.origin.starts[0], h.origin.starts[0]] },
    ),
  ).toThrow('origin_unavailable');
});
