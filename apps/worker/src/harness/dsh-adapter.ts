import { randomUUID, createHash } from 'node:crypto';

import {
  HarnessEventSchema,
  UserQuestionRequestSchema,
  NativeQuestionCheckpointSchema,
  RuntimeNativeInputProofSchema,
  type HarnessEvent,
} from '@allrice/contracts';
import { AssistantRuntimeError, observeCodexTokens } from '@allrice/database';

import { HandlerError } from '../errors.js';
import { NativeQuestionParked } from './dsh/native-question-wait.js';
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
import { DshStartupRejection } from './dsh/startup-rejection.js';
import type {
  HarnessAdapter,
  HarnessExecutionInput,
  HarnessExecutionResult,
} from './adapter.js';
import type { DshNotification } from './dsh-protocol-client.js';
import {
  nativeEventView,
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
  maximumDshToolCallsPerTurn,
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
    assertAssistantProviderOutputBound(
      input.providerSnapshot,
      !!input.assistants,
      input.assistants?.subscriptionSnapshot,
    );
    if (input.providerSnapshot.provider !== 'dsh') {
      throw new TypeError('DSH harness requires a DSH provider snapshot');
    }
    const snapshot = input.providerSnapshot;
    const expectedThreadId = `dsh-${input.kernel.sessionId}`;
    const threadId = input.threadId?.startsWith('dsh-')
      ? input.threadId
      : expectedThreadId;
    const existing = this.runtimePool.get(threadId);
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
    const systemInstructions = input.kernel.systemInstructions;
    let generation = input.generation;
    if (!input.threadId || input.threadId !== threadId) {
      const bound = await input.onThreadBound?.({
        threadId,
        resumed: Boolean(existing),
        replacedThreadId: input.threadId ?? null,
      });
      generation = bound?.generation ?? generation;
    }
    const { runtime, fresh } = await this.runtimePool.acquire({
      input,
      snapshot,
      threadId,
      systemInstructions,
      nativeSkills,
    });
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
    const ordinaryHandler = dshInboundToolHandler(input);
    let assistantAdmissionFailure: HandlerError | undefined;
    runtime.client.setRequestHandler(async (method, params) => {
      if (method === 'allrice/progress') {
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
        wireTools: Object.entries(dshNativeWireNames)
          .filter(([, canonical]) =>
            input.tools.some((tool) => tool.name === canonical),
          )
          .map(([wire]) => wire),
      });
    let cancellationTask: Promise<unknown> | undefined;
    const assistantFailureSignal = new AbortController();
    const executionSignal = assistant
      ? AbortSignal.any([input.signal, assistantFailureSignal.signal])
      : input.signal;
    const pollCancellation = () => {
      if (!assistant || cancellationTask) return;
      cancellationTask = assistant
        .cancellation()
        .then((request) =>
          request.instances.length
            ? runtime.client.assistant('drain', request)
            : undefined,
        )
        .catch(async (error) => {
          if (
            error instanceof AssistantRuntimeError &&
            error.code === 'budget_exhausted'
          ) {
            // The liveness check enforces the root's durable deadline even
            // while a model stream is active. Preserve that cause before
            // closing the owned host produces a generic runtime-closed error.
            assistantAdmissionFailure ??= new HandlerError(
              'ASSISTANT_BUDGET_EXHAUSTED',
              '本次任务已达到配置的执行时限，已停止继续运行；这不是 Token 配额限制。',
              false,
            );
          }
          // Loss of read authority cannot keep an owned model stream alive.
          // Process termination needs no new user grant; do not invent stopped receipts.
          assistantFailureSignal.abort();
          await this.runtimePool.drop(threadId);
        })
        .finally(() => {
          cancellationTask = undefined;
        });
    };
    const cancellationTimer = assistant
      ? setInterval(pollCancellation, 250)
      : undefined;
    const stopAssistants = () => {
      if (assistant)
        cancellationTask = assistant
          .cancel()
          .then(() => assistant.cancellation())
          .then((request) => runtime.client.assistant('drain', request))
          .catch(() => this.runtimePool.drop(threadId));
    };
    input.signal.addEventListener('abort', stopAssistants, { once: true });
    let order = 0;
    let turnId: string | null = null;
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let usageComplete = true;
    let cacheUsageKnown = true;
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
      await input.onEvent(
        HarnessEventSchema.parse({
          schemaVersion: 1,
          harness: this.kind,
          generation,
          attempt: input.attempt,
          order: ++order,
          threadId,
          turnId,
          sessionId: input.kernel.sessionId,
          messageId: input.kernel.assistantMessageId,
          sourceEventId: `dsh:${input.attempt}:${order}`,
          sourceEventType,
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: {},
          ...event,
        }),
      );
    };
    for (const entry of skillEligibility) {
      if (entry.missingTools.length === 0 && entry.inactiveTools.length === 0) {
        await emit({
          type: 'native.event',
          presentation: 'context',
          status: 'completed',
          label: 'Skill 已加载',
          summary: entry.skill.name,
          sourcePayload: {
            skillId: entry.skill.id,
            skillName: entry.skill.name,
            skillChecksum: entry.skill.checksum,
            status: 'loaded',
          },
        });
      } else if (entry.missingTools.length > 0) {
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
      }
      // An authorized side-effect tool may intentionally be absent from the
      // callable set until the capability router selects it for this turn.
      // That makes the Skill inactive, not broken, so it must not surface as
      // a red tenant-facing failure.
    }
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
    try {
      for (
        let callIndex = 0;
        input.progress || callIndex <= maximumDshToolCallsPerTurn;
        callIndex++
      ) {
        if (executionSignal.aborted)
          throw new HandlerError(
            'EXECUTION_ABORTED',
            'DSH execution was interrupted',
            false,
          );
        const result = await this.runOnce({
          runtime,
          prompt,
          images: callIndex === 0 ? (input.images ?? []) : [],
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
                outputTokens: usage.outputTokens + receipt.usage.outputTokens,
              },
            };
          },
          onTurn: async (nextTurnId) => {
            turnId = nextTurnId;
            await input.onTurnStarted?.({ threadId, turnId: nextTurnId });
          },
          onDelta: async (text, source) =>
            emit({ type: 'assistant.delta', text, ...source }),
          onNative: async (event) => emit(event),
        });
        usage.inputTokens += result.usage.inputTokens;
        usage.cachedInputTokens += result.usage.cachedInputTokens;
        usage.outputTokens += result.usage.outputTokens;
        usageComplete &&= result.usageComplete;
        cacheUsageKnown &&= result.cacheUsageKnown;
        const toolCall = parseDshToolCall(result.answer);
        if (!toolCall) {
          if (assistantAdmissionFailure) throw assistantAdmissionFailure;
          const joined = assistant
            ? await runtime.client.assistant('join', {
                nativeSessionId: threadId,
              })
            : null;
          if (assistantAdmissionFailure) throw assistantAdmissionFailure;
          if (assistant) {
            // Native join proves all loops idle. Stop and await the active-run
            // poll before persisting a terminal root, whose authority is no
            // longer admissible. Finalization performs its own current check.
            if (cancellationTimer) clearInterval(cancellationTimer);
            await cancellationTask;
            executionSignal.throwIfAborted();
            // finish deliberately clears the native Run-bound maps.
            await captureAssistantDiagnostics();
            await runtime.client.assistant('finish', {
              nativeSessionId: threadId,
            });
            assistantOutcome = await assistant.finish?.();
            assistantFinished = true;
            if (!assistantOutcome)
              throw Error('assistant_completion_proof_required');
            Object.assign(usage, assistantOutcome.usage);
            if (
              (!assistantOutcome.usageComplete &&
                !observeCodexTokens(
                  !!input.assistants?.subscriptionSnapshot,
                )) ||
              !['completed', 'partial'].includes(assistantOutcome.status)
            )
              throw new AssistantExecutionUnresolvedError(
                usage,
                assistantOutcome.usageComplete,
                assistantDiagnostics,
              );
          }
          answer = normalizeAllRiceManagedFileLinks(
            typeof joined?.answer === 'string' ? joined.answer : result.answer,
          );
          if (assistantOutcome?.status === 'partial')
            answer = `部分结果：助手已返回可用内容，但仍有未完成事项；这不是整项任务完成确认。\n\n${answer}`;
          await emit({
            type: 'assistant.completed',
            text: answer,
            ...(result.completionSource ?? {}),
          });
          await emit({
            type: 'usage.updated',
            ...usage,
            ...(result.usageSource ?? result.completionSource ?? {}),
          });
          break;
        }
        if (!input.progress && callIndex === maximumDshToolCallsPerTurn) {
          throw new HandlerError(
            'DSH_TOOL_LIMIT_EXCEEDED',
            'DSH exceeded the AllRice tool-call limit',
            false,
          );
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
          })}</allrice_tool_result>`;
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
      // Capture before cancel/drop destroys the host, without widening root
      // authority or reading another native session's transcript.
      await captureAssistantDiagnostics();
      attachAssistantFailureDiagnostics(error, assistantDiagnostics);
      let failedUsage: AssistantFailureUsage | undefined = interruptedUsage;
      if (cancellationTimer) clearInterval(cancellationTimer);
      await cancellationTask?.catch(() => {});
      try {
        if (assistant && !assistantFinished) {
          await assistant.cancel().catch(() => {});
          if (!assistantFailureSignal.signal.aborted) {
            const request = await assistant.cancellation();
            await runtime.client.assistant('drain', request);
          }
        }
      } catch {
        // Revoked membership/lease may forbid reading the tree; still stop our host.
      } finally {
        // Drain's durable stopped receipts release only undispatched holds.
        // Read confirmed prior usage even if drain failed (then completeness
        // remains false). Do not use model output, diagnostics or guessed zero.
        if (assistant)
          failedUsage = await assistant.failureUsage?.().catch(() => undefined);
        await this.runtimePool.drop(threadId);
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
      if (cancellationTimer) clearInterval(cancellationTimer);
      input.signal.removeEventListener('abort', stopAssistants);
      await cancellationTask?.catch(() => {});
      if (assistant)
        await runtime.client.assistant('flush', {}).catch(() => {});
      this.runtimePool.touch(runtime);
      runtime.client.setRequestHandler(null);
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

  runtimeInventory() {
    return this.runtimePool.inventory();
  }

  private async runOnce(input: {
    runtime: DshRuntime;
    prompt: string;
    images: HarnessExecutionInput['images'];
    signal: AbortSignal;
    subscription: boolean;
    questionWait?: HarnessExecutionInput['questionWait'];
    resume?: NonNullable<HarnessExecutionInput['questionWait']>['resume'];
    onFailureUsage(receipt: AssistantFailureUsage): void;
    onTurn(turnId: string): Promise<void>;
    onDelta(text: string, source: DshSourceMetadata): Promise<void>;
    onNative(event: HarnessEventPayload): Promise<void>;
  }) {
    let rawAnswer = '';
    let answer = '';
    let visibleLength = 0;
    let deltaBuffer = '';
    let deltaMode: 'unknown' | 'answer' | 'tool' = 'unknown';
    let eventChain = Promise.resolve();
    let processingError: unknown;
    let idle = false;
    let started = false;
    let waitTimer: NodeJS.Timeout | undefined;
    let parking: Promise<unknown> | undefined;
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
    const activeNativeTools = new Map<
      string,
      { name: string; query?: string }
    >();
    const processNotification = async (notification: DshNotification) => {
      if (notification.params.sessionId !== input.runtime.sessionId) return;
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
          ? normalized.data.questions[0]?.question
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
      if (notification.method !== 'session.event') return;
      const event = record(notification.params.event);
      const data = record(event?.data);
      if (!event || !data) return;
      const source = sourceMetadata(event);
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
        const firstBlock = Array.isArray(message?.content)
          ? record(message.content[0])
          : null;
        const callId = shortText(
          firstBlock?.toolCallId ?? message?.toolCallId ?? message?.callId,
          240,
        );
        if (!callId) return;
        const active = activeNativeTools.get(callId);
        const name = active?.name ?? 'tool';
        const skillName = name === 'skill' ? active?.query : undefined;
        // Pinned DSH's ToolResultMessage carries the authoritative outcome on
        // its single tool-result block; event.error is optional diagnostics.
        // Keep legacy event errors, but never infer status from result text or
        // truthy strings and never copy raw arguments/results into the stream.
        const failed =
          Boolean(data.error) ||
          (firstBlock?.type === 'tool-result' && firstBlock.isError === true);
        await input.onNative({
          type: failed ? 'tool.failed' : 'tool.completed',
          toolCallId: callId,
          name,
          label: skillName ? `Skill · ${skillName}` : name,
          source: 'harness',
          summary: skillName
            ? failed
              ? 'Skill 加载失败'
              : 'Skill 已加载'
            : isDshSearchTool(name)
              ? failed
                ? '搜索失败'
                : '搜索完成'
              : failed
                ? '工具执行失败'
                : '工具执行完成',
          ...source,
          sourcePayload: {
            ...source.sourcePayload,
            presentation: isDshSearchTool(name) ? 'search' : 'tool',
            status: failed ? 'failed' : 'completed',
            ...(active?.query ? { query: active.query } : {}),
            ...(skillName
              ? {
                  skillName,
                  skillStatus: failed ? 'failed' : 'loaded',
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
        const turn =
          typeof data.turn === 'number' || typeof data.turn === 'string'
            ? String(data.turn)
            : randomUUID();
        await input.onTurn(`${input.runtime.sessionId}:turn:${turn}`);
        return;
      }
      if (event.type === 'assistant/chunk') {
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
            label: 'Rice 正在思考',
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
          await input.onDelta(delta, source);
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
        await input.onDelta(deltaBuffer, source);
        deltaBuffer = '';
        return;
      }
      if (event.type === 'assistant/message') {
        completionSource = source;
        const message = record(data.message);
        const final = textBlocks(message?.content);
        if (final) {
          rawAnswer = final;
          const visible = visibleModelText(final);
          if (visible.ready) answer = visible.text;
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
            true,
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
        await input.onDelta(deltaBuffer, {
          sourceEventId: `dsh:buffer:${randomUUID()}`,
          sourceEventType: 'assistant/chunk',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: { text: deltaBuffer },
        });
      }
      return {
        answer,
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
