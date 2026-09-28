import type { ChatFlowEventEnvelope } from '@allrice/contracts';
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
) {
  const current = currentAssistantEvents(events);
  const items = projectNativeExperience(current);
  const replies = assistantReplies(current);
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
  if (!interleaved)
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
      .filter((item) =>
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
