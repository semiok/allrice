export interface RuntimeTimelineEvent {
  id: string;
  key: string;
  runId: string;
  sequence: number;
  kind:
    | 'context'
    | 'think'
    | 'search'
    | 'tool'
    | 'todo'
    | 'compaction'
    | 'lifecycle'
    | 'answer';
  status: string;
  title: string;
  detail: string | null;
  occurredAt: string | null;
}

export interface RuntimeTimelineTurn {
  usage?: RuntimeRunUsage | null;
  run: {
    id: string;
    status: string;
    createdAt: string | null;
    completedAt: string | null;
  };
  userMessage: { text: string | null; occurredAt: string | null };
  assistantMessage: {
    text: string | null;
    status: string;
    occurredAt: string | null;
  };
  events: RuntimeTimelineEvent[];
}

export type RuntimeTimelineItem =
  | { type: 'event'; key: string; event: RuntimeTimelineEvent }
  | {
      type: 'group';
      key: string;
      kind: RuntimeTimelineEvent['kind'];
      title: string;
      status: string;
      occurredAt: string | null;
      events: RuntimeTimelineEvent[];
    };

function aggregationBucket(event: RuntimeTimelineEvent) {
  if (event.title === 'Skill 已加载') return 'skills-loaded';
  if (event.kind === 'context' && /上下文|context/i.test(event.title)) {
    return 'context-preparation';
  }
  if (event.kind === 'tool') return `tool:${event.title}`;
  return null;
}

export function projectRuntimeTimelineEvents(events: RuntimeTimelineEvent[]) {
  const items = new Map<string, RuntimeTimelineEvent>();
  for (const event of events) {
    const previous = items.get(event.key);
    items.set(event.key, {
      ...event,
      sequence: previous?.sequence ?? event.sequence,
      title:
        previous && event.title === '工具调用完成'
          ? previous.title
          : event.title,
      detail: event.detail ?? previous?.detail ?? null,
    });
  }
  return [...items.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function aggregateRuntimeTimelineEvents(
  events: RuntimeTimelineEvent[],
): RuntimeTimelineItem[] {
  const projected = projectRuntimeTimelineEvents(events);
  const result: RuntimeTimelineItem[] = [];
  let index = 0;

  while (index < projected.length) {
    const event = projected[index]!;
    const bucket = aggregationBucket(event);
    if (!bucket) {
      result.push({ type: 'event', key: event.key, event });
      index += 1;
      continue;
    }

    const grouped = [event];
    let cursor = index + 1;
    while (
      cursor < projected.length &&
      aggregationBucket(projected[cursor]!) === bucket
    ) {
      grouped.push(projected[cursor]!);
      cursor += 1;
    }

    if (grouped.length === 1) {
      result.push({ type: 'event', key: event.key, event });
    } else {
      result.push({
        type: 'group',
        key: `${event.runId}:${bucket}:${event.sequence}`,
        kind: event.kind,
        title:
          bucket === 'skills-loaded'
            ? `Skill 已加载 · ${grouped.length} 个`
            : bucket === 'context-preparation'
              ? `上下文准备 · ${grouped.length} 项`
              : `${event.title} · 连续调用 ${grouped.length} 次`,
        status: grouped.some((item) => item.status === 'failed')
          ? 'failed'
          : 'completed',
        occurredAt: grouped.at(-1)?.occurredAt ?? event.occurredAt,
        events: grouped,
      });
    }
    index = cursor;
  }

  return result;
}
import type { RuntimeRunUsage } from '@allrice/contracts';
