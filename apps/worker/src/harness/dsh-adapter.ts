import type { BootstrapReceipt } from '@allrice/contracts';
import { readDshToolResult } from '@allrice/contracts';
import type { SessionReferenceSnapshot } from '@allrice/contracts';
import { randomUUID, createHash } from 'node:crypto';

import {
  HarnessEventSchema,
  harnessContextKey,
  PersonalSkillPinSchema,
  UserQuestionRequestSchema,
  NativeQuestionCheckpointSchema,
  RuntimeNativeInputProofSchema,
  EmployeeSceneReadSchema,
  EmployeeSceneStateSchema,
  ModelStreamDiagnosticSchema,
  ModelCallTimingNotificationSchema,
  type HarnessEvent,
} from '@allrice/contracts';
import type { NativeSessionPin } from '@allrice/database';

import { AgentLoopGuard } from '../agent-loop-guard.js';
import { HandlerError, isConfirmedToolFailure } from '../errors.js';
import { contentGuardFailure } from './dsh/content-guard.js';
import {
  assertFinalDelivery,
  type FinalDeliveryProof,
} from '../final-delivery/guard.js';
import { attachCheckedFinalDelivery } from '../final-delivery/checked-delivery.js';
import { NativeQuestionParked } from './dsh/native-question-wait.js';
import { ReceiptDrainWindow } from './dsh/receipt-drain.js';
import {
  attachExecutionFailureUsage,
  type ExecutionFailureUsage,
} from './dsh/execution-failure-usage.js';
import { projectNativeUsage } from './dsh/native-usage.js';
import { DshAssistantStream } from './dsh/assistant-stream.js';
import {
  DshRunTiming,
  type DshContentCheckPhase,
  type DshRunTimingOutcome,
  type DshRunTimingPoint,
} from './dsh/run-timing.js';
import { toolActivityDetail } from './dsh/tool-activity.js';
import { retainDshCleanupFailure } from './dsh-client-cleanup.js';
import { nativeSessionRecoveryFailure } from './dsh/native-tools.js';
import type {
  HarnessAdapter,
  HarnessExecutionInput,
  HarnessExecutionResult,
} from './adapter.js';
import type { DshNotification } from './dsh-protocol-client.js';
import {
  nativeEventView,
  nativeContextView,
  record,
  shortText,
  sourceMetadata,
  textBlocks,
  type DshSourceMetadata,
  visibleModelText,
} from './dsh/event-projector.js';
import {
  DshRuntimePool,
  type DshRuntime,
  type DshRuntimePoolOptions,
} from './dsh/runtime-pool.js';
import {
  dshInboundToolHandler,
  dshNativeWireNames,
  dshToolBridgeInstructions,
  dshToolEnvelopePrefix,
  isDshSearchTool,
  normalizeAllRiceManagedFileLinks,
  parseDshToolCall,
} from './dsh/tool-bridge.js';

export {
  dshBrokerNativeToolNames,
  dshNativeToolNames,
  dshNativeWireNames,
  normalizeAllRiceManagedFileLinks,
} from './dsh/tool-bridge.js';

type HarnessEventPayload = HarnessEvent extends infer Event
  ? Event extends HarnessEvent
    ? Omit<
        Event,
        | 'schemaVersion'
        | 'harness'
        | 'generation'
        | 'attempt'
        | 'order'
        | 'threadId'
        | 'turnId'
        | 'sessionId'
        | 'messageId'
      >
    : never
  : never;

export class DshHarnessAdapter implements HarnessAdapter {
  readonly kind = 'dsh' as const;
  readonly contextStrategy = 'harness-native' as const;
  readonly capabilities = {
    persistentThreads: true,
    assistantDeltas: true,
    toolEvents: true,
    usageEvents: true,
    interrupt: true,
    steer: true,
    compact: true,
    recover: true,
  } as const;

  private readonly runtimePool: DshRuntimePool;

  constructor(options: DshRuntimePoolOptions = {}) {
    this.runtimePool = new DshRuntimePool(options);
  }

  isConfigured(snapshot: HarnessExecutionInput['providerSnapshot']) {
    return this.runtimePool.isConfigured(snapshot);
  }

  async execute(input: HarnessExecutionInput): Promise<HarnessExecutionResult> {
    const timing = new DshRunTiming({
      runId: input.executionEnvironment.ALLRICE_RUN_ID ?? null,
      sessionId: input.kernel.sessionId,
      attempt: input.attempt,
      generation: input.generation,
      onDiagnostic: (report) => {
        console.info('[AllRice:run-timing]', JSON.stringify(report));
      },
    });
    let outcome: DshRunTimingOutcome = 'failed';
    let releaseLease: (() => void) | undefined;
    try {
      const result = await this.executeObserved(input, timing, (threadId) => {
        releaseLease = this.runtimePool.lease(threadId);
      });
      outcome = 'completed';
      return result;
    } catch (error) {
      outcome = input.signal.aborted
        ? 'aborted'
        : error instanceof NativeQuestionParked
          ? 'waiting'
          : 'failed';
      throw error;
    } finally {
      releaseLease?.();
      timing.finish(outcome);
    }
  }

