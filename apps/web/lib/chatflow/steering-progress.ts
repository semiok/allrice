import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { Message } from '../../app/chatflow/chatflow-types';
import { nativeProcessGroups } from './native-process-groups';
import type { NativeExperienceItem } from './native-experience';
import {
  currentWorkProgressEvents,
  type WorkProgressPart,
} from './work-progress';

/** Use native adoption anchors, never submission timestamps, as process boundaries. */
export function steeringProgress(
  events: ChatFlowEventEnvelope[],
  messages: Message[],
  items: NativeExperienceItem[],
  parts: WorkProgressPart[] | undefined,
  running: boolean,
) {
  const current = currentWorkProgressEvents(events);
  const boundaries = messages
    .map((message) => {
      const proof = message.steering!;
      const anchor = current.find(
        (event) =>
          event.sourceEvent?.id === `dsh:${proof.sequence}` &&
          event.payload.turnId === proof.turnId &&
          event.payload.generation === proof.generation,
      );
      return { message, sequence: anchor?.sequence ?? Infinity };
    })
    .sort(
      (a, b) =>
        a.sequence - b.sequence ||
        (a.message.steering!.sequence ?? Infinity) -
          (b.message.steering!.sequence ?? Infinity),
    );
  // An unloaded trace still has durable user inputs and a final history answer.
  // Keep those inputs ahead of that answer until their precise anchors arrive.
  const rows = parts?.flatMap<WorkProgressPart>((part) =>
    part.kind === 'reply'
      ? [part]
      : part.items.map((item) => ({
          kind: 'steps' as const,
          id: item.id,
          sequence: item.sequence,
          items: [item],
        })),
  );
  return Array.from({ length: boundaries.length + 1 }, (_, index) => {
    const lower = index === 0 ? -Infinity : boundaries[index - 1]!.sequence;
    const upper = boundaries[index]?.sequence ?? Infinity;
    const last = index === boundaries.length;
    const belongs = (sequence: number) =>
      sequence >= lower && (last || sequence < upper);
    const segmentRows = rows?.filter((part) =>
      // Persisted final fallback must never precede an adopted input.
      part.kind === 'reply' &&
      (['history-reply', 'final-reply'].includes(part.id) ||
        (!running && part === parts?.at(-1)))
        ? last
        : belongs(part.sequence),
    );
    return {
      key: index === 0 ? 'initial' : boundaries[index - 1]!.message.id,
      message: index === 0 ? undefined : boundaries[index - 1]!.message,
      items: items.filter((item) => belongs(item.sequence)),
      parts: segmentRows
        ? nativeProcessGroups(segmentRows, last && running, current)
        : undefined,
      last,
    };
  });
}
