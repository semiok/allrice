import type { ChatFlowEventEnvelope } from '@allrice/contracts';

export type NativeExperienceKind =
  'context' | 'think' | 'search' | 'tool' | 'todo' | 'compaction' | 'lifecycle';

export interface NativeExperienceItem {
  id: string;
  kind: NativeExperienceKind;
  status: 'started' | 'updated' | 'completed' | 'failed' | 'info';
  title: string;
  detail?: string;
  sequence: number;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nativeKey(event: ChatFlowEventEnvelope, kind: NativeExperienceKind) {
  const native = event.sourceEvent?.payload ?? {};
  const turn = String(native.turn ?? '');
  const step = String(native.step ?? '');
  const chunk =
    native.chunk && typeof native.chunk === 'object'
      ? (native.chunk as Record<string, unknown>)
      : {};
  if (kind === 'think') {
    return `think:${turn}:${step}:${String(chunk.index ?? '')}`;
  }
  const callId = text(native.callId);
  if ((kind === 'tool' || kind === 'search') && callId) {
    return `native-tool:${callId}`;
  }
  const compactionId = text(native.compactionId);
  if (kind === 'compaction' && compactionId) {
    return `compaction:${compactionId}`;
  }
  return event.eventId;
}

function toolKey(event: ChatFlowEventEnvelope) {
  return `tool:${String(event.payload.toolCallId ?? event.eventId)}`;
}

/**
 * Projects durable ChatFlow 3.0 events in the same order DSH emitted them.
 * Updates for one native block/tool replace that row in place, avoiding the
 * running-to-completed layout jump that the old generic execution group caused.
 */
export function projectNativeExperience(events: ChatFlowEventEnvelope[]) {
  const items = new Map<string, NativeExperienceItem>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === 'harness.native') {
      const kind = event.payload.presentation as NativeExperienceKind;
      if (
        ![
          'context',
          'think',
          'search',
          'tool',
          'todo',
          'compaction',
          'lifecycle',
        ].includes(kind)
      ) {
        continue;
      }
      const key = nativeKey(event, kind);
      const previous = items.get(key);
      const resolvedKind =
        previous?.kind === 'search' && kind === 'tool' ? 'search' : kind;
      const label = text(event.payload.label);
      const resolvedTitle =
        previous && label === '工具调用完成'
          ? previous.title
          : (label ?? previous?.title ?? 'DSH 事件');
      items.set(key, {
        id: key,
        kind: resolvedKind,
        status:
          (event.payload.status as NativeExperienceItem['status']) ?? 'info',
        title: resolvedTitle,
        ...(text(event.payload.summary)
          ? { detail: text(event.payload.summary) }
          : previous?.detail
            ? { detail: previous.detail }
            : {}),
        sequence: previous?.sequence ?? event.sequence,
      });
      continue;
    }
    if (event.type.startsWith('tool.')) {
      const key = toolKey(event);
      const previous = items.get(key);
      const name = text(event.payload.name) ?? text(event.payload.label);
      const native = event.sourceEvent?.payload ?? {};
      const kind: NativeExperienceKind =
        native.presentation === 'search' || name === 'web.search'
          ? 'search'
          : 'tool';
      const status = event.type.endsWith('.started')
        ? 'started'
        : event.type.endsWith('.failed')
          ? 'failed'
          : 'completed';
      const query = text(native.query);
      items.set(key, {
        id: key,
        kind,
        status,
        title:
          kind === 'search'
            ? query
              ? `Search · ${query}`
              : (previous?.title ?? 'Search')
            : (name ?? 'Tool'),
        ...(text(event.payload.summary)
          ? { detail: text(event.payload.summary) }
          : previous?.detail
            ? { detail: previous.detail }
            : {}),
        sequence: previous?.sequence ?? event.sequence,
      });
      continue;
    }
    if (event.type.startsWith('context.compaction.')) {
      const key = `allrice-compaction:${event.runId}`;
      const previous = items.get(key);
      items.set(key, {
        id: key,
        kind: 'compaction',
        status: event.type.endsWith('.started')
          ? 'started'
          : event.type.endsWith('.failed')
            ? 'failed'
            : 'completed',
        title: event.type.endsWith('.started')
          ? '正在整理会话上下文'
          : event.type.endsWith('.failed')
            ? '会话上下文整理失败'
            : '会话上下文已整理',
        sequence: previous?.sequence ?? event.sequence,
      });
    }
  }
  const projected = [...items.values()]
    .filter((item) => item.kind !== 'context')
    .sort((a, b) => a.sequence - b.sequence);
  const lastThink = projected.findLast((item) => item.kind === 'think');
  return projected.filter(
    (item) => item.kind !== 'think' || item.id === lastThink?.id,
  );
}
