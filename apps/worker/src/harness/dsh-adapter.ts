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
import {
  AssistantRuntimeError,
  checkedFinalDeliveryArtifacts,
} from '@allrice/database';
import type { NativeSessionPin } from '@allrice/database';

import { AgentLoopGuard } from '../agent-loop-guard.js';
import { HandlerError } from '../errors.js';
import {
  assertFinalDelivery,
  type FinalDeliveryProof,
} from '../final-delivery/guard.js';
import { attachCheckedFinalDelivery } from '../final-delivery/checked-delivery.js';
import { NativeQuestionParked } from './dsh/native-question-wait.js';
import { ReceiptDrainWindow } from './dsh/receipt-drain.js';
import {
  AssistantExecutionUnresolvedError,
  attachAssistantFailureUsage,
  type AssistantFailureUsage,
} from './dsh/assistant-outcome.js';
import {
  attachAssistantFailureDiagnostics,
  parseAssistantFailureDiagnostics,
  type AssistantFailureDiagnostics,
} from './dsh/assistant-diagnostics.js';
import { assertAssistantProviderOutputBound } from './dsh/assistant-provider.js';
import { projectNativeUsage } from './dsh/native-usage.js';
import { DshAssistantStream } from './dsh/assistant-stream.js';
import { toolActivityDetail } from './dsh/tool-activity.js';
import { DshStartupRejection } from './dsh/startup-rejection.js';
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

