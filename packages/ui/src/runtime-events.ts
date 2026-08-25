export interface RuntimeEventLike {
  eventId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface RuntimeEventSummary {
  events: RuntimeEventLike[];
  steps: number;
  tools: number;
  retries: number;
}

function latestBy(
  events: RuntimeEventLike[],
  prefix: string,
  key: (event: RuntimeEventLike) => string,
) {
  const latest = new Map<string, RuntimeEventLike>();
  for (const event of events) {
    if (!event.type.startsWith(prefix)) continue;
    const id = key(event);
    const previous = latest.get(id);
    if (!previous || event.sequence > previous.sequence) latest.set(id, event);
  }
  return [...latest.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

export function summarizeRuntimeEvents(
  events: RuntimeEventLike[],
): RuntimeEventSummary {
  const steps = latestBy(events, 'step.', (event) =>
    String(event.payload.stepKey ?? event.eventId),
  );
  const tools = latestBy(events, 'tool.', (event) =>
    String(event.payload.toolCallId ?? event.eventId),
  );
  const retries = events.filter((event) => event.type === 'run.retrying');
  return {
    events: [...steps, ...tools, ...retries].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    steps: steps.length,
    tools: tools.length,
    retries: retries.length,
  };
}

export function runtimeTraceSummary(summary: RuntimeEventSummary) {
  const labels = [
    summary.steps ? `${summary.steps} 个步骤` : '',
    summary.tools ? `${summary.tools} 个工具调用` : '',
    summary.retries ? `${summary.retries} 次重试` : '',
  ].filter(Boolean);
  return labels.length ? `执行记录 · ${labels.join(' · ')}` : '执行记录';
}
