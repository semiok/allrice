import { randomUUID } from 'node:crypto';

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface DshSourceMetadata {
  sourceEventId: string;
  sourceEventType: string;
  sourceOccurredAt: string;
  sourcePayload: Record<string, unknown>;
}

export function sourceMetadata(
  event: Record<string, unknown>,
): DshSourceMetadata {
  const sequence =
    typeof event.seq === 'number' || typeof event.seq === 'string'
      ? String(event.seq)
      : randomUUID();
  const occurredAt =
    typeof event.time === 'string' && !Number.isNaN(Date.parse(event.time))
      ? new Date(event.time).toISOString()
      : typeof event.time === 'number' && Number.isFinite(event.time)
        ? new Date(event.time).toISOString()
        : new Date().toISOString();
  return {
    sourceEventId: `dsh:${sequence}`,
    sourceEventType:
      typeof event.type === 'string' ? event.type : 'dsh/session-event',
    sourceOccurredAt: occurredAt,
    sourcePayload: safeDshSourcePayload(event),
  };
}

export function shortText(value: unknown, maximum = 240) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : undefined;
}

/**
 * DSH's event log is intentionally lossless, but ChatFlow is a tenant-facing
 * audit stream. Keep ordering and presentation facts while excluding prompts,
 * credentials, raw tool arguments/results and hidden reasoning text.
 */
export function safeDshSourcePayload(event: Record<string, unknown>) {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = record(event.data) ?? {};
  const turn =
    typeof data.turn === 'number' || typeof data.turn === 'string'
      ? data.turn
      : undefined;
  const step =
    typeof data.step === 'number' || typeof data.step === 'string'
      ? data.step
      : undefined;
  const common = {
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  };
  if (type === 'assistant/chunk') {
    const chunk = record(data.chunk) ?? {};
    return {
      ...common,
      chunk: {
        type: shortText(chunk.type),
        ...(typeof chunk.index === 'number' ? { index: chunk.index } : {}),
      },
    };
  }
  if (type === 'assistant/message') {
    const message = record(data.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    return {
      ...common,
      interrupted: data.interrupted === true,
      contentTypes: content
        .map((block) => shortText(record(block)?.type, 80))
        .filter(Boolean),
    };
  }
  if (type === 'request/context') {
    return {
      provider: shortText(data.provider, 120),
      model: shortText(data.model, 160),
      ...(typeof data.contextWindow === 'number'
        ? { contextWindow: data.contextWindow }
        : {}),
    };
  }
  if (type === 'request/header') {
    return { reason: shortText(data.reason, 80) };
  }
  if (type === 'tool/call') {
    return {
      ...common,
      callId: shortText(data.callId, 160),
      name: shortText(data.name, 160),
    };
  }
  if (type === 'tool/result') {
    const message = record(data.message) ?? {};
    const resultBlock = Array.isArray(message.content)
      ? record(message.content[0])
      : null;
    const error = record(data.error);
    return {
      ...common,
      callId: shortText(
        resultBlock?.toolCallId ?? message.toolCallId ?? message.callId,
        160,
      ),
      ...(error
        ? {
            error: {
              name: shortText(error.name, 120),
              code: shortText(error.code, 120),
            },
          }
        : {}),
    };
  }
  if (type === 'user/message') {
    const source = record(data.source);
    return {
      ...common,
      source: source
        ? {
            kind: shortText(source.kind, 80),
            plugin: shortText(source.plugin, 120),
            label: shortText(source.label ?? source.name, 160),
          }
        : undefined,
    };
  }
  if (type === 'todo/write') {
    return {
      count: Array.isArray(data.todos) ? data.todos.length : 0,
      completed: Array.isArray(data.todos)
        ? data.todos.filter((todo) => record(todo)?.status === 'completed')
            .length
        : 0,
    };
  }
  if (type.startsWith('compaction/')) {
    return {
      compactionId: shortText(data.compactionId, 160),
      failed: Boolean(data.error),
    };
  }
  return common;
}

export function nativeEventView(event: Record<string, unknown>) {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = record(event.data) ?? {};
  const source = sourceMetadata(event);
  if (type === 'request/context') {
    const provider = shortText(data.provider, 120);
    const model = shortText(data.model, 160);
    return {
      type: 'native.event' as const,
      presentation: 'context' as const,
      status: 'info' as const,
      label: '模型上下文',
      ...(provider || model
        ? { summary: [provider, model].filter(Boolean).join(' · ') }
        : {}),
      ...source,
    };
  }
  if (type === 'request/header') {
    return {
      type: 'native.event' as const,
      presentation: 'context' as const,
      status: 'completed' as const,
      label: '上下文已注入',
      ...source,
    };
  }
  if (type === 'user/message') {
    const messageSource = record(data.source);
    if (!messageSource || messageSource.kind === 'human') return null;
    const label = shortText(
      messageSource.label ?? messageSource.name ?? messageSource.plugin,
      160,
    );
    return {
      type: 'native.event' as const,
      presentation: 'context' as const,
      status: 'completed' as const,
      label: '上下文注入',
      ...(label ? { summary: label } : {}),
      ...source,
    };
  }
  if (type === 'todo/write') {
    const count = Array.isArray(data.todos) ? data.todos.length : 0;
    return {
      type: 'native.event' as const,
      presentation: 'todo' as const,
      status: 'updated' as const,
      label: '任务计划已更新',
      ...(count ? { summary: `${count} 项` } : {}),
      ...source,
    };
  }
  if (type.startsWith('compaction/')) {
    const phase = type.slice('compaction/'.length);
    return {
      type: 'native.event' as const,
      presentation: 'compaction' as const,
      status:
        phase === 'start'
          ? ('started' as const)
          : data.error
            ? ('failed' as const)
            : phase === 'end'
              ? ('completed' as const)
              : ('updated' as const),
      label:
        phase === 'start'
          ? '正在整理会话上下文'
          : phase === 'end'
            ? '会话上下文已整理'
            : '上下文摘要已生成',
      ...source,
    };
  }
  return null;
}

export function textBlocks(value: unknown) {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const item = record(block);
      return item?.type === 'text' && typeof item.text === 'string'
        ? item.text
        : '';
    })
    .join('');
}

export function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * DSH may stream private reasoning before the user-visible answer. Do not
 * release any partial `<think>` prefix or body to ChatFlow.
 */
export function visibleModelText(text: string) {
  const candidate = text.trimStart();
  if ('<think>'.startsWith(candidate)) {
    return { ready: false, text: '' };
  }
  if (!candidate.startsWith('<think>')) {
    return { ready: true, text };
  }
  const closingTag = candidate.indexOf('</think>');
  if (closingTag === -1) {
    return { ready: false, text: '' };
  }
  return {
    ready: true,
    text: candidate.slice(closingTag + '</think>'.length).trimStart(),
  };
}