/** Private inbound control seam; arguments are captured from execute(), not RPC grants. */
export function controlDshInputDelivery(input: {
  pool: DshRuntimePool;
  runtime: DshRuntime;
  operation: 'pause' | 'release';
  params: Record<string, unknown>;
  runId: string | undefined;
  delivery: HarnessExecutionInput['inputDelivery'];
  signal: AbortSignal;
  turnId(): string | null;
  checkContent(): Promise<void>;
  assistant:
    | {
        cancellation(): Promise<{
          stopReason?: unknown;
          instances: readonly unknown[];
        }>;
      }
    | undefined;
}) {
  if (!input.assistant || !input.delivery || !input.runId)
    throw new HandlerError('INPUT_GATE_UNBOUND', 'INPUT_GATE_UNBOUND', false);
  const assistant = input.assistant;
  return input.pool.inputDeliveryControl(
    input.runtime,
    input.operation,
    input.params,
    {
      runId: input.runId,
      turnId: input.turnId,
      signal: input.signal,
      delivery: input.delivery,
      assertAuthority: async () => {
        input.signal.throwIfAborted();
        await input.checkContent();
        const authority = await assistant.cancellation();
        if (authority.stopReason || authority.instances.length)
          throw new HandlerError(
            'INPUT_GATE_SCOPE_CHANGED',
            'INPUT_GATE_SCOPE_CHANGED',
            false,
          );
      },
    },
  );
}

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
    const preparationStarted = performance.now();
    assertAssistantProviderOutputBound(
      input.providerSnapshot,
      !!input.assistants,
      input.assistants?.subscriptionSnapshot,
    );
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
    );
    // The existing pool selected an independently measured/approved artifact.
    // A newly frozen checked Run must use that exact protocol-tested identity;
    // an older pin is never promoted by a current same-version primary.
    if (
      input.assistants?.deliveryMode === 'checked_native_v1' &&
      (!nativeDescriptor ||
        nativeDescriptor.profileId !== 'restricted' ||
        nativeDescriptor.artifactId !== input.assistants.deliveryArtifactId ||
        nativeDescriptor.artifactManifestDigest !==
          nativeDescriptor.artifactId ||
        !checkedFinalDeliveryArtifacts().includes(nativeDescriptor.artifactId))
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
      // A missing pin is not proof that a known history may be recreated.
      // Read through the selected artifact's public backend before any new pin.
      if (prepared?.requiresRecovery)
        await this.runtimePool.assertStoredSession(
          input,
          threadId,
          prepared.binding ?? undefined,
          prepared.origin,
        );
      const bound = prepared?.binding
        ? { binding: prepared.binding, generation: prepared.generation }
        : await input.nativeBinding.bind(nativeDescriptor);
      if (
        Object.entries(nativeDescriptor).some(
          ([key, value]) =>
            bound.binding[key as keyof NativeSessionPin] !== value,
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
      requireRecovery: prepared?.requiresRecovery,
    });
    const runtimeBindingStarted = performance.now();
    this.runtimePool.touch(runtime);
    const assistant = await input.assistants
      ?.bind(threadId, generation, input.onToolCall, (nativeSessionId) =>
        runtime.client.assistant('inspect', { nativeSessionId }),
      )
      .catch(async (error) => {
        await this.runtimePool.drop(threadId);
        // This local controller bind only configures/validates the root. The
        // fresh host has not received assistant/bind or session/prompt yet.
        // Reused hosts and failures after this boundary remain uncertain.
        const runId = input.executionEnvironment.ALLRICE_RUN_ID;
        if (fresh && runId && input.assistants?.rootRunId === runId)
          throw new DshStartupRejection(error, runId, input.attempt);
        throw error;
      });
    const checkedAssistant =
      input.assistants?.deliveryMode === 'checked_native_v1';
    const finalDeliveryUnavailable = (): never => {
      input.signal.throwIfAborted();
      throw new HandlerError(
        'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
        '本轮公开回复尚不能按原生记录与交付事实确认；已有内容已保留，未自动重跑任务。',
        false,
      );
    };
    if (
      assistant &&
      !['checked_native_v1', 'legacy'].includes(input.assistants!.deliveryMode)
    )
      finalDeliveryUnavailable();
    // Installed synchronously by runOnce before prompting. Keep it through
    // child join/retry; a later runOnce replaces it with its own turn barrier.
    let awaitTurnOrigin: (() => Promise<void>) | undefined;
    let restoredOriginTurnId: string | undefined;
    const ordinaryHandler = dshInboundToolHandler(input);
    let turnId: string | null = null;
    let assistantAdmissionFailure: HandlerError | undefined;
    let contentAuthorizationFailure: HandlerError | undefined;
    const checkContent = async () => {
      if (!input.contentGuard) return;
      try {
        await input.contentGuard.check();
      } catch (error) {
        contentAuthorizationFailure ??=
          error instanceof HandlerError
            ? error
            : new HandlerError(
                'EMPLOYEE_CONTENT_UNAVAILABLE',
                '当前工作要求或历史资料无法继续使用，请确认后重新发起任务。',
                false,
              );
        throw contentAuthorizationFailure;
      }
    };
    runtime.client.setRequestHandler(async (method, params) => {
      if (
        method === 'allrice/assistant/input-gate-pause' ||
        method === 'allrice/assistant/input-gate-release'
      ) {
        return controlDshInputDelivery({
          pool: this.runtimePool,
          runtime,
          operation:
            method === 'allrice/assistant/input-gate-pause'
              ? 'pause'
              : 'release',
          params,
          runId: input.assistants?.rootRunId,
          delivery: input.inputDelivery,
          signal: input.signal,
          turnId: () => turnId,
          checkContent,
          assistant,
        });
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
        await checkContent();
        return { allowed: true };
      }
      if (
        method === 'allrice/content-scene-load' ||
        method === 'allrice/content-scene-adopt'
      ) {
        try {
          await checkContent();
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
          if (evidence.nativeSessionId !== threadId) {
            if (!assistant) throw Error('employee_scene_native_scope');
            await assistant.handle('progress-identity', {
              nativeSessionId: evidence.nativeSessionId,
            });
          }
          if (!input.contentGuard?.adoptScene)
            throw Error('employee_scene_unbound');
          return await input.contentGuard.adoptScene(evidence);
        } catch (error) {
          contentAuthorizationFailure ??=
            error instanceof HandlerError
              ? error
              : new HandlerError(
                  'EMPLOYEE_CONTENT_UNAVAILABLE',
                  '当前工作场景无法继续使用，请确认场景和资料后重新发起任务。',
                  false,
                );
          throw contentAuthorizationFailure;
        }
      }
      if (method === 'allrice/content-check') {
        if (!input.contentGuard) throw Error('employee_content_guard_unbound');
        if (params.nativeSessionId !== threadId) {
          if (!assistant) throw Error('employee_content_native_scope');
          await assistant.handle('progress-identity', {
            nativeSessionId: params.nativeSessionId,
          });
        }
        await checkContent();
        return { allowed: true };
      }
      if (
        method === 'allrice/tool-call' ||
        method === 'allrice/assistant/model-prepare' ||
        method === 'allrice/assistant/model-dispatch' ||
        method === 'allrice/assistant/tool' ||
        method === 'allrice/assistant/proposal'
      )
        await checkContent();
      if (method === 'allrice/progress') {
        if (
          params.action === 'model_prepare' ||
          (params.action === 'start' && params.kind === 'model')
        )
          await checkContent();
        if (!input.progress) throw Error('task_progress_disabled');
        if (params.nativeSessionId !== threadId) {
          if (!assistant) throw Error('task_progress_native_scope');
          // Existing owned-tree lookup, with lease and tenant checks, runs
          // before accepting a child's progress report.
          await assistant.handle('progress-identity', {
            nativeSessionId: params.nativeSessionId,
          });
        }
        return input.progress(params);
      }
      if (method === 'allrice/assistant/final-delivery-origin') {
        if (
          !checkedAssistant ||
          !assistant?.readFinalDeliveryReplyOrigin ||
          params.nativeSessionId !== threadId ||
          params.rootRunId !== input.assistants!.rootRunId
        )
          finalDeliveryUnavailable();
        const origin = await assistant!.readFinalDeliveryReplyOrigin!();
        restoredOriginTurnId = origin?.starts.at(-1)?.turnId;
        return { origin };
      }
      if (
        method === 'allrice/assistant/delivery-repair-inspect' ||
        method === 'allrice/assistant/delivery-repair-authorize' ||
        method === 'allrice/assistant/delivery-repair-close-preparation'
      ) {
        if (
          !checkedAssistant ||
          !assistant?.deliveryRepair ||
          params.nativeSessionId !== threadId
        )
          finalDeliveryUnavailable();
        const repair = assistant!.deliveryRepair!;
        if (method === 'allrice/assistant/delivery-repair-close-preparation')
          return repair.closePreparation({
            nativeSessionId: threadId,
            callId: params.callId,
          });
        await checkContent();
        if (method === 'allrice/assistant/delivery-repair-inspect')
          return { ...(await repair.inspect(params.candidate)) };
        return repair.authorize({
          phase: params.phase,
          candidate: params.candidate,
        });
      }
      if (
        checkedAssistant &&
        (method === 'allrice/assistant/model-prepare' ||
          method === 'allrice/assistant/model-dispatch')
      ) {
        if (!awaitTurnOrigin) finalDeliveryUnavailable();
        await awaitTurnOrigin!();
      }
      if (method.startsWith('allrice/assistant/')) {
        if (!assistant) throw Error('assistant_runtime_disabled');
        try {
          return await assistant.handle(
            method.slice('allrice/assistant/'.length),
            params,
          );
        } catch (error) {
          if (
            error instanceof AssistantRuntimeError &&
            error.code === 'budget_exhausted'
          ) {
            assistantAdmissionFailure = new HandlerError(
              'ASSISTANT_BUDGET_EXHAUSTED',
              '本次任务达到平台内部执行预算，已停止继续调用；这不代表 Codex 订阅额度耗尽。',
              false,
            );
            throw assistantAdmissionFailure;
          }
          throw error;
        }
      }
      return ordinaryHandler(method, params);
    });
    if (assistant)
      await runtime.client.assistant('bind', {
        nativeSessionId: threadId,
        runId: input.assistants!.rootRunId,
        ...(checkedAssistant ? { deliveryMode: 'checked_native_v1' } : {}),
        wireTools: Object.entries(dshNativeWireNames)
          .filter(([, canonical]) =>
            input.tools.some((tool) => tool.name === canonical),
          )
          .map(([wire]) => wire),
      });
    let cancellationTask: Promise<unknown> | undefined;
    let rootDrainTask: Promise<unknown> | undefined;
    let rootStopTask: Promise<unknown> | undefined;
    let ownedDrop: Promise<void> | undefined;
    const dropOwnedHost = () => (ownedDrop ??= this.runtimePool.drop(threadId));
    const stopWindow = new ReceiptDrainWindow(dropOwnedHost);
    const assistantFailureSignal = new AbortController();
    const executionSignal = assistant
      ? AbortSignal.any([input.signal, assistantFailureSignal.signal])
      : input.signal;
    const drainRequest = (request: {
      nativeSessionId?: string;
      drainDeadlineAt?: string;
      instances: readonly { nativeSessionId: string }[];
    }) => {
      const root = request.instances.some(
        (i) => i.nativeSessionId === threadId,
      );
      if (root || stopWindow.started) {
        stopWindow.begin(request.drainDeadlineAt);
        return (rootDrainTask ??= stopWindow.within(() =>
          runtime.client.assistant('drain', request),
        ));
      }
      // A canceled child must not consume a later root stop's budget or close a
      // healthy parent after its own successful drain.
      const childWindow = new ReceiptDrainWindow(dropOwnedHost);
      return childWindow
        .within(() => runtime.client.assistant('drain', request))
        .finally(() => childWindow.dispose());
    };
    const pollCancellation = () => {
      if (!assistant || cancellationTask || rootStopTask || rootDrainTask)
        return;
      cancellationTask = assistant
        .cancellation()
        .then((request) => {
          if (request.stopReason === 'timeout')
            assistantAdmissionFailure ??= new HandlerError(
              'ASSISTANT_BUDGET_EXHAUSTED',
              '本次任务已达到配置的执行时限，已停止继续运行；这不是 Token 配额限制。',
              false,
            );
          return request.instances.length ? drainRequest(request) : undefined;
        })
        .catch(async (error) => {
          if (
            error instanceof AssistantRuntimeError &&
            error.code === 'budget_exhausted'
          ) {
            assistantAdmissionFailure ??= new HandlerError(
              'ASSISTANT_BUDGET_EXHAUSTED',
              '本次任务已达到配置的执行时限，已停止继续运行；这不是 Token 配额限制。',
              false,
            );
          }
          assistantFailureSignal.abort();
          await dropOwnedHost();
        })
        .finally(() => {
          cancellationTask = undefined;
        });
    };
    const cancellationTimer = assistant
      ? setInterval(pollCancellation, 250)
      : undefined;
    const stopAssistants = () => {
      stopWindow.begin();
      if (assistant) {
        rootStopTask ??= stopWindow
          .within(() => assistant.cancel())
          .then(() => stopWindow.within(() => assistant.cancellation()))
          .then(drainRequest);
        // Abort listeners cannot surface an unhandled rejection. The failure
        // path still observes this same promise before reading durable usage.
        void rootStopTask.catch(() => {});
      }
      return rootStopTask ?? Promise.resolve();
    };
    input.signal.addEventListener('abort', stopAssistants, { once: true });
    if (input.signal.aborted) void stopAssistants();
    let order = 0;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let usageComplete = true;
    let cacheUsageKnown = true;
    const fallbackGuard = input.progress ? undefined : new AgentLoopGuard();
    const emit = async (event: HarnessEventPayload) => {
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
    const initialPrompt = [
      dshToolBridgeInstructions(input),
      fresh && input.kernel.bootstrapConversation
        ? `Conversation context:\n${input.kernel.bootstrapConversation}`
        : '',
      input.kernel.authorizedMemoryContext,
      input.kernel.userRequest,
    ]
      .filter(Boolean)
      .join('\n\n');
    let prompt = initialPrompt;
    let answer = '';
    let assistantFinished = false;
    let interruptedUsage: AssistantFailureUsage | undefined;
    let assistantDiagnostics: AssistantFailureDiagnostics | undefined;
    const captureAssistantDiagnostics = async () => {
      if (!assistant || assistantFinished || assistantDiagnostics) return;
      try {
        // The protocol request has its own 2s timeout and removes its pending
        // entry. A missing/old/broken diagnostic endpoint never changes outcome.
        assistantDiagnostics = parseAssistantFailureDiagnostics(
          await runtime.client.assistant('diagnostics', {
            nativeSessionId: threadId,
          }),
        );
      } catch {
        // Keep the original execution error and fail-closed accounting.
      }
    };
    let assistantOutcome:
      | Awaited<
          ReturnType<NonNullable<NonNullable<typeof assistant>['finish']>>
        >
      | undefined;
    let checkedDeliveryProof: FinalDeliveryProof | undefined;
    let restoredFinal: Record<string, unknown> | null = null;
    let restoredUsage: AssistantFailureUsage | undefined;
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
            runId:
              input.executionEnvironment.ALLRICE_RUN_ID ??
              input.assistants?.rootRunId ??
              null,
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
        } catch {
          throw new HandlerError(
            'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE',
            '原会话资料暂不可用，已保留绑定与执行记录。',
            false,
          );
        }
      }
      // Same-authority cold final reconciliation is a read, never a new
      // prompt. The reader/journal must prove the completed current-Run turn.
      // Ordinary question waits and explicit legacy paths keep their lifecycle.
      if (
        checkedAssistant &&
        fresh &&
        prepared?.requiresRecovery &&
        assistant?.hasPriorRoot
      ) {
        try {
          restoredFinal = await runtime.client.assistant(
            'joinForFinalDelivery',
            {
              nativeSessionId: threadId,
            },
          );
          if (!assistant.failureUsage) finalDeliveryUnavailable();
          restoredUsage = await assistant.failureUsage!();
          turnId = restoredOriginTurnId ?? turnId;
        } catch {
          finalDeliveryUnavailable();
        }
      }
      const preparationMs = performance.now() - preparationStarted;
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
        const result = restoredFinal
          ? {
              answer: String(restoredFinal.answer ?? ''),
              replyId:
                typeof restoredFinal.publicMessageId === 'string'
                  ? restoredFinal.publicMessageId
                  : undefined,
              usage: restoredUsage!.usage,
              usageComplete: restoredUsage!.usageComplete,
              cacheUsageKnown: restoredUsage!.cacheUsageKnown,
              completionSource: undefined,
              usageSource: undefined,
            }
          : await this.runOnce({
              runtime,
              prompt,
              images: callIndex === 0 ? (input.images ?? []) : [],
              sessionReferences:
                callIndex === 0 ? input.kernel.sessionReferences : undefined,
              signal: executionSignal,
              subscription: snapshot.route === 'openai-codex',
              questionWait: !assistant ? input.questionWait : undefined,
              resume: callIndex === 0 ? input.questionWait?.resume : undefined,
              onFailureUsage: (receipt) => {
                interruptedUsage = {
                  ...receipt,
                  usage: {
                    inputTokens: usage.inputTokens + receipt.usage.inputTokens,
                    cachedInputTokens:
                      usage.cachedInputTokens + receipt.usage.cachedInputTokens,
                    outputTokens:
                      usage.outputTokens + receipt.usage.outputTokens,
                  },
                };
              },
              ...(checkedAssistant
                ? {
                    installTurnOriginBarrier: (
                      barrier: () => Promise<void>,
                    ) => {
                      awaitTurnOrigin = barrier;
                    },
                  }
                : {}),
              onTurn: async (nextTurnId) => {
                turnId = nextTurnId;
                if (checkedAssistant && !input.onTurnStarted)
                  finalDeliveryUnavailable();
                await input.onTurnStarted?.({ threadId, turnId: nextTurnId });
              },
              onDelta: async (text, source, replyId, textMode) =>
                emit({
                  type: 'assistant.delta',
                  text,
                  ...source,
                  replyId,
                  textMode,
                }),
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
        usage.inputTokens += result.usage.inputTokens;
        usage.cachedInputTokens += result.usage.cachedInputTokens;
        usage.outputTokens += result.usage.outputTokens;
        usageComplete &&= result.usageComplete;
        cacheUsageKnown &&= result.cacheUsageKnown;
        const toolCall = parseDshToolCall(result.answer);
        await checkContent();
        if (!toolCall) {
          if (assistantAdmissionFailure) throw assistantAdmissionFailure;
          // These capabilities remain in this call frame. Never attach them to
          // Harness events, model prompts, execution results or failure diagnostics.
          const finalDelivery = assistant
            ? checkedAssistant
              ? assistant.finalDelivery
              : undefined
            : input.finalDelivery;
          if (checkedAssistant && (!finalDelivery || !assistant?.finish))
            finalDeliveryUnavailable();
          let joined: Record<string, unknown> | null = restoredFinal;
          if (assistant && !joined) {
            try {
              joined = await runtime.client.assistant(
                checkedAssistant ? 'joinForFinalDelivery' : 'join',
                {
                  nativeSessionId: threadId,
                },
              );
            } catch {
              // A missing same-Run durable boundary cannot authorize a replay
              // or a fallback to runOnce's observed/last assistant message.
              finalDeliveryUnavailable();
            }
          }
          const rootBinding = record(joined?.rootBinding);
          const privateId =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (
            checkedAssistant &&
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
              rootBinding?.runId !== input.assistants!.rootRunId ||
              typeof rootBinding?.bindingId !== 'string' ||
              !privateId.test(rootBinding.bindingId))
          )
            finalDeliveryUnavailable();
          if (assistantAdmissionFailure) throw assistantAdmissionFailure;
          const nativeCandidate =
            typeof joined?.answer === 'string' ? joined.answer : result.answer;
          const projectedCandidate =
            normalizeAllRiceManagedFileLinks(nativeCandidate);
          executionSignal.throwIfAborted();
          await checkContent();
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
                        rootRunId: input.assistants!.rootRunId,
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
          await checkContent();
          if (assistant) {
            // The owned native tree stays held through facts/policy and finish.
            // Stop and await the active-run
            // poll before persisting a terminal root, whose authority is no
            // longer admissible. Finalization performs its own current check.
            if (cancellationTimer) clearInterval(cancellationTimer);
            await cancellationTask;
            executionSignal.throwIfAborted();
            // finish deliberately clears the native Run-bound maps.
            await captureAssistantDiagnostics();
            let proof: FinalDeliveryProof | undefined;
            if (checkedAssistant) {
              if (!joined || !deliveryReceipt) finalDeliveryUnavailable();
              proof = Object.freeze({
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
              try {
                const released = await runtime.client.assistant('finish', {
                  nativeSessionId: threadId,
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
              } catch {
                finalDeliveryUnavailable();
              }
            } else {
              // Explicit frozen legacy mode preserves the original native and
              // runtime finalization. Missing checked evidence never selects it.
              await runtime.client.assistant('finish', {
                nativeSessionId: threadId,
              });
            }
            try {
              assistantOutcome = checkedAssistant
                ? await assistant.finish?.(proof!)
                : await assistant.finish?.();
            } catch (error) {
              executionSignal.throwIfAborted();
              if (error instanceof HandlerError && !error.retryable)
                throw error;
              finalDeliveryUnavailable();
            }
            const outcome = assistantOutcome ?? finalDeliveryUnavailable();
            assistantFinished = true;
            Object.assign(usage, outcome.usage);
            if (!['completed', 'partial'].includes(outcome.status))
              throw new AssistantExecutionUnresolvedError(
                usage,
                outcome.usageComplete,
                assistantDiagnostics,
              );
            if (outcome.status === 'completed') checkedDeliveryProof = proof;
          }
          answer = projectedCandidate;
          if (assistantOutcome?.status === 'partial')
            await emit({
              type: 'native.event',
              presentation: 'lifecycle',
              status: 'failed',
              label: '任务尚未完成',
              summary: '助手已返回可用内容，但仍有未完成事项；已有结果已保留。',
              sourceEventType: 'allrice/assistant-partial',
              sourcePayload: { status: 'partial' },
            });
          await emit({
            type: 'assistant.completed',
            text: answer,
            replyId:
              (joined?.publicMessageId as string | undefined) ?? result.replyId,
            ...(result.completionSource ?? {}),
          });
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
          const assistantResult = assistant
            ? await assistant.handle('tool', {
                nativeSessionId: threadId,
                callId: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              })
            : null;
          const toolResult = assistantResult
            ? {
                modelContent: String(assistantResult.modelContent),
                summary: String(assistantResult.summary),
                ...(typeof assistantResult.itemCount === 'number'
                  ? { itemCount: assistantResult.itemCount }
                  : {}),
              }
            : await input.onToolCall(toolCall);
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
          // These bounded, read-only input failures are tool outcomes. Let DSH
          // correct the selection without discarding already delivered files.
          // Admission, cancellation and unknown execution failures remain fatal.
          if (
            toolCall.name === 'workspace.file.read' &&
            error instanceof HandlerError &&
            ['TOOL_FILE_TYPE_UNSUPPORTED', 'TOOL_FILE_TOO_LARGE'].includes(
              error.code,
            )
          ) {
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
            prompt = `<allrice_tool_result>${JSON.stringify({
              id: toolCall.id,
              ok: false,
              error: { code: error.code, message: error.message },
            })}</allrice_tool_result>\n\nContinue the original user request. Correct this read-only file selection or explain the limitation; preserve completed work and do not repeat writes. Any text emitted alongside the preceding tool envelope was not delivered to the user. Return a complete, self-contained answer.`;
            continue;
          }
          throw error;
        }
      }
    } catch (caught) {
      if (
        caught instanceof NativeQuestionParked &&
        input.questionWait &&
        !assistant
      ) {
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
        assistantAdmissionFailure ??
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
      // Capture before cancel/drop destroys the host, without widening root
      // authority or reading another native session's transcript.
      await captureAssistantDiagnostics();
      attachAssistantFailureDiagnostics(error, assistantDiagnostics);
      let failedUsage: AssistantFailureUsage | undefined = assistant
        ? undefined
        : interruptedUsage;
      if (cancellationTimer) clearInterval(cancellationTimer);
      await stopWindow
        .within(() => cancellationTask ?? Promise.resolve())
        .catch(() => {});
      try {
        if (
          assistant &&
          !assistantFinished &&
          !assistantFailureSignal.signal.aborted
        )
          await stopAssistants();
      } catch {
        // Revoked membership/lease may forbid tree reads; still close our host.
      } finally {
        // Read only genuine durable usage while the original receipt window is
        // open; a failed/late read never replaces known earlier evidence.
        if (assistant?.failureUsage)
          failedUsage =
            (await stopWindow
              .within(() => assistant.failureUsage!())
              .catch(() => undefined)) ?? failedUsage;
        await dropOwnedHost();
      }
      const attachUsage = (failure: unknown) => {
        const runId =
          input.assistants?.rootRunId ??
          input.executionEnvironment.ALLRICE_RUN_ID;
        if (failedUsage && runId)
          attachAssistantFailureUsage(
            failure,
            runId,
            input.attempt,
            failedUsage,
          );
      };
      if (input.signal.aborted) {
        const aborted = new HandlerError(
          'EXECUTION_ABORTED',
          'DSH execution was interrupted',
          false,
        );
        attachAssistantFailureDiagnostics(aborted, assistantDiagnostics);
        attachUsage(aborted);
        throw aborted;
      }
      attachUsage(error);
      throw error;
    } finally {
      try {
        if (cancellationTimer) clearInterval(cancellationTimer);
        input.signal.removeEventListener('abort', stopAssistants);
        if (stopWindow.started) {
          await stopWindow
            .within(() => rootStopTask ?? cancellationTask ?? Promise.resolve())
            .catch(() => {});
          if (assistant)
            await stopWindow
              .within(() => runtime.client.assistant('flush', {}))
              .catch(() => {});
        } else {
          await cancellationTask?.catch(() => {});
          if (assistant)
            await runtime.client.assistant('flush', {}).catch(() => {});
        }
        this.runtimePool.touch(runtime);
        runtime.client.setRequestHandler(null);
      } finally {
        this.runtimePool.clearInputDelivery(runtime);
        stopWindow.dispose();
        unsubscribeModelTiming();
      }
    }
    const result: HarnessExecutionResult = {
      answer,
      usage,
      usageComplete,
      cacheUsageKnown,
      ...(assistantOutcome
        ? {
            assistantStatus: assistantOutcome.status as 'completed' | 'partial',
            usageComplete: assistantOutcome.usageComplete,
            cacheUsageKnown: assistantOutcome.cacheUsageKnown,
            costEstimateAvailable: assistantOutcome.costEstimateAvailable,
            ...(assistantOutcome.billingMode === 'subscription'
              ? {
                  billingMode: assistantOutcome.billingMode,
                  costBasis: assistantOutcome.costBasis,
                  estimatedCostCents: assistantOutcome.estimatedCostCents,
                  subscriptionSnapshotDigest:
                    assistantOutcome.subscriptionSnapshotDigest,
                  actualCostKnown: assistantOutcome.actualCostKnown,
                }
              : {}),
            ...(assistantOutcome.priceSnapshotDigest
              ? {
                  estimatedCostCents: assistantOutcome.estimatedCostCents,
                  costBasis: assistantOutcome.costBasis,
                  priceSnapshotDigest: assistantOutcome.priceSnapshotDigest,
                  costCurrency: assistantOutcome.costCurrency,
                  actualCostKnown: assistantOutcome.actualCostKnown,
                }
              : {}),
          }
        : {}),
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
    // Partial outcomes return to the Worker before its completion gate throws.
    // Preserve the same closed sidecar without adding a serializable result field.
    attachAssistantFailureDiagnostics(result, assistantDiagnostics);
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
      input.turnId,
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

  runtimeInventory() {
    return this.runtimePool.inventory();
  }

  private async runOnce(input: {
    sessionReferences?: SessionReferenceSnapshot[];
    runtime: DshRuntime;
    prompt: string;
    images: HarnessExecutionInput['images'];
    signal: AbortSignal;
    subscription: boolean;
    questionWait?: HarnessExecutionInput['questionWait'];
    resume?: NonNullable<HarnessExecutionInput['questionWait']>['resume'];
    onFailureUsage(receipt: AssistantFailureUsage): void;
    onTurn(turnId: string): Promise<void>;
    /** Private persistence ACK, never a model-supplied barrier. */
    installTurnOriginBarrier?(barrier: () => Promise<void>): void;
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
    input.installTurnOriginBarrier?.(async () => {
      await eventChain;
      if (processingError) throw processingError;
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
      if (notification.method === 'session.user-question') {
        const questions = Array.isArray(notification.params.questions)
          ? notification.params.questions
          : [];
        const questionId = shortText(notification.params.questionId, 240);
        const normalized = UserQuestionRequestSchema.safeParse({
          questionId,
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
        await input.onNative({
          type: 'native.event',
          presentation: 'context',
          status: 'started',
          label: 'Rice 需要你确认',
          ...(summary ? { summary } : {}),
          sourceEventId: `dsh:${questionId ?? randomUUID()}`,
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
      if (notification.method === 'session.user-question-answered') {
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
      eventChain = eventChain
        .then(() => processNotification(notification))
        .catch((error: unknown) => {
          processingError ??= error;
          settle();
        });
    });
    const unsubscribeFailure = input.runtime.client.onFailure(() => {
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
        input.resume
          ? input.runtime.client.continueWait(input.resume)
          : input.runtime.client.prompt(
              input.runtime.sessionId,
              input.prompt,
              input.images,
              input.sessionReferences,
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
      if (!(error instanceof NativeQuestionParked))
        input.onFailureUsage({
          usage,
          usageComplete: false,
          cacheUsageKnown: false,
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
  if (/childRunId|当前任务没有这个助手/.test(value))
    return '没有可接收消息的助手，当前任务可直接继续。';
  if (/WEB_TIMEOUT|网页读取超时/.test(value))
    return '网页响应超时，请尝试其他来源。';
  return '工具执行失败';
}