  private async executeObserved(
    input: HarnessExecutionInput,
    timing: DshRunTiming,
    leaseThread: (threadId: string) => void,
  ): Promise<HarnessExecutionResult> {
    const preparationStarted = performance.now();
    if (input.providerSnapshot.provider !== 'dsh') {
      throw new TypeError('DSH harness requires a DSH provider snapshot');
    }
    const snapshot = input.providerSnapshot;
    const expectedThreadId = `dsh-${harnessContextKey(input.kernel)}${input.contentGuard ? `-${input.contentGuard.nativeContextKey ?? input.contentGuard.generationId}` : ''}`;
    const threadId =
      input.threadId?.startsWith('dsh-') &&
      (!input.contentGuard || input.threadId === expectedThreadId)
        ? input.threadId
        : expectedThreadId;
    // Held until execute() returns, including assistant join and cleanup.
    leaseThread(threadId);
    // A Host already selected for idle close exits before storage is read.
    const idleClose = this.runtimePool.pendingIdleClose(threadId);
    if (idleClose) await idleClose;
    const existing = this.runtimePool.get(threadId);
    const eligibilityStarted = performance.now();
    const callableToolNames = new Set(input.tools.map((tool) => tool.name));
    const authorizedToolNames = new Set(
      input.authorizedToolNames ?? input.tools.map((tool) => tool.name),
    );
    const skillEligibility = (input.nativeSkills ?? []).map((skill) => ({
      skill,
      missingTools: skill.requiredToolRefs.filter(
        (tool) => !authorizedToolNames.has(tool),
      ),
      inactiveTools: skill.requiredToolRefs.filter(
        (tool) => authorizedToolNames.has(tool) && !callableToolNames.has(tool),
      ),
    }));
    const nativeSkills = skillEligibility
      .filter(
        (entry) =>
          entry.missingTools.length === 0 && entry.inactiveTools.length === 0,
      )
      .map((entry) => entry.skill);
    const skillEligibilityMs = performance.now() - eligibilityStarted;
    const systemInstructions = input.kernel.systemInstructions;
    let generation = input.generation;
    const threadBindingStarted = performance.now();
    const prepared = this.runtimePool.hasApprovedNativeLaunch()
      ? await input.nativeBinding?.prepare({
          nativeSessionId: threadId,
          storageContextKey: harnessContextKey(input.kernel),
        })
      : undefined;
    const nativeDescriptor = this.runtimePool.describeNativeSession(
      input,
      threadId,
      prepared?.binding ?? undefined,
      prepared?.origin,
      prepared?.executionBinding,
    );
    // Checked final delivery is this release's protocol on the restricted
    // profile. The artifact frozen on the Run is provenance only (MET-221).
    if (
      input.runDelivery &&
      (!nativeDescriptor || nativeDescriptor.profileId !== 'restricted')
    )
      throw new HandlerError(
        'FINAL_DELIVERY_ARTIFACT_MISMATCH',
        '本轮交付检查与原生执行包不一致；历史内容已保留，未启动模型。',
        false,
      );
    let nativePin: NativeSessionPin | undefined;
    if (nativeDescriptor) {
      if (!input.nativeBinding)
        throw new HandlerError(
          'DSH_NATIVE_SESSION_BINDING_REQUIRED',
          '原生会话尚未获得当前任务授权。',
          false,
        );
      if (prepared?.requiresRecovery)
        await this.runtimePool.assertStoredSession(
          input,
          threadId,
          prepared.binding ?? undefined,
          prepared.origin,
          prepared.executionBinding,
        );
      const bound = prepared?.binding
        ? {
            binding: prepared.binding,
            generation: prepared.generation,
          }
        : await input.nativeBinding.bind(nativeDescriptor);
      // A pin records its first writer's artifact; the executor is always the
      // primary, so the artifact fields alone may differ (MET-221).
      if (
        Object.entries(nativeDescriptor).some(
          ([key, value]) =>
            key !== 'artifactId' &&
            key !== 'artifactManifestDigest' &&
            bound.binding[key as keyof typeof nativeDescriptor] !== value,
        )
      )
        throw new HandlerError(
          'DSH_NATIVE_SESSION_BINDING_CONFLICT',
          '原生会话的制品或数据位置与绑定不一致。',
          false,
        );
      nativePin = bound.binding;
      generation = bound.generation ?? generation;
    } else if (!input.threadId || input.threadId !== threadId) {
      const bound = await input.onThreadBound?.({
        threadId,
        resumed: Boolean(existing),
        replacedThreadId: input.threadId ?? null,
      });
      generation = bound?.generation ?? generation;
    }
    const threadBindingMs = performance.now() - threadBindingStarted;
    if (input.signal.aborted)
      throw new HandlerError(
        'EXECUTION_ABORTED',
        'DSH execution was interrupted',
        false,
      );
    const { runtime, fresh, preparation } = await this.runtimePool.acquire({
      input,
      snapshot,
      threadId,
      systemInstructions,
      nativeSkills,
      nativePin,
      nativeOrigin: prepared?.origin,
      nativeExecutionBinding: prepared?.executionBinding,
      requireRecovery: prepared?.requiresRecovery,
    });
    const runtimeBindingStarted = performance.now();
    this.runtimePool.touch(runtime);
    const finalDeliveryUnavailable = (): never => {
      input.signal.throwIfAborted();
      throw new HandlerError(
        'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
        '本轮公开回复尚不能按原生记录与交付事实确认；已有内容已保留，未自动重跑任务。',
        false,
      );
    };
    // Installed synchronously by runOnce before prompting. Keep it through
    // child join/retry; a later runOnce replaces it with its own turn barrier.
    let awaitTurnOrigin: ((settled?: boolean) => Promise<void>) | undefined;
    const ordinaryHandler = dshInboundToolHandler(input);
    let turnId: string | null = null;
    let contentAuthorizationFailure: HandlerError | undefined;
    const checkContent = async (phase: DshContentCheckPhase = 'other') => {
      if (!input.contentGuard) return;
      try {
        await timing.checkContent(phase, () => input.contentGuard!.check());
      } catch (error) {
        contentAuthorizationFailure ??= contentGuardFailure(error);
        throw contentAuthorizationFailure;
      }
    };
    const runDelivery = input.runDelivery?.bind(generation);
    const deliveryNativeCall = async <T>(
      call: () => Promise<T>,
    ): Promise<T> => {
      const cancel = () => {
        void runtime.client.interrupt(threadId).catch(() => {});
      };
      executionSignal.throwIfAborted();
      executionSignal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await call();
        executionSignal.throwIfAborted();
        return result;
      } catch {
        executionSignal.throwIfAborted();
        return finalDeliveryUnavailable();
      } finally {
        executionSignal.removeEventListener('abort', cancel);
      }
    };
    const nativeDelivery = (
      action: 'bind' | 'candidate' | 'repair' | 'finish',
      params: Record<string, unknown>,
    ) => deliveryNativeCall(() => runtime.client.finalDelivery(action, params));
    runtime.client.setRequestHandler(async (method, params) => {
      if (
        method === 'allrice/final-delivery-origin' ||
        method === 'allrice/final-delivery-authorize'
      ) {
        if (
          !runDelivery ||
          params.nativeSessionId !== threadId ||
          params.rootRunId !== runDelivery.rootRunId
        )
          finalDeliveryUnavailable();
        if (!awaitTurnOrigin) finalDeliveryUnavailable();
        await awaitTurnOrigin!(method === 'allrice/final-delivery-origin');
        executionSignal.throwIfAborted();
        const origin = await runDelivery!.readOrigin();
        if (!origin) finalDeliveryUnavailable();
        executionSignal.throwIfAborted();
        return { origin };
      }
      if (method === 'allrice/personal-skill-check') {
        if (!input.contentGuard) throw Error('personal_skill_guard_unbound');
        const pin = PersonalSkillPinSchema.parse(params);
        const skill = nativeSkills.find(
          (s) => s.id === pin.versionId && s.personal,
        );
        if (
          !skill?.personal ||
          Object.entries(pin).some(
            ([k, v]) => skill.personal![k as keyof typeof pin] !== v,
          )
        )
          throw Error('personal_skill_frozen_identity_mismatch');
        await checkContent('personalSkill');
        return { allowed: true };
      }
      if (
        method === 'allrice/content-scene-load' ||
        method === 'allrice/content-scene-adopt'
      ) {
        try {
          await checkContent('sceneLoad');
          if (method === 'allrice/content-scene-load') {
            const selection = EmployeeSceneReadSchema.omit({
              receiptId: true,
            }).parse(params);
            if (!input.contentGuard?.loadScene)
              throw Error('employee_scene_unbound');
            return await input.contentGuard.loadScene(selection);
          }
          const evidence = EmployeeSceneStateSchema.shape.adopted
            .unwrap()
            .parse(params);
          if (evidence.nativeSessionId !== threadId)
            throw Error('employee_scene_native_scope');
          if (!input.contentGuard?.adoptScene)
            throw Error('employee_scene_unbound');
          return await input.contentGuard.adoptScene(evidence);
        } catch (error) {
          contentAuthorizationFailure ??= contentGuardFailure(error);
          throw contentAuthorizationFailure;
        }
      }
      if (method === 'allrice/content-check') {
        if (!input.contentGuard) throw Error('employee_content_guard_unbound');
        if (params.nativeSessionId !== threadId)
          throw Error('employee_content_native_scope');
        await checkContent('nativeDispatch');
        return { allowed: true };
      }
      if (method === 'allrice/tool-call') await checkContent('toolDispatch');
      if (method === 'allrice/progress') {
        if (
          params.action === 'model_prepare' ||
          (params.action === 'start' && params.kind === 'model')
        )
          await checkContent('modelAdmission');
        if (!input.progress) throw Error('task_progress_disabled');
        if (params.nativeSessionId !== threadId)
          throw Error('task_progress_native_scope');
        const progress = await input.progress(params);
        if (params.kind === 'model' && typeof params.callId === 'string') {
          // Worker progress receipts bracket the model call chain, including
          // native middleware. They are not socket/send/Provider boundaries.
          if (params.action === 'start') timing.modelStarted(params.callId);
          if (params.action === 'finish') timing.modelFinished(params.callId);
        }
        return progress;
      }
      return ordinaryHandler(method, params);
    });
    let ownedDrop: Promise<void> | undefined;
    const dropOwnedHost = () =>
      (ownedDrop ??= this.runtimePool.closeOwned(runtime));
    const stopWindow = new ReceiptDrainWindow(dropOwnedHost);
    const executionSignal = input.signal;
    const onAbort = () => {
      stopWindow.begin();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    let order = 0;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let usageComplete = true;
    let cacheUsageKnown = true;
    const fallbackGuard = input.progress ? undefined : new AgentLoopGuard();
    let toolActivityObserved = false;
    const emit = async (event: HarnessEventPayload) => {
      if (
        event.type === 'tool.started' ||
        event.type === 'tool.completed' ||
        event.type === 'tool.failed'
      )
        toolActivityObserved = true;
      const sourceEventType =
        event.type === 'assistant.delta'
          ? 'assistant/chunk'
          : event.type === 'assistant.completed'
            ? 'assistant/message'
            : event.type === 'usage.updated'
              ? 'assistant/message:usage'
              : 'source' in event && event.source === 'tool_broker'
                ? 'allrice/tool-broker'
                : 'dsh/tool';
      const parsed = HarnessEventSchema.parse({
        schemaVersion: 1,
        harness: this.kind,
        generation,
        attempt: input.attempt,
        order: ++order,
        threadId,
        turnId,
        sessionId: input.kernel.sessionId,
        messageId: input.kernel.assistantMessageId,
        ...('internalTask' in input.kernel
          ? { internalTask: input.kernel.internalTask }
          : {}),
        sourceEventId: `dsh:${input.attempt}:${order}`,
        sourceEventType,
        sourceOccurredAt: new Date().toISOString(),
        sourcePayload: {},
        ...event,
      });
      fallbackGuard?.observe(parsed);
      await input.onEvent(parsed);
    };
    const runtimeBindingMs = performance.now() - runtimeBindingStarted;
    const skillEventsStarted = performance.now();
    let skillEventCount = 0;
    // One durable announcement for the frozen directory, not one transaction
    // per Skill. A warm session already has these exact versions registered.
    if (fresh && nativeSkills.length) {
      await emit({
        type: 'native.event',
        presentation: 'context',
        status: 'completed',
        label: `Skill 已就绪 · ${nativeSkills.length} 个`,
        summary: nativeSkills
          .map((skill) => skill.name)
          .join('、')
          .slice(0, 1_000),
        sourceEventType: 'allrice/skill-readiness',
        sourcePayload: {
          status: 'registered',
          count: nativeSkills.length,
          skills: nativeSkills.map((skill) => {
            const governed = input.baseSkillCatalog?.skills.find(
              (s) => s.id === skill.id,
            );
            return {
              skillId: skill.id,
              skillName: skill.name,
              skillChecksum: skill.checksum,
              ...(governed
                ? {
                    skillVersion: governed.version,
                    skillCatalogChecksum:
                      input.baseSkillCatalog!.snapshotChecksum,
                  }
                : {}),
            };
          }),
        },
      });
      skillEventCount++;
    }
    for (const entry of skillEligibility) {
      if (
        entry.missingTools.length > 0 &&
        !input.baseSkillCatalog?.skills.some((s) => s.id === entry.skill.id)
      ) {
        // Foundation methods are supplied by default, but may require tools
        // this employee is not authorized to use. That is not a failed action.
        await emit({
          type: 'native.event',
          presentation: 'lifecycle',
          status: 'failed',
          label: 'Skill 不可用',
          summary: `${entry.skill.name} 缺少工具：${entry.missingTools.join(', ')}`,
          sourcePayload: {
            skillId: entry.skill.id,
            skillName: entry.skill.name,
            status: 'failed',
            reason: 'required_tools_missing',
            missingTools: entry.missingTools,
          },
        });
        skillEventCount++;
      }
      // An authorized side-effect tool may intentionally be absent from the
      // callable set until the capability router selects it for this turn.
      // That makes the Skill inactive, not broken, so it must not surface as
      // a red tenant-facing failure.
    }
    const skillEventsPersistenceMs = skillEventCount
      ? performance.now() - skillEventsStarted
      : 0;
    let prompt = '';
    let bootstrapReceipt: BootstrapReceipt | undefined;
    let answer = '';
    let waitingForUser: HarnessExecutionResult['waitingForUser'];
    let completedUsage: ExecutionFailureUsage | undefined;
    let interruptedUsage: ExecutionFailureUsage | undefined;
    let checkedDeliveryProof: FinalDeliveryProof | undefined;
    const timingReceipts = new Set<string>();
    // Keep the operator subscription for the entire Run, including child join,
    // failure drain and final flush. Chat events retain their own turn listener.
    const unsubscribeModelTiming = runtime.client.subscribe((notification) => {
      if (notification.method !== 'allrice.modelTiming') return;
      const parsed = ModelCallTimingNotificationSchema.safeParse(
        notification.params,
      );
      if (!parsed.success || timingReceipts.size >= 1024) return;
      const entry = parsed.data,
        receipt = `${entry.callId}:${entry.timing.phase}`;
      if (timingReceipts.has(receipt)) return;
      timingReceipts.add(receipt);
      try {
        console.info(
          '[AllRice:model-timing]',
          JSON.stringify({
            event: 'allrice.model_timing',
            runId: input.executionEnvironment.ALLRICE_RUN_ID ?? null,
            sessionId: runtime.productSessionId,
            nativeSessionId: entry.sessionId,
            callId: entry.callId,
            provider: snapshot.route,
            model: snapshot.model,
            attempt: input.attempt,
            generation,
            timing: entry.timing,
          }),
        );
      } catch {
        /* Logging never changes execution, settlement or retry. */
      }
    });
    try {
      // Cold resume belongs inside the existing cancellation/receipt window.
      // Its host is already owned by the pool, so a stalled read is bounded by
      // MET193 and cannot fall back to an empty same-ID Session. Never reopen a
      // matching live host. This happens before the first possible prompt.
      if (fresh && prepared?.requiresRecovery) {
        if (executionSignal.aborted)
          throw new HandlerError(
            'EXECUTION_ABORTED',
            'DSH execution was interrupted',
            false,
          );
        try {
          await runtime.client.recover(threadId);
        } catch (error) {
          throw nativeSessionRecoveryFailure(error);
        }
      }
      let bootstrap = fresh ? input.kernel.bootstrapConversation : '';
      if (
        runtime.bootstrapCoverage &&
        input.kernel.bootstrapContext &&
        !input.questionWait?.resume
      ) {
        const context = input.kernel.bootstrapContext;
        const scope = `sha256:${createHash('sha256')
          .update(
            JSON.stringify([
              input.kernel.sessionId,
              threadId,
              input.contentGuard?.nativeContextKey ??
                input.contentGuard?.generationId ??
                null,
            ]),
          )
          .digest('hex')}`;
        const candidates = context.segments.map(({ key, digest }) => ({
          key,
          digest,
        }));
        const coverage = await runtime.client.bootstrapCoverage(threadId, {
          scope,
          candidates,
        });
        const covered = new Set(
          coverage.covered.map(({ key, digest }) => `${key}:${digest}`),
        );
        const remaining = context.segments.filter(
          ({ key, digest }) => !covered.has(`${key}:${digest}`),
        );
        bootstrap = remaining.map((segment) => segment.text).join('\n');
        // Synthetic step/repair prompts cannot claim the SQL user's input or
        // final assistant message merely by inheriting a kernel object.
        const directMessage =
          context.userMessage?.digest ===
          `sha256:${createHash('sha256')
            .update(
              JSON.stringify({ role: 'user', text: input.kernel.userRequest }),
            )
            .digest('hex')}`;
        bootstrapReceipt = {
          version: 1,
          scope,
          imported: remaining.map(({ key, digest }) => ({ key, digest })),
          ...(directMessage ? { userMessage: context.userMessage } : {}),
          ...(directMessage && context.assistantMessageId
            ? { assistantMessageId: context.assistantMessageId }
            : {}),
        };
      }
      prompt = [
        dshToolBridgeInstructions(input, new Set(runtime.nativeTools)),
        bootstrap ? `Conversation context:\n${bootstrap}` : '',
        input.kernel.authorizedMemoryContext,
        input.kernel.userRequest,
      ]
        .filter(Boolean)
        .join('\n\n');
      const preparationMs = performance.now() - preparationStarted;
      timing.mark('preparationCompleted');
      // This receipt measures preparation before prompting. Its own write is
      // excluded; native Skill body loads are measured on their tool receipts.
      await emit({
        type: 'native.event',
        presentation: 'context',
        status: 'completed',
        label: '运行准备完成',
        summary: `${fresh ? '新建运行环境' : '复用已有环境'} · ${Math.round(preparationMs)} ms · Skill 记录写入 ${Math.round(skillEventsPersistenceMs)} ms`,
        sourceEventType: 'allrice/runtime-preparation',
        sourcePayload: {
          schemaVersion: 1,
          runtimeId: runtime.id,
          ...preparation,
          skillEligibilityMs,
          threadBindingMs,
          runtimeBindingMs,
          skillEventsPersistenceMs,
          skillEventCount,
          registeredSkillCount: nativeSkills.length,
          preparationMs,
        },
      });
      if (runDelivery) {
        if (!input.runDelivery) finalDeliveryUnavailable();
        // Existing same-Run turns cannot authorize replay of the business prompt.
        if (!input.questionWait?.resume && (await runDelivery.readOrigin()))
          finalDeliveryUnavailable();
        await nativeDelivery('bind', {
          sessionId: threadId,
          rootRunId: runDelivery.rootRunId,
        });
      }
      let deliveryRepair: Record<string, unknown> | undefined;
      let deliveryRepaired = false;
      for (let callIndex = 0; ; callIndex++) {
        // Initialization, event persistence or a previous tool round may
        // outlive the lease. The pin alone never authorizes another prompt.
        if (nativeDescriptor) {
          const admitted = await input.nativeBinding!.bind(nativeDescriptor);
          if (JSON.stringify(admitted.binding) !== JSON.stringify(nativePin))
            throw new HandlerError(
              'DSH_NATIVE_SESSION_BINDING_CONFLICT',
              '原生会话身份已变化。',
              false,
            );
        }
        if (executionSignal.aborted)
          throw new HandlerError(
            'EXECUTION_ABORTED',
            'DSH execution was interrupted',
            false,
          );
        const completion: { candidate: Record<string, unknown> | null } = {
          candidate: null,
        };
        const result = await this.runOnce({
          runtime,
          start: deliveryRepair
            ? () => nativeDelivery('repair', deliveryRepair!)
            : undefined,
          onTimingPoint: (point) => timing.mark(point),
          prompt,
          bootstrapReceipt: callIndex === 0 ? bootstrapReceipt : undefined,
          images: callIndex === 0 ? (input.images ?? []) : [],
          sessionReferences:
            callIndex === 0 ? input.kernel.sessionReferences : undefined,
          signal: executionSignal,
          subscription: snapshot.route === 'openai-codex',
          questionWait: input.questionWait,
          resume: callIndex === 0 ? input.questionWait?.resume : undefined,
          settleDelivery: runDelivery
            ? async (confirmSettled) => {
                await deliveryNativeCall(() => runtime.client.wait(threadId));
                confirmSettled();
                executionSignal.throwIfAborted();
                await input.runDelivery!.pauseInput();
                // candidate closes native ingress and waits once more.
                // Keep runOnce's real notifications/usage subscribed across
                // both waits, including any descendant-woken root turns.
                completion.candidate = await nativeDelivery('candidate', {
                  sessionId: threadId,
                });
              }
            : undefined,
          onFailureUsage: (receipt) => {
            interruptedUsage = {
              ...receipt,
              usageComplete: usageComplete && receipt.usageComplete,
              cacheUsageKnown: cacheUsageKnown && receipt.cacheUsageKnown,
              usage: {
                inputTokens: usage.inputTokens + receipt.usage.inputTokens,
                cachedInputTokens:
                  usage.cachedInputTokens + receipt.usage.cachedInputTokens,
                outputTokens: usage.outputTokens + receipt.usage.outputTokens,
              },
            };
          },
          ...(runDelivery
            ? {
                installTurnOriginBarrier: (
                  barrier: (settled?: boolean) => Promise<void>,
                ) => {
                  awaitTurnOrigin = barrier;
                },
              }
            : {}),
          onTurn: async (nextTurnId) => {
            turnId = nextTurnId;
            if (runDelivery && !input.onTurnStarted) finalDeliveryUnavailable();
            await input.onTurnStarted?.({ threadId, turnId: nextTurnId });
          },
          onDelta: async (text, source, replyId, textMode) => {
            if (text) timing.mark('firstVisibleText');
            await emit({
              type: 'assistant.delta',
              text,
              ...source,
              replyId,
              textMode,
            });
          },
          onNative: async (event) => {
            // Directory registration is not adoption. Attach exact frozen
            // identity only to an actual native Skill call/result.
            if (
              (event.type === 'tool.started' ||
                event.type === 'tool.completed' ||
                event.type === 'tool.failed') &&
              event.name === 'skill'
            ) {
              const name = event.sourcePayload?.skillName;
              const skill = nativeSkills.find((s) => s.name === name);
              const governance = input.baseSkillCatalog?.skills.find(
                (s) => s.id === skill?.id,
              );
              const scene = input.contentGuard?.scenes?.find(
                (s) => s.nativeName === name,
              );
              if (scene)
                event = {
                  ...event,
                  label: `工作场景 · ${scene.name}`,
                  sourcePayload: {
                    ...event.sourcePayload,
                    sceneId: scene.id,
                    sceneDigest: scene.digest,
                    sceneName: scene.name,
                  },
                };
              if (skill)
                event = {
                  ...event,
                  sourcePayload: {
                    ...event.sourcePayload,
                    skillId: skill.id,
                    skillChecksum: skill.checksum,
                    ...(skill.personal
                      ? { personalSkill: skill.personal }
                      : {}),
                    ...(governance
                      ? {
                          skillVersion: governance.version,
                          skillCatalogChecksum:
                            input.baseSkillCatalog!.catalogChecksum,
                        }
                      : {}),
                    ...(skill.bundle
                      ? { skillBundleChecksum: skill.bundle.checksum }
                      : {}),
                  },
                };
            }
            await emit(event);
          },
        });
        const joined = completion.candidate;
        deliveryRepair = undefined;
        usage.inputTokens += result.usage.inputTokens;
        usage.cachedInputTokens += result.usage.cachedInputTokens;
        usage.outputTokens += result.usage.outputTokens;
        usageComplete &&= result.usageComplete;
        cacheUsageKnown &&= result.cacheUsageKnown;
        completedUsage = { usage, usageComplete, cacheUsageKnown };
        waitingForUser = result.waitingForUser;
        if (waitingForUser) {
          executionSignal.throwIfAborted();
          await checkContent('beforePublication');
          break; // Worker confirms the ledger before publishing a wait receipt.
        }
        const toolCall = parseDshToolCall(result.answer);
        if (deliveryRepaired && toolCall) finalDeliveryUnavailable();
        // This narrow path has no external join/validation/wait between its
        // three adjacent checks. Keep the final current-authority barrier;
        // do not reuse it across tools, resumed waits or assistant work.
        const plainCompletion =
          !toolCall &&
          !input.finalDelivery &&
          !runDelivery &&
          callIndex === 0 &&
          !input.questionWait?.resume &&
          !toolActivityObserved;
        if (!plainCompletion) await checkContent('afterNativeResult');
        if (!toolCall) {
          // These capabilities remain in this call frame. Never attach them to
          // Harness events, model prompts, execution results or failure diagnostics.
          const finalDelivery = runDelivery ?? input.finalDelivery;
          if (runDelivery) {
            if (!joined) finalDeliveryUnavailable();
            const inspection = await runDelivery.inspect({
              nativeSessionId: threadId,
              turn: joined!.turn,
              publicMessageId: joined!.publicMessageId,
              durableSeq: joined!.durableSeq,
              text: joined!.answer,
              candidateDigest: joined!.textDigest,
              provider: joined!.provider,
              model: joined!.model,
            });
            if (!deliveryRepaired && inspection.decision === 'repair') {
              deliveryRepaired = true;
              deliveryRepair = {
                sessionId: threadId,
                completionToken: joined!.completionToken,
                inspection,
              };
              continue;
            }
          }
          const rootBinding = record(joined?.rootBinding);
          const privateId =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (
            runDelivery &&
            (!joined ||
              typeof joined.answer !== 'string' ||
              !joined.answer.trim() ||
              typeof joined.publicMessageId !== 'string' ||
              !joined.publicMessageId ||
              !Number.isSafeInteger(joined.durableSeq) ||
              (joined.durableSeq as number) < 0 ||
              joined.textDigest !==
                `sha256:${createHash('sha256')
                  .update(joined.answer as string, 'utf8')
                  .digest('hex')}` ||
              typeof joined.completionToken !== 'string' ||
              !privateId.test(joined.completionToken) ||
              rootBinding?.nativeSessionId !== threadId ||
              rootBinding?.runId !== runDelivery!.rootRunId ||
              typeof rootBinding?.bindingId !== 'string' ||
              !privateId.test(rootBinding.bindingId))
          )
            finalDeliveryUnavailable();
          const nativeCandidate =
            typeof joined?.answer === 'string' ? joined.answer : result.answer;
          const projectedCandidate =
            normalizeAllRiceManagedFileLinks(nativeCandidate);
          executionSignal.throwIfAborted();
          if (!plainCompletion) await checkContent('beforeDeliveryValidation');
          const deliveryReceipt = finalDelivery
            ? await assertFinalDelivery({
                port: finalDelivery,
                candidate: {
                  nativeText: nativeCandidate,
                  projectedText: projectedCandidate,
                  nativeSessionId: threadId,
                  ...(result.replyId
                    ? { observedReplyId: result.replyId }
                    : {}),
                  ...(joined
                    ? {
                        publicMessageId: joined.publicMessageId as string,
                        durableSeq: joined.durableSeq as number,
                        nativeBindingId: rootBinding!.bindingId as string,
                        rootRunId: runDelivery!.rootRunId,
                      }
                    : {}),
                  attempt: input.attempt,
                  generation,
                },
                signal: executionSignal,
                report: async (receipt) => {
                  await emit({
                    type: 'native.event',
                    presentation: 'lifecycle',
                    status: receipt.status === 'valid' ? 'completed' : 'failed',
                    label:
                      receipt.status === 'valid'
                        ? '交付说明已核对'
                        : '交付说明尚未通过核对',
                    summary:
                      receipt.status === 'valid'
                        ? '文件引用已按当前权限与精确成果版本核对；不代表业务内容或视觉检查全部通过。'
                        : '已有成果与原回复已保留，本轮尚未完成；未自动重跑任务。',
                    sourceEventType: 'allrice/final-delivery-validation',
                    sourcePayload: { ...receipt },
                  });
                },
              })
            : undefined;
          executionSignal.throwIfAborted();
          await checkContent('beforePublication');
          executionSignal.throwIfAborted();
          if (runDelivery) {
            if (!joined || !deliveryReceipt || !rootBinding)
              finalDeliveryUnavailable();
            const proof: FinalDeliveryProof = Object.freeze({
              nativeSessionId: threadId,
              publicMessageId: joined!.publicMessageId as string,
              durableSeq: joined!.durableSeq as number,
              nativeBindingId: rootBinding!.bindingId as string,
              nativeCandidateDigest: deliveryReceipt!.nativeCandidateDigest,
              candidateDigest: deliveryReceipt!.candidateDigest,
              factSetDigest: deliveryReceipt!.factSetDigest,
              attempt: input.attempt,
              generation,
            });
            const released = await nativeDelivery('finish', {
              sessionId: threadId,
              completionToken: joined!.completionToken,
              candidateDigest: proof.nativeCandidateDigest,
              factSetDigest: proof.factSetDigest,
            });
            if (
              released.released !== true ||
              released.publicMessageId !== proof.publicMessageId ||
              released.durableSeq !== proof.durableSeq ||
              released.textDigest !== proof.nativeCandidateDigest ||
              released.factSetDigest !== proof.factSetDigest
            )
              finalDeliveryUnavailable();
            runDelivery.finish(proof);
            checkedDeliveryProof = proof;
          }
          answer = projectedCandidate;
          timing.mark('beforePublication');
          await emit({
            type: 'assistant.completed',
            text: answer,
            replyId:
              (joined?.publicMessageId as string | undefined) ?? result.replyId,
            ...(result.completionSource ?? {}),
          });
          timing.mark('publicationCompleted');
          await emit({
            type: 'usage.updated',
            ...usage,
            ...(result.usageSource ?? result.completionSource ?? {}),
          });
          break;
        }
        if (!input.tools.some((tool) => tool.name === toolCall.name)) {
          throw new HandlerError(
            'TOOL_NOT_ALLOWED',
            `DSH requested an unavailable tool: ${toolCall.name}`,
            false,
          );
        }
        if (!input.onToolCall) {
          throw new HandlerError(
            'TOOL_NOT_ALLOWED',
            'No AllRice Tool Broker is available for this execution',
            false,
          );
        }
        await emit({
          type: 'tool.started',
          toolCallId: toolCall.id,
          name: toolCall.name,
          label: toolCall.name,
          source: 'tool_broker',
          sourceEventType: 'allrice/tool-broker',
          sourcePayload: {
            activityDetail: toolActivityDetail(
              toolCall.name,
              toolCall.arguments,
            ),
            presentation: isDshSearchTool(toolCall.name) ? 'search' : 'tool',
            status: 'started',
            query:
              isDshSearchTool(toolCall.name) &&
              typeof toolCall.arguments.query === 'string'
                ? toolCall.arguments.query.slice(0, 500)
                : undefined,
          },
        });
        try {
          const envelopeDigest = (value: unknown) =>
            `sha256:${createHash('sha256')
              .update(JSON.stringify(value) ?? 'null')
              .digest('hex')}`;
          if (input.progress)
            await input.progress({
              action: 'start',
              kind: 'tool',
              nativeSessionId: threadId,
              callId: toolCall.id,
              name: toolCall.name,
              argumentsDigest: envelopeDigest(toolCall.arguments),
            });
          const toolResult = await input.onToolCall(toolCall);
          if (input.progress)
            await input.progress({
              action: 'finish',
              kind: 'tool',
              nativeSessionId: threadId,
              callId: toolCall.id,
              resultDigest: envelopeDigest(toolResult.modelContent),
              outcome: toolResult.itemCount === 0 ? 'empty' : 'success',
            });
          await emit({
            type: 'tool.completed',
            toolCallId: toolCall.id,
            name: toolCall.name,
            label: toolCall.name,
            source: 'tool_broker',
            summary: toolResult.summary,
            sourceEventType: 'allrice/tool-broker',
            sourcePayload: {
              presentation: isDshSearchTool(toolCall.name) ? 'search' : 'tool',
              status: 'completed',
              summary: toolResult.summary,
            },
            ...(toolResult.itemCount === undefined
              ? {}
              : { itemCount: toolResult.itemCount }),
          });
          prompt = `<allrice_tool_result>${JSON.stringify({
            id: toolCall.id,
            ok: true,
            content: toolResult.modelContent,
          })}</allrice_tool_result>\n\nContinue the original user request using this tool result. Any text emitted alongside the preceding tool envelope was not delivered to the user. Return a complete, self-contained answer incorporating the result and any corrections, not just an addendum to an unseen draft.`;
        } catch (error) {
          await emit({
            type: 'tool.failed',
            toolCallId: toolCall.id,
            name: toolCall.name,
            label: toolCall.name,
            source: 'tool_broker',
            summary: error instanceof Error ? error.message : 'tool failed',
            sourceEventType: 'allrice/tool-broker',
            sourcePayload: {
              presentation: isDshSearchTool(toolCall.name) ? 'search' : 'tool',
              status: 'failed',
            },
          });
          const readSelectionFailure =
            toolCall.name === 'workspace.file.read' &&
            error instanceof HandlerError &&
            ['TOOL_FILE_TYPE_UNSUPPORTED', 'TOOL_FILE_TOO_LARGE'].includes(
              error.code,
            );
          const runId = input.executionEnvironment.ALLRICE_RUN_ID;
          // Reuse the Broker's exact, in-process failure receipt. A code or
          // model-supplied error cannot establish a write's outcome. Ordinary
          // confirmed rejections are results for DSH to handle, just as in the
          // native tool path; assistant settlement keeps its own lifecycle.
          const confirmedFailure =
            !executionSignal.aborted &&
            !contentAuthorizationFailure &&
            error instanceof HandlerError &&
            !!runId &&
            isConfirmedToolFailure(error, {
              runId,
              callId: toolCall.id,
              toolName: toolCall.name,
            });
          // Admission, cancellation, unknown writes and failed progress
          // settlement stay fatal. Existing loop/progress policy still bounds
          // repeated errors; this does not replay the invocation.
          if (
            error instanceof HandlerError &&
            (readSelectionFailure || confirmedFailure)
          ) {
            executionSignal.throwIfAborted();
            if (input.progress)
              await input.progress({
                action: 'finish',
                kind: 'tool',
                nativeSessionId: threadId,
                callId: toolCall.id,
                outcome: 'error',
                resultDigest: `sha256:${createHash('sha256')
                  .update(error.code)
                  .digest('hex')}`,
              });
            const guidance = readSelectionFailure
              ? 'Correct this read-only file selection or explain the limitation; preserve completed work and do not repeat writes.'
              : 'This invocation has a confirmed failure receipt. Do not claim it succeeded. Correct arguments only when supported by the existing user instruction; otherwise explain or ask for the missing information. Preserve completed work and do not replay completed or outcome-unknown writes.';
            prompt = `<allrice_tool_result>${JSON.stringify({
              id: toolCall.id,
              ok: false,
              error: { code: error.code, message: error.message },
            })}</allrice_tool_result>\n\nContinue the original user request. ${guidance} Any text emitted alongside the preceding tool envelope was not delivered to the user. Return a complete, self-contained answer.`;
            continue;
          }
          throw error;
        }
      }
    } catch (caught) {
      if (caught instanceof NativeQuestionParked && input.questionWait) {
        for (const key of [
          'inputTokens',
          'cachedInputTokens',
          'outputTokens',
        ] as const)
          caught.receipt.usage[key] += usage[key];
        caught.receipt.usageComplete &&= usageComplete;
        caught.receipt.cacheUsageKnown &&= cacheUsageKnown;
        try {
          await input.questionWait.park(caught.checkpoint, caught.receipt);
          caught.persisted = true;
        } finally {
          await this.runtimePool.drop(threadId);
        }
        throw caught;
      }
      // Preserve a trusted local admission denial rather than the native RPC's
      // generic retryable wrapper. Never classify from model-supplied text.
      const error =
        contentAuthorizationFailure ??
        (input.questionWait?.resume &&
        caught instanceof HandlerError &&
        caught.retryable
          ? new HandlerError(
              'NATIVE_WAIT_RECOVERY_REJECTED',
              '等待恢复未得到确认，未自动重放任务；请查看保留的执行记录。',
              false,
            )
          : caught);
      stopWindow.begin();
      const failedUsage = interruptedUsage ?? completedUsage;
      let cleanupFailure: { error: unknown } | undefined;
      try {
        await dropOwnedHost();
      } catch (closeError) {
        cleanupFailure = { error: closeError };
      }
      // The original dispatch owns this closure. dropOwnedHost awaits the
      // exact child's close event, rather than treating interrupt/abort, a
      // generic RPC error or a deleted pool entry as physical confirmation.
      // The database port accepts only this already-authorized canceled
      // attempt; retryable failures/crashes and usage remain unknown.
      if (!cleanupFailure && input.questionWait?.confirmStopped)
        await input.questionWait
          .confirmStopped({
            nativeSessionId: runtime.sessionId,
            runtimeId: runtime.id,
          })
          .catch(() => {
            // Preserve the original execution failure and durable started
            // intent on a rejected or unknown receipt write. Never retry it.
          });
      const attachUsage = (failure: unknown) => {
        const runId = input.executionEnvironment.ALLRICE_RUN_ID;
        if (failedUsage && runId)
          attachExecutionFailureUsage(
            failure,
            runId,
            input.attempt,
            failedUsage,
          );
      };
      const failure = input.signal.aborted
        ? new HandlerError(
            'EXECUTION_ABORTED',
            'DSH execution was interrupted',
            false,
          )
        : error;
      const finalFailure = cleanupFailure
        ? retainDshCleanupFailure(failure, cleanupFailure.error)
        : failure;
      // An unconfirmed close may conservatively disable a retryable failure.
      // Bind trusted usage/diagnostics to the exact object the Worker receives.
      attachUsage(finalFailure);
      throw finalFailure;
    } finally {
      try {
        input.signal.removeEventListener('abort', onAbort);
        this.runtimePool.touch(runtime);
        runtime.client.setRequestHandler(null);
      } finally {
        stopWindow.dispose();
        unsubscribeModelTiming();
      }
    }
    const result: HarnessExecutionResult = {
      answer,
      ...(waitingForUser ? { waitingForUser } : {}),
      usage,
      usageComplete,
      cacheUsageKnown,
      provider: snapshot.route,
      model: snapshot.model,
      threadId,
      turnId,
      nativeContextPressure: await runtime.client
        .sessionProjection(runtime.sessionId)
        .then((projection) =>
          projection.contextPressure
            ? {
                ...(projection.asOfSeq === undefined
                  ? {}
                  : { asOfSeq: projection.asOfSeq }),
                ...projection.contextPressure,
              }
            : null,
        )
        .catch(() => null),
    };
    if (checkedDeliveryProof)
      attachCheckedFinalDelivery(result, checkedDeliveryProof);
    return result;
  }

