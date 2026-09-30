import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import { nativeProcessGroups } from './native-process-groups';
import {
  assistantReplies,
  currentAssistantEvents,
} from '../execution/assistant-stream';
import {
  projectNativeExperience,
  type NativeExperienceItem,
} from './native-experience';

export type WorkProgressPart =
  | { kind: 'reply'; id: string; sequence: number; text: string }
  | {
      kind: 'steps';
      id: string;
      sequence: number;
      items: NativeExperienceItem[];
      closed?: boolean;
    };

/** Only a current native text delta means that the model is still replying.
 * A completed intermediate reply must not keep the whole turn in "replying".
 * Projection/usage telemetry does not change the active phase.
 */
export function isReplyStreaming(events: ChatFlowEventEnvelope[]) {
  for (const event of currentAssistantEvents(events).reverse()) {
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
  operations: readonly CloudOperationView[] = [],
) {
  const current = currentAssistantEvents(events);
  const replies = assistantReplies(current);
  const items = projectNativeExperience(current);
  for (const op of operations) {
    const operationId = op.snapshot.binding.attempt.operationId;
    const item = op.nativeCallId
      ? items.find((item) => item.id === `tool:${op.nativeCallId}`)
      : undefined;
    if (item) {
      item.operationId = operationId;
      continue;
    }
    // History can arrive after receipts. Keep every receipt visible without
    // guessing that two calls with the same tool name are the same operation.
    const createdAt = op.createdAt ? Date.parse(op.createdAt) : NaN;
    const next = current.find(
      (event) => Date.parse(event.occurredAt) >= createdAt,
    );
    items.push({
      id: op.nativeCallId
        ? `tool:${op.nativeCallId}`
        : `operation:${operationId}`,
      operationId,
      kind: 'tool',
      toolName: op.snapshot.binding.action,
      title: op.proposal.kind === 'mcp' ? op.proposal.tool : '云端计算',
      sequence: next
        ? next.sequence - 0.5
        : !Number.isFinite(createdAt) && replies.length
          ? replies.at(-1)!.sequence - 0.5
          : (current.at(-1)?.sequence ?? 0) + 0.5,
      status:
        op.snapshot.status === 'succeeded'
          ? 'completed'
          : op.snapshot.status === 'failed'
            ? 'failed'
            : 'info',
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
    });
  const parts = nativeProcessGroups(ordered, running);
  return { items, parts, finalText };
}
