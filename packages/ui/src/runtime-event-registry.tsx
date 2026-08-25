import type { ReactNode } from 'react';

import {
  runtimeTraceSummary,
  summarizeRuntimeEvents,
  type RuntimeEventLike,
} from './runtime-events.ts';

export interface RuntimeEventRendererProps {
  event: RuntimeEventLike;
  toolLabel?: (name: unknown) => string;
}

export type RuntimeEventRenderer = (
  props: RuntimeEventRendererProps,
) => ReactNode;

export class RuntimeEventRendererRegistry {
  private readonly renderers = new Map<string, RuntimeEventRenderer>();

  register(typeOrPrefix: string, renderer: RuntimeEventRenderer) {
    this.renderers.set(typeOrPrefix, renderer);
    return this;
  }

  resolve(type: string) {
    const exact = this.renderers.get(type);
    if (exact) return exact;
    const prefix = [...this.renderers.entries()].find(
      ([key]) => key.endsWith('*') && type.startsWith(key.slice(0, -1)),
    );
    return prefix?.[1] ?? null;
  }
}

function eventState(event: RuntimeEventLike) {
  if (event.type.endsWith('.completed')) return 'completed';
  if (event.type.endsWith('.failed')) return 'failed';
  return 'started';
}

function RuntimeRow({
  children,
  event,
}: {
  children: ReactNode;
  event: RuntimeEventLike;
}) {
  return (
    <div className="ar-runtime-row">
      <span
        className={`ar-runtime-state ar-runtime-state-${eventState(event)}`}
      />
      <div>{children}</div>
    </div>
  );
}

export const defaultRuntimeEventRegistry = new RuntimeEventRendererRegistry()
  .register('session.bound', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>会话已连接</strong>
      <small>
        {event.payload.resumed ? '已恢复原会话' : '已建立会话'} ·{' '}
        {String(event.payload.source ?? 'Harness')} · 第{' '}
        {String(event.payload.generation ?? 0)} 代上下文
      </small>
    </RuntimeRow>
  ))
  .register('routing.selected', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>
        {event.payload.fallback ? '已切换执行引擎' : '已选择执行引擎'}
      </strong>
      <small>
        {String(event.payload.source ?? '')} ·{' '}
        {String(event.payload.model ?? '')}
      </small>
    </RuntimeRow>
  ))
  .register('turn.*', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>
        {event.type === 'turn.started'
          ? 'Rice 正在处理'
          : event.type === 'turn.completed'
            ? '本轮已完成'
            : event.type === 'turn.canceled'
              ? '本轮已停止'
              : '本轮未完成'}
      </strong>
      <small>{String(event.payload.source ?? 'ChatFlow')}</small>
    </RuntimeRow>
  ))
  .register('step.*', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>
        {String(event.payload.name ?? event.payload.stepKey ?? '工作步骤')}
      </strong>
      <small>
        {event.type === 'step.completed'
          ? '已完成'
          : event.type === 'step.waiting_approval'
            ? '等待你的确认'
            : event.type === 'step.retrying'
              ? `正在重试 · 第 ${String(event.payload.attempt ?? '?')} 次`
              : '正在执行'}
      </small>
    </RuntimeRow>
  ))
  .register('tool.*', ({ event, toolLabel }) => (
    <RuntimeRow event={event}>
      <strong>
        {toolLabel?.(event.payload.name) ??
          String(event.payload.label ?? event.payload.name ?? '工具调用')}
      </strong>
      <small>
        {String(
          event.payload.summary ??
            (event.type === 'tool.started'
              ? '正在调用…'
              : event.type === 'tool.failed'
                ? '调用失败'
                : '调用完成'),
        )}
      </small>
    </RuntimeRow>
  ))
  .register('run.retrying', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>正在重试</strong>
      <small>第 {String(event.payload.attempt ?? '?')} 次执行未完成</small>
    </RuntimeRow>
  ))
  .register('context.*', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>
        {event.type === 'context.checkpoint.created'
          ? '上下文恢复点已保存'
          : event.type === 'context.compaction.completed'
            ? '上下文整理完成'
            : event.type === 'context.compaction.failed'
              ? '上下文整理失败'
              : '正在整理上下文'}
      </strong>
      <small>
        {event.payload.estimatedTokens
          ? `约 ${String(event.payload.estimatedTokens)} tokens`
          : String(event.payload.contextStrategy ?? '')}
      </small>
    </RuntimeRow>
  ))
  .register('approval.*', ({ event }) => (
    <RuntimeRow event={event}>
      <strong>
        {event.type === 'approval.requested' ? '等待你的确认' : '审批已处理'}
      </strong>
      <small>
        {String(event.payload.name ?? event.payload.decision ?? '')}
      </small>
    </RuntimeRow>
  ));

export function RuntimeEventNode({
  event,
  registry = defaultRuntimeEventRegistry,
  toolLabel,
}: RuntimeEventRendererProps & { registry?: RuntimeEventRendererRegistry }) {
  const Renderer = registry.resolve(event.type);
  return Renderer ? <>{Renderer({ event, toolLabel })}</> : null;
}

export function RuntimeTrace({
  events,
  footer,
  registry = defaultRuntimeEventRegistry,
  toolLabel,
}: {
  events: RuntimeEventLike[];
  footer?: ReactNode;
  registry?: RuntimeEventRendererRegistry;
  toolLabel?: (name: unknown) => string;
}) {
  const summary = summarizeRuntimeEvents(events);
  if (summary.events.length === 0 && !footer) return null;
  return (
    <details className="ar-runtime-trace">
      <summary>{runtimeTraceSummary(summary)}</summary>
      <div className="ar-runtime-list">
        {summary.events.map((event) => (
          <RuntimeEventNode
            event={event}
            key={event.eventId}
            registry={registry}
            toolLabel={toolLabel}
          />
        ))}
        {footer}
      </div>
    </details>
  );
}