  async interrupt(input: { threadId: string }) {
    await this.runtimePool.interrupt(input.threadId);
  }

  async compact(input: { threadId: string }) {
    await this.runtimePool.compact(input.threadId);
  }

  async recover(input: { threadId: string }) {
    await this.runtimePool.recover(input.threadId);
  }

  async steer(input: {
    threadId: string;
    message: string;
    turnId: string;
    clientUserMessageId: string;
    inputKind?: 'steer_current' | 'ask_user';
  }) {
    const result = await this.runtimePool.steer(
      input.threadId,
      input.message,
      input.inputKind
        ? {
            inputId: input.clientUserMessageId,
            turnId: input.turnId,
            kind: input.inputKind,
          }
        : undefined,
    );
    if (input.inputKind) {
      const { RuntimeNativeInputProofSchema } =
        await import('@allrice/contracts');
      const proof = RuntimeNativeInputProofSchema.parse(result);
      if (
        proof.inputId !== input.clientUserMessageId ||
        (proof.status === 'adopted' && proof.turnId !== input.turnId)
      )
        throw new Error('DSH_INPUT_PROOF_MISMATCH');
      return proof;
    }
  }

  async close() {
    await this.runtimePool.close();
  }

  runtimeClosureInventory() {
    return this.runtimePool.closureInventory();
  }

