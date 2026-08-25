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
