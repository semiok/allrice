import {
  TaskPlanItemsSchema,
  type ChatFlowEventEnvelope,
} from '@allrice/contracts';
import { currentAssistantEvents } from '../execution/assistant-stream';

/** Whole-list replacement, including an explicit empty list. Never infer steps. */
export function projectTaskPlan(
  events: ChatFlowEventEnvelope[],
  conversationId: string,
  runId: string,
) {
  const snapshots = events.flatMap((event) => {
    if (
      event.conversationId !== conversationId ||
      event.runId !== runId ||
      event.type !== 'harness.native' ||
      event.sourceEvent?.type !== 'todo/write'
    )
      return [];
    const parsed = TaskPlanItemsSchema.safeParse(
      event.sourceEvent.payload.todos,
    );
    return parsed.success ? [{ ...event, todos: parsed.data }] : [];
  });
  // A resumed attempt need not rewrite its checkpointed plan immediately.
  // Keep that Run's last snapshot until a newer attempt writes (or clears) it;
  // late receipts from older attempts cannot overwrite the newer list.
  return currentAssistantEvents(snapshots).at(-1)?.todos ?? [];
}

export type TaskPlanTranslator = (
  key: string,
  values?: Record<string, number>,
) => string;
