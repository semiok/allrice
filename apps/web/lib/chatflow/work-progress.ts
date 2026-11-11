import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { nativeProcessGroups } from './native-process-groups';
import {
  assistantReplies,
  currentAssistantEvents,
} from '../execution/assistant-stream';
import {
  projectNativeExperience,
  type NativeExperienceItem,
  type WorkProcessReference,
} from './native-experience';
export type { WorkProcessReference } from './native-experience';

export function workProcessReferenceKey(reference: WorkProcessReference) {
  return `${reference.source}:${reference.id}`;
}

function nativeCallId(event: ChatFlowEventEnvelope) {
  const value = event.type.startsWith('tool.')
    ? event.payload.toolCallId
    : event.type === 'harness.native' &&
        ['tool', 'search'].includes(String(event.payload.presentation))
      ? event.sourceEvent?.payload.callId
      : undefined;
  return typeof value === 'string' && value ? value : undefined;
}

function matchesReference(
  reference: WorkProcessReference,
  event: ChatFlowEventEnvelope,
) {
  if (reference.runId !== event.runId || event.payload.internalTask)
    return false;
  const binding = reference.binding;
  const scope = binding?.task?.scope ?? reference;
  if (
    scope.organizationId !== event.organizationId ||
    scope.workspaceId !== event.workspaceId ||
    (reference.organizationId &&
      reference.organizationId !== event.organizationId) ||
    (reference.workspaceId && reference.workspaceId !== event.workspaceId)
  )
    return false;
  if (
    reference.source === 'managed-browser' ||
    reference.jobAttempt !== undefined
  ) {
    const attempt = reference.jobAttempt;
    if (
      typeof attempt !== 'number' ||
      !Number.isInteger(attempt) ||
      attempt < 1 ||
      attempt !== event.payload.attempt
    )
      return false;
  }
  if (!binding) return reference.source === 'managed-browser';
  if (!binding.task || !binding.attempt) return false;
  const generation = event.payload.generation;
  return (
    binding.task.runId === event.runId &&
    binding.task.rootRunId === event.runId &&
    binding.attempt.operationId === reference.id &&
    typeof generation === 'number' &&
    Number.isInteger(generation) &&
    generation >= 0 &&
    binding.attempt.generation === generation &&
    (event.generation === null || event.generation === generation)
  );
}

export type WorkProgressPart =
  | {
      kind: 'reply';
      id: string;
      sequence: number;
      text: string;
      /** Matched against the accepted final text/completion, never row position. */
      readonly finalAnswer?: boolean;
    }
  | {
      kind: 'steps';
      id: string;
      sequence: number;
      items: NativeExperienceItem[];
      closed?: boolean;
    };

/** Public events may carry generation on the envelope instead of the payload. */
export function currentWorkProgressEvents(events: ChatFlowEventEnvelope[]) {
  return currentAssistantEvents(
    events.map((event): ChatFlowEventEnvelope => ({
      ...event,
      payload: {
        ...event.payload,
        generation: event.payload.generation ?? event.generation,
      },
    })),
  );
}

/** Only a current native text delta means that the model is still replying.
 * A completed intermediate reply must not keep the whole turn in "replying".
 * Projection/usage telemetry does not change the active phase.
 */
export function isReplyStreaming(events: ChatFlowEventEnvelope[]) {
  for (const event of currentWorkProgressEvents(events).reverse()) {
    if (event.type === 'assistant.text.delta')
      return (
        event.payload.textMode !== 'replace' &&
        typeof event.payload.text === 'string' &&
        !!event.payload.text.trim()
      );
    if (
      event.type === 'assistant.text.completed' ||
      event.type.startsWith('tool.') ||
      event.type.startsWith('context.compaction.') ||
      [
        'request/context',
        'request/header',
        'assistant/message',
        'llm/retry',
      ].includes(event.sourceEvent?.type ?? '') ||
      (event.type === 'harness.native' &&
        ['think', 'tool', 'search', 'compaction'].includes(
          String(event.payload.presentation),
        ))
    )
      return false;
  }
  return false;
}

