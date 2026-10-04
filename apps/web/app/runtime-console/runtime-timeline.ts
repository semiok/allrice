import type { RuntimeRunUsage, TaskRuntimeTiming } from '@allrice/contracts';

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
  timing?: TaskRuntimeTiming | null;
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

export function runtimeTimelineCategory(
  event: Pick<RuntimeTimelineEvent, 'kind' | 'title'>,
) {
  if (
    event.kind === 'compaction' ||
    (event.kind === 'context' && event.title.startsWith('上下文占用'))
  )
    return 'context';
  if (event.kind === 'context' || event.title.startsWith('Skill 已加载')) {
    return 'prepare';
  }
  return event.kind;
}

export function runtimeTimelineStatus(status: string) {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return { label: '已完成', tone: 'success', icon: 'check' } as const;
    case 'started':
      return { label: '已开始', tone: 'active', icon: 'play' } as const;
    case 'running':
      return { label: '执行中', tone: 'active', icon: 'play' } as const;
    case 'failed':
    case 'error':
      return { label: '失败', tone: 'danger', icon: 'warning' } as const;
    case 'cancelled':
      return { label: '已取消', tone: 'danger', icon: 'warning' } as const;
    case 'updated':
      return { label: '已更新', tone: 'updated', icon: 'refresh' } as const;
    case 'info':
      return { label: '信息', tone: 'muted', icon: null } as const;
    case 'incomplete':
      return { label: '无结束记录', tone: 'muted', icon: 'info' } as const;
    default:
      return { label: status, tone: 'muted', icon: null } as const;
  }
}

function aggregationBucket(event: RuntimeTimelineEvent) {
  if (event.title === 'Skill 已加载') return 'skills-loaded';
  if (runtimeTimelineCategory(event) === 'context') return 'context-activity';
  if (event.kind === 'context' && /上下文|context/i.test(event.title)) {
    return 'context-preparation';
  }
  if (event.kind === 'tool') return `tool:${event.title}`;
  return null;
}

function groupStatus(events: RuntimeTimelineEvent[]) {
  const failed = events.find((event) =>
    ['failed', 'error'].includes(event.status),
  );
  if (failed) return failed.status;
  if (events.some((event) => event.status === 'cancelled')) return 'cancelled';

  const compaction = events.filter((event) => event.kind === 'compaction');
  if (compaction.length) {
    // Start and end are separate historical records, rather than distinct jobs.
    const lastStart = compaction.findLastIndex(
      (event) => event.status === 'started',
    );
    const lastEnd = compaction.findLastIndex(
      (event) => event.status === 'completed' && event.title === '上下文已整理',
    );
    if (lastStart >= 0) return lastEnd > lastStart ? 'completed' : 'running';
    if (lastEnd >= 0) return 'completed';
    return compaction.at(-1)!.status;
  }

  if (events.some((event) => ['started', 'running'].includes(event.status))) {
    return 'running';
  }
  if (
    events.every((event) => ['completed', 'succeeded'].includes(event.status))
  ) {
    return 'completed';
  }
  return events.at(-1)!.status;
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
  options: { runStatus?: string } = {},
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
      projected[cursor]!.runId === event.runId &&
      aggregationBucket(projected[cursor]!) === bucket
    ) {
      grouped.push(projected[cursor]!);
      cursor += 1;
    }

    if (grouped.length === 1) {
      result.push({ type: 'event', key: event.key, event });
    } else {
      const status = groupStatus(grouped);
      const runEnded = [
        'succeeded',
        'failed',
        'canceled',
        'cancelled',
        'completed',
      ].includes(options.runStatus ?? '');
      result.push({
        type: 'group',
        key: `${event.runId}:${bucket}:${event.sequence}`,
        kind: grouped.some((item) => item.kind === 'compaction')
          ? 'compaction'
          : event.kind,
        title:
          bucket === 'skills-loaded'
            ? `Skill 已加载 · ${grouped.length} 个`
            : bucket === 'context-preparation'
              ? `上下文准备 · ${grouped.length} 项`
              : bucket === 'context-activity'
                ? `${grouped.some((item) => item.kind === 'compaction') ? '上下文整理' : '上下文占用'} · ${grouped.length} 条记录`
                : `${event.title} · 连续调用 ${grouped.length} 次`,
        status: status === 'running' && runEnded ? 'incomplete' : status,
        occurredAt: grouped.at(-1)?.occurredAt ?? event.occurredAt,
        events: grouped,
      });
    }
    index = cursor;
  }

  return result;
}
