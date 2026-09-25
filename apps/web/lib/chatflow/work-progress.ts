import type { ChatFlowEventEnvelope } from '@allrice/contracts';
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
    };

/** Adapt durable Allrice events to DSH's process → reply → process reading order.
 * Renderers remain the existing native DisclosureRow and AssistantMarkdown.
 */
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
  const ordered = [
    ...replies
      .filter((reply) => reply.id !== finalReplyId)
      .map((reply) => ({ ...reply, kind: 'reply' as const })),
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
  const parts: WorkProgressPart[] = [];
  for (const part of ordered) {
    const previous = parts.at(-1);
    if (part.kind === 'steps' && previous?.kind === 'steps')
      previous.items.push(...part.items);
    else parts.push(part);
  }
  return { items, parts, finalText };
}