/** Adapt durable Allrice events to the official DSH process grouping. */
export function projectWorkProgress(
  events: ChatFlowEventEnvelope[],
  fallback: string,
  running: boolean,
  streamingOutput = true,
  operations: readonly WorkProcessReference[] = [],
) {
  const current = currentWorkProgressEvents(events);
  const replies = assistantReplies(current);
  const items = projectNativeExperience(current);
  const seen = new Set<string>();
  for (const op of operations) {
    const key = workProcessReferenceKey(op);
    if (seen.has(key)) continue;
    seen.add(key);
    const call = op.nativeCallId;
    const candidates =
      call && !call.startsWith('legacy:') && !op.parentOperationId
        ? current.filter((event) => nativeCallId(event) === call)
        : [];
    const starts = candidates.filter(
      (event) =>
        event.type === 'tool.started' || event.payload.status === 'started',
    );
    // Canonical and historical views can share one actual native source event.
    // Distinct starts with the same call ID do not prove a single call.
    const item =
      candidates.length &&
      candidates.every((event) => matchesReference(op, event)) &&
      new Set(starts.map((event) => event.sourceEvent?.id ?? event.eventId))
        .size <= 1
        ? items.find((item) => item.id === `tool:${call}`)
        : undefined;
    if (item) {
      item.operations = [...(item.operations ?? []), op];
      continue;
    }
    // History can arrive after receipts. Keep every receipt visible without
    // guessing that two calls with the same tool name are the same operation.
    const createdAt = op.createdAt ? Date.parse(op.createdAt) : NaN;
    const next = current.find(
      (event) => Date.parse(event.occurredAt) >= createdAt,
    );
    items.push({
      id: `operation:${key}`,
      operations: [op],
      kind: 'tool',
      toolName: op.binding?.action,
      title: op.title,
      sequence: next
        ? next.sequence - 0.5
        : !Number.isFinite(createdAt) && replies.length
          ? replies.at(-1)!.sequence - 0.5
          : (current.at(-1)?.sequence ?? 0) + 0.5,
      status: op.failed ? 'failed' : 'info',
    });
  }
  const completed = current
    .filter((event) => event.type === 'assistant.text.completed')
    .at(-1);
  const finalText = running
    ? ''
    : typeof completed?.payload.text === 'string'
      ? completed.payload.text
      : fallback;
  const latest = replies.at(-1);
  if (!streamingOutput)
    return {
      items,
      parts: undefined,
      finalText: running ? '' : finalText || latest?.text || '',
    };
  // Legacy events have no reliable message boundary. Keep their familiar final
  // response instead of guessing which substring was an intermediate reply.
  const interleaved = replies.some((reply) => reply.id !== 'legacy');
  if (!interleaved && !operations.length)
    return {
      items,
      parts: undefined,
      finalText: finalText || latest?.text || '',
    };
  const finalReplyId =
    !running &&
    latest &&
    (latest.text === finalText || completed?.payload.replyId === latest.id)
      ? latest.id
      : undefined;
  const ordered: WorkProgressPart[] = [
    ...replies.map((reply) => ({
      ...reply,
      id: `reply:${reply.id}`,
      text: reply.id === finalReplyId ? finalText : reply.text,
      kind: 'reply' as const,
      ...(reply.id === finalReplyId ? { finalAnswer: true } : {}),
    })),
    ...items
      .filter(
        (item) =>
          item.modelWait ||
          ['tool', 'search', 'think', 'compaction', 'todo'].includes(item.kind),
      )
      .map((item) => ({
        kind: 'steps' as const,
        id: item.id,
        sequence: item.sequence,
        items: [item],
      })),
  ].sort((a, b) => a.sequence - b.sequence);
  if (finalText && !finalReplyId)
    ordered.push({
      kind: 'reply',
      id: 'final-reply',
      sequence: (current.at(-1)?.sequence ?? 0) + 1,
      text: finalText,
      finalAnswer: true,
    });
  const parts = nativeProcessGroups(ordered, running, current);
  return { items, parts, finalText };
}
