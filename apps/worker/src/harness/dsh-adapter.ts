import { randomUUID } from 'node:crypto';

import {
  HarnessEventSchema,
  UserQuestionRequestSchema,
  type HarnessEvent,
} from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type {
  HarnessAdapter,
  HarnessExecutionInput,
  HarnessExecutionResult,
} from './adapter.js';
import type { DshNotification } from './dsh-protocol-client.js';
import {
  nativeEventView,
  positiveInteger,
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
        throw error;
      });
    const ordinaryHandler = dshInboundToolHandler(input);
    runtime.client.setRequestHandler(async (method, params) => {
      if (method.startsWith('allrice/assistant/')) {
        if (!assistant) throw Error('assistant_runtime_disabled');
        return assistant.handle(
          method.slice('allrice/assistant/'.length),
          params,
        );
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
        .catch(async () => {
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
    try {
      for (
        let callIndex = 0;
        callIndex <= maximumDshToolCallsPerTurn;
        callIndex++
      ) {
        const result = await this.runOnce({
          runtime,
          prompt,
          images: callIndex === 0 ? (input.images ?? []) : [],
          signal: executionSignal,
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
        const toolCall = parseDshToolCall(result.answer);
        if (!toolCall) {
          const joined = assistant
            ? await runtime.client.assistant('join', {
                nativeSessionId: threadId,
              })
            : null;
          await assistant?.finish?.();
          answer = normalizeAllRiceManagedFileLinks(
            typeof joined?.answer === 'string' ? joined.answer : result.answer,
          );
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
        if (callIndex === maximumDshToolCallsPerTurn) {
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
    } catch (error) {
      try {
        if (assistant) {
          await assistant.cancel().catch(() => {});
          const request = await assistant.cancellation();
          await runtime.client.assistant('drain', request);
        }
      } catch {
        // Revoked membership/lease may forbid reading the tree; still stop our host.
      } finally {
        await this.runtimePool.drop(threadId);
      }
      if (input.signal.aborted) {
        throw new HandlerError(
          'EXECUTION_ABORTED',
          'DSH execution was interrupted',
          false,
        );
      }
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
    return {
      answer,
      usage,
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
    let settle!: () => void;
    const idlePromise = new Promise<void>((resolveIdle) => {
      settle = resolveIdle;
    });
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let completionSource: DshSourceMetadata | undefined;
    let usageSource: DshSourceMetadata | undefined;
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
        return;
      }
      if (notification.method === 'session.user-question-answered') {
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
        const turn =
          typeof data.turn === 'number' || typeof data.turn === 'string'
            ? String(data.turn)
            : randomUUID();
        await input.onTurn(`${input.runtime.sessionId}:turn:${turn}`);
        return;
      }
      if (event.type === 'assistant/chunk') {
        const chunk = record(data.chunk);
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
        const eventUsage = record(data.usage);
        usage.inputTokens += positiveInteger(eventUsage?.inputTokens);
        usage.cachedInputTokens += positiveInteger(eventUsage?.cacheReadTokens);
        usage.outputTokens += positiveInteger(eventUsage?.outputTokens);
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
    const abort = () => {
      void input.runtime.client
        .interrupt(input.runtime.sessionId)
        .catch(() => {});
      settle();
    };
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    try {
      await input.runtime.client.prompt(
        input.runtime.sessionId,
        input.prompt,
        input.images,
      );
      if (!idle) await idlePromise;
      await eventChain;
      if (processingError) throw processingError;
      if (input.signal.aborted) {
        throw new HandlerError(
          'EXECUTION_ABORTED',
          'DSH execution was interrupted',
          false,
        );
      }
      if (deltaMode === 'unknown' && deltaBuffer && !parseDshToolCall(answer)) {
        await input.onDelta(deltaBuffer, {
          sourceEventId: `dsh:buffer:${randomUUID()}`,
          sourceEventType: 'assistant/chunk',
          sourceOccurredAt: new Date().toISOString(),
          sourcePayload: { text: deltaBuffer },
        });
      }
      return { answer, usage, completionSource, usageSource };
    } finally {
      unsubscribe();
      input.signal.removeEventListener('abort', abort);
    }
  }
}
