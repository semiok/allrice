/* global AbortController, process */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  LlmAdapter,
  createAssistantMessage,
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
import Subagents from '@deepseek-ai/dsh-subagent';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createGovernedAssistantNativeRuntime } from '../../dsh/allrice-assistant-runtime.mjs';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.ts';
import { checkFinalDelivery } from '../../src/final-delivery/policy.ts';
import { createDeliveryMarkup } from '../../src/final-delivery/markup.ts';

import { bindCheckedFinalDeliveryCommitGuard } from '../../src/final-delivery/checked-delivery.ts';
export const ARTIFACT_ID = 'sha256:' + 'a'.repeat(64);
export const cleanups = [];
const originalArtifactIds = process.env.ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS;
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalArtifactIds === undefined)
    delete process.env.ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS;
  else process.env.ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS = originalArtifactIds;
  for (const close of cleanups.splice(0).reverse()) await close();
});

export async function fixture({
  nativeText = '已保留本轮结果。',
  mode = 'checked_native_v1',
  cold = false,
  priorRoot = false,
  missingOrigin = false,
  legacyJoin = false,
  changeBeforeFinish = false,
  finishReceiptMismatch = false,
  projectedOverride,
  missingPort = false,
  noAssistant = false,
  joinUnavailable = false,
  partialOutcome = false,
} = {}) {
  process.env.ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS = JSON.stringify([
    ARTIFACT_ID,
  ]);
  const path = await mkdtemp(join(tmpdir(), 'allrice-cold-adapter-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  const ctx = new Context(),
    models = [],
    notices = [];
  class ForbiddenModel extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    stream(...args) {
      models.push(args);
      throw Error('MODEL_FORBIDDEN');
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
  ctx.llm.registerAdapter(['activation-fixture'], new ForbiddenModel());
  cleanups.push(async () => {
    await ctx.fiber.dispose();
    expect(models).toEqual([]);
  });
  ctx.tools.register(
    defineTool({
      name: 'ask_user_question',
      description: 'Unused no-op fixture',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {} },
        render: () => [],
      },
      execute: async () => {
        throw Error('QUESTION_FORBIDDEN');
      },
    }),
  );
  const id = 'dsh-activation-root',
    runId = randomUUID(),
    sessionId = randomUUID(),
    organizationId = randomUUID(),
    workspaceId = randomUUID(),
    ownerId = randomUUID();
  const handle = await ctx.agents.create({
    sessionId: id,
    meta: { cwd: path },
    agentOptions: { provider: 'activation-fixture', model: 'never-call' },
  });
  const { agent } = handle;
  cleanups.push(() => handle.dispose());
  let requestHandler;
  const native = createGovernedAssistantNativeRuntime(
    ctx,
    async (action) =>
      action === 'settled' ? { wakeParent: false } : { recorded: true },
    {
      controlTools: [],
      restoreFinalDeliveryOrigin: async (params) =>
        (
          await requestHandler(
            'allrice/assistant/final-delivery-origin',
            params,
          )
        ).origin,
    },
  );
  const events = [],
    calls = [],
    checks = [],
    finished = [];
  let selected;
  function reply(text) {
    const message = createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'activation-fixture', model: 'never-call' },
    });
    const turn =
      (agent.session.snapshotEvents().findLast((e) => e.type === 'turn/start')
        ?.data.turn ?? 0) + 1;
    agent.session.append('turn/start', { turn });
    agent.session.append('step/start', { turn, step: 1 });
    const seq = agent.session.append(
      'assistant/message',
      { turn, step: 1, message, stream: [] },
      { surfaceOp: 'append' },
    ).seq;
    agent.session.append('step/end', { turn, step: 1 });
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } });
    return { message, seq };
  }
  const client = {
    setRequestHandler: vi.fn((handler) => {
      requestHandler = handler;
    }),
    recover: vi.fn(async () => ({ recovered: true })),
    subscribe: () => () => {},
    sessionProjection: async () => ({}),
    assistant: vi.fn(async (action, params) => {
      calls.push({ action, params });
      if (action === 'joinForFinalDelivery' && joinUnavailable)
        throw Error('assistant_runtime_disabled');
      if (action === 'joinForFinalDelivery' && legacyJoin)
        return { answer: 'unbound legacy answer' };
      if (action === 'finish' && changeBeforeFinish)
        reply('late changed answer');
      const result = await native[action](params);
      if (action === 'finish' && finishReceiptMismatch)
        return { ...result, durableSeq: result.durableSeq + 1 };
      return result;
    }),
  };
  const runtime = {
    id: 'fixture-runtime',
    client,
    sessionId: id,
    productSessionId: sessionId,
    nativeTools: [],
  };
  vi.spyOn(DshRuntimePool.prototype, 'hasApprovedNativeLaunch').mockReturnValue(
    cold,
  );
  const descriptor = {
    nativeSessionId: id,
    artifactId: ARTIFACT_ID,
    artifactManifestDigest: ARTIFACT_ID,
    distributionGeneration: 'dsh-0.2.1-rc.2-687f282',
    profileId: 'restricted',
    storageContextKey: sessionId,
    storageNamespace: join(path, 'sessions'),
  };
  const pin = {
    ...descriptor,
    organizationId,
    workspaceId,
    ownerId,
    contextKind: 'chat',
    contextId: sessionId,
    firstRunId: randomUUID(),
    firstJobId: randomUUID(),
    firstAttempt: 7,
    boundAt: new Date().toISOString(),
    bindingBasis: 'approved_compatibility_reader',
  };
  vi.spyOn(DshRuntimePool.prototype, 'describeNativeSession').mockReturnValue(
    mode === 'checked_native_v1' && !noAssistant ? descriptor : null,
  );
  vi.spyOn(DshRuntimePool.prototype, 'get').mockReturnValue(undefined);
  vi.spyOn(DshRuntimePool.prototype, 'acquire').mockResolvedValue({
    runtime,
    fresh: true,
    preparation: {
      cache: 'miss',
      reason: 'not_resident',
      changedFields: [],
      credentialResolutionMs: 0,
      previousRuntimeCloseMs: 0,
      initializeMs: 0,
      skillRegistrationMs: null,
      acquireMs: 0,
    },
  });
  vi.spyOn(DshRuntimePool.prototype, 'touch').mockImplementation(() => {});
  vi.spyOn(DshRuntimePool.prototype, 'assertStoredSession').mockResolvedValue();
  const drop = vi.spyOn(DshRuntimePool.prototype, 'drop').mockResolvedValue();
  const adapter = new DshHarnessAdapter({
    runtimeCommand: process.execPath,
    runtimeArgs: [],
    runtimeRoot: path,
  });
  const scope = { organizationId, workspaceId, ownerId, sessionId, runId };
  const facts = {
    scope,
    complete: true,
    authorization: 'current',
    now: '2026-10-19T10:00:00.000Z',
    ownedRunIds: [runId],
    explicitReferenceVersionIds: [],
    artifacts: [],
    checks: [],
    requirements: [],
  };
  const check = vi.fn(async (candidate) => {
    checks.push(candidate);
    expect(() => agent.runMaintenance(async () => {})).toThrow(
      'already has active work',
    );
    expect(() =>
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text: 'late input' }],
          source: { kind: 'user' },
        }),
      ),
    ).toThrow('ASSISTANT_COMPLETING');
    return checkFinalDelivery({
      candidate: projectedOverride ?? candidate.projectedText,
      expectedScope: scope,
      snapshot: facts,
      markup: createDeliveryMarkup(),
      managedOrigins: [],
    });
  });
  const finish = vi.fn(async (proof) => {
    if (mode === 'checked_native_v1')
      expect(() =>
        agent.send(
          createUserMessage({
            content: [{ type: 'text', text: 'between native finish and DB' }],
            source: { kind: 'user' },
          }),
        ),
      ).toThrow('ASSISTANT_COMPLETING');
    finished.push(proof);
    if (!partialOutcome && mode === 'checked_native_v1')
      bindCheckedFinalDeliveryCommitGuard(
        proof,
        Object.freeze({ assertCurrent: vi.fn() }),
      );
    return {
      status: partialOutcome ? 'partial' : 'completed',
      usage: { inputTokens: 17, cachedInputTokens: 2, outputTokens: 5 },
      usageComplete: true,
      cacheUsageKnown: true,
      costEstimateAvailable: false,
    };
  });
  const bound = {
    hasPriorRoot: priorRoot,
    readFinalDeliveryReplyOrigin: vi.fn(async () =>
      missingOrigin
        ? null
        : {
            schemaVersion: 1,
            rootRunId: runId,
            nativeSessionId: id,
            starts: [
              {
                runEventId: randomUUID(),
                runEventSequence: 8,
                turnId: id + ':turn:1',
              },
            ],
          },
    ),
    ...(missingPort || mode === 'legacy' ? {} : { finalDelivery: { check } }),
    finish,
    cancellation: async () => ({ instances: [] }),
    cancel: vi.fn(async () => {}),
    failureUsage: async () => ({
      usage: { inputTokens: 17, cachedInputTokens: 2, outputTokens: 5 },
      usageComplete: true,
      cacheUsageKnown: true,
    }),
  };
  const input = {
    kernel: {
      schemaVersion: 1,
      harness: 'dsh',
      employeeAssignmentId: randomUUID(),
      employeeVersionId: randomUUID(),
      sessionId,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      systemInstructions: 'Fixture only',
      userRequest: 'fixture',
      bootstrapConversation: '',
      authorizedMemoryContext: '',
      grantedCapabilities: ['model:invoke'],
      skillVersionIds: [],
      imageAttachments: [],
    },
    providerSnapshot: {
      provider: 'dsh',
      authMode: 'allrice_credential',
      route: 'openai-compatible',
      model: 'fixture',
      reasoningEffort: 'high',
      credentialReference: 'test:fixture',
      baseUrl: 'https://fixture.invalid/v1',
    },
    storageObjects: [],
    workDirectory: path,
    executionEnvironment: {
      ALLRICE_RUN_ID: runId,
      ALLRICE_JOB_ID: randomUUID(),
    },
    signal: new AbortController().signal,
    attempt: 1,
    generation: 3,
    threadId: id,
    ...(cold || (mode === 'checked_native_v1' && !noAssistant)
      ? {
          nativeBinding: {
            prepare: async () => ({
              binding: pin,
              generation: 3,
              requiresRecovery: cold,
            }),
            bind: async () => ({ binding: pin, generation: 3 }),
          },
        }
      : {}),
    onTurnStarted: async () => {},
    tools: [],
    onEvent: async (event) => events.push(event),
    progress: async () => ({ recorded: true }),
    ...(noAssistant
      ? {}
      : {
          assistants: {
            rootRunId: runId,
            deliveryMode: mode,
            ...(mode === 'checked_native_v1'
              ? { deliveryArtifactId: ARTIFACT_ID }
              : {}),
            bind: async () => bound,
          },
        }),
  };
  if (cold) selected = reply(nativeText);
  const run = vi
    .spyOn(adapter, 'runOnce')
    .mockImplementation(async (options) => {
      selected = reply(nativeText);
      await options.onDelta(
        nativeText,
        undefined,
        selected.message.id,
        'append',
      );
      return {
        answer: noAssistant ? nativeText : 'stale observed candidate',
        replyId: 'observed-runOnce-id',
        usage: { inputTokens: 17, cachedInputTokens: 2, outputTokens: 5 },
        usageComplete: true,
        cacheUsageKnown: true,
      };
    });
  return {
    adapter,
    input,
    native,
    agent,
    bound,
    client,
    descriptor,
    pin,
    get requestHandler() {
      return requestHandler;
    },
    events,
    calls,
    checks,
    finish,
    drop,
    run,
    notices,
    finished,
    get selected() {
      return selected;
    },
    nativeText,
  };
}