  runtimeInventory() {
    return this.runtimePool.inventory();
  }

  setIdleCloseGate(gate: () => boolean) {
    this.runtimePool.setIdleCloseGate(gate);
  }

  private async runOnce(input: {
    onTimingPoint(point: DshRunTimingPoint): void;
    sessionReferences?: SessionReferenceSnapshot[];
    bootstrapReceipt?: BootstrapReceipt;
    runtime: DshRuntime;
    prompt: string;
    start?(): Promise<unknown>;
    images: HarnessExecutionInput['images'];
    signal: AbortSignal;
    subscription: boolean;
    questionWait?: HarnessExecutionInput['questionWait'];
    resume?: NonNullable<HarnessExecutionInput['questionWait']>['resume'];
    /** Hold event intake through public wait, input pause and final candidate. */
    settleDelivery?(confirmSettled: () => void): Promise<void>;
    onFailureUsage(receipt: ExecutionFailureUsage): void;
    onTurn(turnId: string): Promise<void>;
    /** Private persistence ACK, never a model-supplied barrier. */
    installTurnOriginBarrier?(
      barrier: (settled?: boolean) => Promise<void>,
    ): void;
    onDelta(
      text: string,
      source: DshSourceMetadata,
      replyId?: string,
      textMode?: 'append' | 'replace',
    ): Promise<void>;
    onNative(event: HarnessEventPayload): Promise<void>;
  }) {
    let rawAnswer = '';
    let answer = '';
    let visibleLength = 0;
    let deltaBuffer = '';
    let deltaMode: 'unknown' | 'answer' | 'tool' = 'unknown';
    let replyId: string | undefined;
    const resetReply = () => {
      rawAnswer = '';
      answer = '';
      visibleLength = 0;
      deltaBuffer = '';
      deltaMode = 'unknown';
      activeReasoningBlocks.clear();
    };
    let eventChain = Promise.resolve();
    let processingError: unknown;
    let idle = false;
    let started = false;
    let turnOriginCommitted = false;
    let usageSettled = false;
    let runtimeClosed = false;
    const confirmUsageSettled = () => {
      if (!input.signal.aborted) usageSettled = idle;
    };
    const flushEvents = async () => {
      let pending;
      do {
        pending = eventChain;
        await pending;
      } while (pending !== eventChain);
      if (processingError) throw processingError;
    };
    input.installTurnOriginBarrier?.(async (settled) => {
      await flushEvents();
      // Only public wait or the candidate's post-wait origin request confirms
      // execution settlement. Authorization before a model call does not.
      if (settled) confirmUsageSettled();
      if (!started || !turnOriginCommitted)
        throw new HandlerError(
          'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          '本轮原生 turn 起点尚未持久确认；未发送模型请求。',
          false,
        );
    });
    let waitTimer: NodeJS.Timeout | undefined;
    let parking: Promise<unknown> | undefined;
    let parkingQuestion = false;
    let progressQuestionId: string | undefined;
    let progressQuestionPending: HarnessExecutionResult['waitingForUser'];
    let waitingForUser: HarnessExecutionResult['waitingForUser'];
    let settle!: () => void;
    const idlePromise = new Promise<void>((resolveIdle) => {
      settle = resolveIdle;
    });
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let completionSource: DshSourceMetadata | undefined;
    let usageSource: DshSourceMetadata | undefined;
    let usageComplete = true;
    let cacheUsageKnown = true;
    let messageReceipts = 0;
    let observedModelOutput = false;
    const activeReasoningBlocks = new Set<number>();
    const assistantStream = new DshAssistantStream();
    const activeNativeTools = new Map<
      string,
      { name: string; query?: string; sourceStartedAt: number }
    >();
    const processNotification = async (notification: DshNotification) => {
      if (notification.params.sessionId !== input.runtime.sessionId) return;
      if (
        input.signal.aborted &&
        notification.method === 'session.assistant-stream'
      )
        return;
      if (notification.method === 'allrice.modelWait') {
        const { callId, status } = notification.params;
        if (
          typeof callId !== 'string' ||
          !/^[a-f0-9-]{36}$/i.test(callId) ||
          !['started', 'completed', 'failed'].includes(String(status))
        )
          return;
        await input.onNative({
          type: 'native.event',
          presentation: 'lifecycle',
          status: status as 'started' | 'completed' | 'failed',
          label: '等待模型响应',
          summary:
            status === 'started'
              ? '模型暂未返回新内容，正在等待响应。'
              : status === 'completed'
                ? '模型已恢复响应。'
                : '模型响应中断或等待超时。',
          sourceEventType: 'allrice/model-wait',
          sourceEventId: `dsh:model-wait:${callId}:${status}:${randomUUID()}`,
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: { callId, status },
        });
        return;
      }
      if (notification.method === 'allrice.modelStream') {
        const { callId } = notification.params;
        const parsed = ModelStreamDiagnosticSchema.safeParse(
          notification.params.diagnostic,
        );
        if (
          typeof callId !== 'string' ||
          !/^[a-f0-9-]{36}$/i.test(callId) ||
          !parsed.success
        )
          return;
        const diagnostic = parsed.data;
        const summaries = {
          transport_closed: '模型连接已关闭。',
          heartbeat_only: '连接仍有心跳，但模型未返回新内容。',
          missing_terminal: '模型已返回输出项，但未收到响应结束事件。',
          transport_active: '连接仍有数据，但模型未返回可用的新内容。',
          transport_silent: '模型连接长时间没有新数据。',
          unobserved: '模型响应中断，底层连接状态暂无法确认。',
        };
        await input.onNative({
          type: 'native.event',
          presentation: 'lifecycle',
          status: 'failed',
          label: '模型响应诊断',
          summary:
            summaries[diagnostic.state] +
            (diagnostic.recoveryEligible
              ? '旧请求已停止，保留已完成工作，按重试限额继续。'
              : '已完成的内容和工具结果已保留。'),
          sourceEventType: 'allrice/model-stream',
          sourceEventId: `dsh:model-stream:${callId}`,
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: { callId, diagnostic },
        });
        return;
      }
      if (notification.method === 'session.context') {
        const view = nativeContextView(notification.params);
        if (view) await input.onNative(view);
        return;
      }
      if (notification.method === 'session.user-questions') {
        await input.onNative({
          type: 'native.event',
          presentation: 'context',
          status: 'completed',
          label: '问题状态已更新',
          sourceEventType: 'session/user-questions',
          sourceEventId: `dsh:questions:${notification.params.sessionId}:${notification.params.sequence}`,
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: notification.params,
        });
        return;
      }
      if (notification.method === 'session.user-question') {
        const questions = Array.isArray(notification.params.questions)
          ? notification.params.questions
          : [];
        const durable = notification.params.durable === true;
        const questionId =
          durable && typeof notification.params.questionId === 'string'
            ? notification.params.questionId
            : shortText(notification.params.questionId, 240);
        const normalized = UserQuestionRequestSchema.safeParse({
          questionId,
          ...(durable
            ? {
                durable: true,
                callId: notification.params.callId,
                nativeSessionId: notification.params.nativeSessionId,
              }
            : {}),
          questions: questions.map((value) => {
            const question = record(value);
            const intent = record(question?.intent);
            return {
              id: shortText(question?.id, 240),
              question: shortText(question?.question, 4_000),
              ...(shortText(question?.detail, 20_000)
                ? { detail: shortText(question?.detail, 20_000) }
                : {}),
              ...(shortText(question?.header, 160)
                ? { header: shortText(question?.header, 160) }
                : {}),
              options: Array.isArray(question?.options)
                ? question.options.map((optionValue) => {
                    const option = record(optionValue);
                    return {
                      label: shortText(option?.label, 240),
                      ...(shortText(option?.description, 1_000)
                        ? {
                            description: shortText(option?.description, 1_000),
                          }
                        : {}),
                    };
                  })
                : [],
              multiSelect: question?.multiSelect === true,
              ...(intent?.kind === 'plan-review' &&
              shortText(intent.approve, 240)
                ? {
                    intent: {
                      kind: 'plan-review' as const,
                      approve: shortText(intent.approve, 240),
                    },
                  }
                : {}),
            };
          }),
        });
        const summary = normalized.success
          ? shortText(normalized.data.questions[0]?.question, 1000)
          : shortText(record(questions[0])?.question, 500);
        progressQuestionPending = undefined;
        progressQuestionId =
          normalized.success &&
          normalized.data.questions.some(
            (question) => question.id === 'runtime-progress',
          )
            ? (questionId ?? undefined)
            : undefined;
        await input.onNative({
          type: 'native.event',
          presentation: 'context',
          status: 'started',
          label: 'Rice 需要你确认',
          ...(summary ? { summary } : {}),
          sourceEventId:
            durable && questionId
              ? `dsh:question:${createHash('sha256').update(questionId).digest('hex')}`
              : `dsh:${questionId ?? randomUUID()}`,
          sourceEventType: 'session/user-question',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: normalized.success
            ? normalized.data
            : { questionId, questionCount: questions.length },
        });
        if (input.questionWait && questionId && normalized.success) {
          clearTimeout(waitTimer);
          // Quick answers keep the live callback; after this bounded grace
          // period the queue owns the wait and this timer is discarded.
          waitTimer = setTimeout(() => {
            parking = input.runtime.client.parkQuestion(
              input.runtime.sessionId,
              questionId,
            );
            void parking.catch((error) => {
              processingError ??= error;
              settle();
            });
          }, 30_000);
        }
        return;
      }
      if (notification.method === 'session.user-question-pending') {
        const questionId = shortText(notification.params.questionId, 240);
        clearTimeout(waitTimer);
        if (questionId && questionId === progressQuestionId)
          progressQuestionPending = { questionId };
        return;
      }
      if (notification.method === 'session.user-question-answered') {
        progressQuestionPending = undefined;
        progressQuestionId = undefined;
        clearTimeout(waitTimer);
        await input.onNative({
          type: 'native.event',
          presentation: 'context',
          status: 'completed',
          label: '已收到你的回答',
          sourceEventId: `dsh:${shortText(notification.params.questionId, 180) ?? randomUUID()}:answered`,
          sourceEventType: 'session/user-question-answered',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: {
            questionId: shortText(notification.params.questionId, 240),
          },
        });
        return;
      }
      if (
        notification.method === 'session.status' &&
        notification.params.status === 'idle'
      ) {
        // Loading a persisted native session also announces idle. It is not
        // completion of the continuation we have yet to dispatch.
        if (!started) return;
        idle = true;
        settle();
        return;
      }
      const event =
        notification.method === 'session.assistant-stream'
          ? assistantStream.accept(notification.params.frame)
          : notification.method === 'session.event'
            ? record(notification.params.event)
            : null;
      const data = record(event?.data);
      if (!event || !data) return;
      // Native compaction replaces context history, not execution activity.
      if (
        event.surfaceOp === 'replace' ||
        record(event.surfaceOp)?.op === 'replace'
      )
        return;
      const source = sourceMetadata(event);
      if (event.type === 'allrice/wait/checkpoint' && parking) {
        parkingQuestion = true;
        return;
      }
      if (event.type === 'tool/call') {
        const callId = shortText(data.callId, 240);
        const rawName = shortText(data.name, 160);
        if (!callId || !rawName) return;
        const name = dshNativeWireNames[rawName] ?? rawName;
        let args: Record<string, unknown> | null = null;
        try {
          args =
            typeof data.arguments === 'string'
              ? record(JSON.parse(data.arguments))
              : record(data.arguments);
        } catch {
          args = null;
        }
        const queries = Array.isArray(args?.queries)
          ? args.queries.filter((query) => typeof query === 'string')
          : [];
        const query = queries.length
          ? queries.join(' · ').slice(0, 500)
          : shortText(args?.query, 500);
        const skillName =
          name === 'skill'
            ? shortText(args?.name ?? args?.skill ?? args?.skillName, 160)
            : undefined;
        activeNativeTools.set(callId, {
          name,
          sourceStartedAt: Date.parse(source.sourceOccurredAt),
          ...(query ? { query } : skillName ? { query: skillName } : {}),
        });
        await input.onNative({
          type: 'tool.started',
          toolCallId: callId,
          name,
          label: skillName ? `Skill · ${skillName}` : name,
          source: 'harness',
          ...source,
          sourcePayload: {
            ...source.sourcePayload,
            activityDetail: toolActivityDetail(name, args),
            presentation: isDshSearchTool(name) ? 'search' : 'tool',
            status: 'started',
            ...(query ? { query } : {}),
            ...(skillName ? { skillName, skillStatus: 'selected' } : {}),
          },
        });
        return;
      }
      if (event.type === 'tool/result') {
        const message = record(data.message);
        const firstBlock = readDshToolResult(message);
        const callId = shortText(
          firstBlock?.toolCallId ?? message?.toolCallId ?? message?.callId,
          240,
        );
        if (!callId) return;
        const active = activeNativeTools.get(callId);
        const name = active?.name ?? 'tool';
        const skillName = name === 'skill' ? active?.query : undefined;
        const skillLoadMs =
          active && skillName
            ? Date.parse(source.sourceOccurredAt) - active.sourceStartedAt
            : undefined;
        // Pinned DSH's ToolResultMessage carries the authoritative outcome on
        // its single tool-result block; event.error is optional diagnostics.
        // Keep legacy event errors, but never infer status from result text or
        // truthy strings and never copy raw arguments/results into the stream.
        const failed = Boolean(data.error) || firstBlock?.isError === true;
        const parkedQuestion =
          failed && parkingQuestion && name === 'ask_user_question';
        await input.onNative({
          type: failed ? 'tool.failed' : 'tool.completed',
          toolCallId: callId,
          name,
          label: skillName ? `Skill · ${skillName}` : name,
          source: 'harness',
          summary: parkedQuestion
            ? '提问已挂起，等待你的回答'
            : skillName
              ? failed
                ? 'Skill 加载失败'
                : 'Skill 已加载'
              : isDshSearchTool(name)
                ? failed
                  ? '搜索失败'
                  : '搜索完成'
                : failed
                  ? nativeToolFailureSummary(firstBlock?.content)
                  : '工具执行完成',
          ...source,
          sourcePayload: {
            ...source.sourcePayload,
            presentation: isDshSearchTool(name) ? 'search' : 'tool',
            status: failed ? 'failed' : 'completed',
            ...(parkedQuestion ? { questionWait: true } : {}),
            ...(active?.query ? { query: active.query } : {}),
            ...(skillName
              ? {
                  skillName,
                  skillStatus: failed ? 'failed' : 'loaded',
                  ...(skillLoadMs !== undefined &&
                  Number.isFinite(skillLoadMs) &&
                  skillLoadMs >= 0
                    ? { skillLoadMs }
                    : {}),
                  ...(failed ? { reason: 'dsh_skill_load_failed' } : {}),
                }
              : {}),
          },
        });
        activeNativeTools.delete(callId);
        return;
      }
      const nativeView = nativeEventView(event);
      if (nativeView) await input.onNative(nativeView);
      if (event.type === 'turn/start') {
        started = true;
        idle = false;
        usageSettled = false;
        turnOriginCommitted = false;
        const turn =
          typeof data.turn === 'number' || typeof data.turn === 'string'
            ? String(data.turn)
            : randomUUID();
        await input.onTurn(`${input.runtime.sessionId}:turn:${turn}`);
        turnOriginCommitted = true;
        return;
      }
      if (event.type === 'assistant/live-start') {
        const nextReplyId = `${input.runtime.sessionId}:${String(data.turn ?? '')}:${String(data.step ?? '')}`;
        if (replyId === nextReplyId && (rawAnswer || deltaBuffer))
          await input.onDelta('', source, replyId, 'replace');
        resetReply();
        replyId = nextReplyId;
        return;
      }
      if (event.type === 'assistant/live-end') {
        const outcome = record(data.outcome);
        // Failed attempts retire their transient text. A committed message has
        // already reconciled the final/retained partial reply via session.event.
        if (
          outcome?.kind === 'abandoned' ||
          outcome?.eventType === 'assistant/attempt'
        ) {
          await input.onDelta('', source, replyId, 'replace');
          resetReply();
        }
        activeReasoningBlocks.clear();
        return;
      }
      if (
        event.type === 'assistant/chunk' ||
        event.type === 'assistant/live-chunk'
      ) {
        const nextReplyId = `${input.runtime.sessionId}:${String(data.turn ?? '')}:${String(data.step ?? '')}`;
        if (replyId !== nextReplyId) {
          resetReply();
          replyId = nextReplyId;
        }
        const chunk = record(data.chunk);
        if (
          (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') &&
          typeof chunk.text === 'string' &&
          chunk.text.length > 0
        )
          observedModelOutput = true;
        const chunkIndex =
          typeof chunk?.index === 'number' ? chunk.index : undefined;
        const block = record(chunk?.block);
        const startsReasoning =
          chunk?.type === 'block-start' && chunk.blockType === 'reasoning';
        const streamsReasoning = chunk?.type === 'reasoning-delta';
        if (
          chunkIndex !== undefined &&
          (startsReasoning || streamsReasoning) &&
          !activeReasoningBlocks.has(chunkIndex)
        ) {
          activeReasoningBlocks.add(chunkIndex);
          await input.onNative({
            type: 'native.event',
            presentation: 'think',
            status: 'started',
            label: '正在思考',
            ...source,
          });
        }
        if (
          chunk?.type === 'block-end' &&
          chunkIndex !== undefined &&
          (activeReasoningBlocks.has(chunkIndex) || block?.kind === 'reasoning')
        ) {
          activeReasoningBlocks.delete(chunkIndex);
          await input.onNative({
            type: 'native.event',
            presentation: 'think',
            status: 'completed',
            label: '思考完成',
            ...source,
          });
        }
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') {
          return;
        }
        rawAnswer += chunk.text;
        const visible = visibleModelText(rawAnswer);
        if (!visible.ready) return;
        answer = visible.text;
        const delta = answer.slice(visibleLength);
        visibleLength = answer.length;
        if (!delta) return;
        if (deltaMode === 'tool') return;
        if (deltaMode === 'answer') {
          await input.onDelta(delta, source, replyId);
          return;
        }
        deltaBuffer += delta;
        const candidate = deltaBuffer.trimStart();
        if (!candidate || dshToolEnvelopePrefix.startsWith(candidate)) return;
        if (candidate.startsWith(dshToolEnvelopePrefix)) {
          deltaMode = 'tool';
          return;
        }
        deltaMode = 'answer';
        await input.onDelta(deltaBuffer, source, replyId);
        deltaBuffer = '';
        return;
      }
      if (event.type === 'assistant/message') {
        const nextReplyId = `${input.runtime.sessionId}:${String(data.turn ?? '')}:${String(data.step ?? '')}`;
        if (replyId !== nextReplyId) {
          resetReply();
          replyId = nextReplyId;
        }
        completionSource = source;
        const message = record(data.message);
        const final = textBlocks(message?.content);
        if (final) {
          rawAnswer = final;
          const visible = visibleModelText(final);
          if (visible.ready) answer = visible.text;
        }
        // Settle each native message, not the entire run. This also covers
        // providers that emit a durable message without streaming deltas.
        if (
          final &&
          !answer.includes(dshToolEnvelopePrefix) &&
          deltaMode !== 'tool'
        ) {
          await input.onDelta(
            normalizeAllRiceManagedFileLinks(answer),
            source,
            replyId,
            'replace',
          );
          deltaBuffer = '';
        }
        const receipt = projectNativeUsage(
          data.usage,
          observedModelOutput ||
            (Array.isArray(message?.content) && message.content.length > 0),
          input.subscription,
        );
        messageReceipts++;
        usage.inputTokens += receipt.inputTokens;
        usage.cachedInputTokens += receipt.cachedInputTokens;
        usage.outputTokens += receipt.outputTokens;
        usageComplete &&= receipt.usageComplete;
        cacheUsageKnown &&= receipt.cacheUsageKnown;
        usageSource = source;
      }
      if (event.type === 'llm/retry') {
        // DSH discards the partial reply of a failed model attempt in place.
        replyId = `${input.runtime.sessionId}:${String(data.turn ?? '')}:${String(data.step ?? '')}`;
        resetReply();
        await input.onDelta('', source, replyId, 'replace');
      }
      if (event.type === 'turn/end') {
        if (progressQuestionPending) {
          waitingForUser = progressQuestionPending;
          return;
        }
        const reason = record(data.reason);
        if (reason?.kind === 'error') {
          const failure = record(reason.error);
          throw new HandlerError(
            typeof failure?.code === 'string'
              ? `DSH_${failure.code}`
              : 'DSH_TURN_FAILED',
            typeof failure?.message === 'string'
              ? failure.message
              : 'DSH turn failed',
            // Native request recovery has already finished. A queue retry
            // would replay the entire prompt and its completed tool calls.
            false,
          );
        }
      }
    };
    const unsubscribe = input.runtime.client.subscribe((notification) => {
      if (notification.params.sessionId === input.runtime.sessionId) {
        // Observe arrival before the asynchronous persistence/projection
        // chain. This is native IPC intake, never Provider first-byte timing.
        const frame = record(notification.params.frame);
        const nativeEvent = record(notification.params.event);
        if (
          (notification.method === 'session.assistant-stream' &&
            frame?.type === 'chunk' &&
            record(frame.chunk)) ||
          (notification.method === 'session.event' &&
            nativeEvent?.type === 'assistant/chunk' &&
            !nativeEvent.surfaceOp)
        )
          input.onTimingPoint('firstNativeChunk');
        if (
          notification.method === 'session.event' &&
          nativeEvent?.type === 'turn/end' &&
          !nativeEvent.surfaceOp
        )
          input.onTimingPoint('nativeTurnEnded');
      }
      eventChain = eventChain
        .then(() => processNotification(notification))
        .catch((error: unknown) => {
          processingError ??= error;
          settle();
        });
    });
    const unsubscribeFailure = input.runtime.client.onFailure(() => {
      runtimeClosed = true;
      // The accepted prompt may have invoked tools before its host vanished.
      // A fresh prompt would replay the task, not recover its native callback.
      eventChain = eventChain.then(() => {
        if (idle) return;
        processingError ??= new HandlerError(
          'DSH_EXECUTION_OUTCOME_UNKNOWN',
          '执行进程已中断，未确认的操作不会自动重试；已产生的内容与执行记录保留。',
          false,
        );
        settle();
      });
    });
    const abort = () => {
      void input.runtime.client
        .interrupt(input.runtime.sessionId)
        .catch(() => {});
      settle();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      if (input.resume && input.questionWait) {
        const answer = await input.runtime.client.answerWait(input.resume);
        await input.questionWait.adopted(
          RuntimeNativeInputProofSchema.parse(answer.proof),
        );
      }
      await (
        input.start
          ? input.start()
          : input.resume
            ? input.runtime.client.continueWait(input.resume)
            : input.runtime.client.prompt(
                input.runtime.sessionId,
                input.prompt,
                input.images,
                input.sessionReferences,
                input.bootstrapReceipt,
              )
      ).catch(async (error: unknown) => {
        await eventChain;
        if (
          !processingError &&
          error instanceof HandlerError &&
          ['DSH_REQUEST_TIMEOUT', 'DSH_RUNTIME_CLOSED'].includes(error.code)
        )
          processingError = new HandlerError(
            'DSH_EXECUTION_OUTCOME_UNKNOWN',
            '执行请求未得到完成确认，未自动重试。',
            false,
          );
        throw processingError ?? error;
      });
      if (!idle) await idlePromise;
      const parked = parking ? record(await parking) : null;
      await eventChain;
      if (processingError) throw processingError;
      if (input.signal.aborted) {
        throw new HandlerError(
          'EXECUTION_ABORTED',
          'DSH execution was interrupted',
          false,
        );
      }
      if (parked?.checkpoint)
        throw new NativeQuestionParked(
          NativeQuestionCheckpointSchema.parse(parked.checkpoint),
          {
            usage,
            usageComplete: messageReceipts > 0 && usageComplete,
            cacheUsageKnown: messageReceipts > 0 && cacheUsageKnown,
          },
        );
      if (!waitingForUser && !parseDshToolCall(answer)) {
        await input.settleDelivery?.(confirmUsageSettled);
        await flushEvents();
        input.signal.throwIfAborted();
      }
      if (deltaMode === 'unknown' && deltaBuffer && !parseDshToolCall(answer)) {
        await input.onDelta(
          deltaBuffer,
          {
            sourceEventId: `dsh:buffer:${randomUUID()}`,
            sourceEventType: 'assistant/chunk',
            sourceOccurredAt: new Date().toISOString(),
            sourcePayload: { text: deltaBuffer },
          },
          replyId,
        );
      }
      return {
        answer,
        waitingForUser,
        replyId,
        usage,
        completionSource,
        usageSource,
        usageComplete:
          messageReceipts > 0 &&
          usageComplete &&
          Object.values(usage).every(Number.isSafeInteger),
        cacheUsageKnown: messageReceipts > 0 && cacheUsageKnown,
      };
    } catch (error) {
      // A failed wait/origin RPC may race the asynchronous event projection.
      // Preserve all already received usage before releasing the subscription.
      await flushEvents().catch(() => {});
      if (!(error instanceof NativeQuestionParked))
        input.onFailureUsage({
          usage,
          usageComplete:
            usageSettled &&
            !runtimeClosed &&
            !processingError &&
            messageReceipts > 0 &&
            usageComplete &&
            Object.values(usage).every(Number.isSafeInteger),
          cacheUsageKnown:
            usageSettled &&
            !runtimeClosed &&
            !processingError &&
            messageReceipts > 0 &&
            cacheUsageKnown,
        });
      throw error;
    } finally {
      clearTimeout(waitTimer);
      unsubscribe();
      unsubscribeFailure();
      input.signal.removeEventListener('abort', abort);
    }
  }
}

function nativeToolFailureSummary(content: unknown) {
  const value =
    typeof content === 'string'
      ? content.slice(0, 4000)
      : Array.isArray(content)
        ? content
            .slice(0, 4)
            .map((block) => {
              const item = record(block);
              return item?.type === 'text' && typeof item.text === 'string'
                ? item.text.slice(0, 1000)
                : '';
            })
            .join(' ')
        : '';
  if (/非公开网络地址|不允许.*内部网络地址/.test(value))
    return '网页地址解析异常，未能确认公开网络地址。';
  if (/无法独立确认域名/.test(value))
    return '网页域名解析暂时失败，请稍后重试。';
  if (/childRunId|当前任务没有这个子智能体/.test(value))
    return '没有可接收消息的子智能体，当前任务可直接继续。';
  if (/WEB_TIMEOUT|网页读取超时/.test(value))
    return '网页响应超时，请尝试其他来源。';
  return '工具执行失败';
}
