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
  lifecycle: number;
  context: number;
  approvals: number;
  routes: number;
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
  const lifecycle = events.filter(
    (event) =>
      event.type.startsWith('session.') || event.type.startsWith('turn.'),
  );
  const context = events.filter((event) => event.type.startsWith('context.'));
  const approvals = events.filter((event) =>
    event.type.startsWith('approval.'),
  );
  const routes = events.filter((event) => event.type.startsWith('routing.'));
  return {
    events: [
      ...lifecycle,
      ...routes,
      ...steps,
      ...tools,
      ...approvals,
      ...context,
      ...retries,
    ].sort((left, right) => left.sequence - right.sequence),
    steps: steps.length,
    tools: tools.length,
    retries: retries.length,
    lifecycle: lifecycle.length,
    context: context.length,
    approvals: approvals.length,
    routes: routes.length,
  };
}

export function runtimeTraceSummary(summary: RuntimeEventSummary) {
  const labels = [
    summary.steps ? `${summary.steps} 个步骤` : '',
    summary.tools ? `${summary.tools} 个工具调用` : '',
    summary.retries ? `${summary.retries} 次重试` : '',
    summary.context ? `${summary.context} 条上下文记录` : '',
    summary.approvals ? `${summary.approvals} 条审批记录` : '',
  ].filter(Boolean);
  return labels.length ? `执行记录 · ${labels.join(' · ')}` : '执行记录';
}
