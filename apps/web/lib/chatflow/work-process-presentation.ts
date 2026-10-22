import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { ChatPresentationPolicy } from '@deepseek-ai/dsh-client-ui-chat/client';
import { turnProcessOpen } from '../../app/chatflow/dsh-upstream/presentation/stores';
import {
  currentWorkProgressEvents,
  type WorkProgressPart,
} from './work-progress';

/** Public AllRice facts needed by the native display policy, never journal authority. */
export interface WorkProcessPresentation {
  readonly runId: string;
  readonly answerGeneration: string;
  readonly identityKnown: boolean;
  readonly hasNextInput: boolean;
  readonly hasInterleavedInput: boolean;
  readonly finalReplyId?: string;
}

export interface WorkProcessDisclosure {
  readonly presentation: WorkProcessPresentation;
  readonly open: boolean;
}

/**
 * Preserve the server's answer boundary and execution generation across rendering.
 * The caller supplies accepted new-turn inputs; queue entries and same-turn
 * steering are deliberately separate facts, not inferred from submission time.
 */
export function workProcessPresentation(
  events: ChatFlowEventEnvelope[],
  parts: readonly WorkProgressPart[] | undefined,
  runId: string | null | undefined,
  hasNextInput: boolean,
  hasInterleavedInput = false,
): WorkProcessPresentation {
  const current = currentWorkProgressEvents(events);
  const latest = current.at(-1);
  const completed = current.findLast(
    (event) => event.type === 'assistant.text.completed',
  );
  const final = parts?.findLast(
    (part) =>
      part.kind === 'reply' &&
      (part.finalAnswer || ['history-reply', 'final-reply'].includes(part.id)),
  );
  const replyId =
    typeof completed?.payload.replyId === 'string'
      ? `reply:${completed.payload.replyId}`
      : undefined;
  const finalReplyId =
    final?.id ??
    (replyId && parts?.some((part) => part.id === replyId)
      ? replyId
      : undefined);
  const generation = latest?.payload.generation ?? latest?.generation ?? 0;
  const attempt =
    current.findLast((event) => typeof event.payload.attempt === 'number')
      ?.payload.attempt ?? 1;
  const turnId =
    current.findLast((event) => typeof event.payload.turnId === 'string')
      ?.payload.turnId ?? '';
  const answer =
    completed?.payload.replyId ?? completed?.sourceEvent?.payload.step ?? '';
  const id = runId ?? latest?.runId ?? 'history';
  return {
    runId: id,
    answerGeneration: JSON.stringify([id, generation, attempt, turnId, answer]),
    identityKnown: current.length > 0,
    hasNextInput,
    hasInterleavedInput,
    ...(finalReplyId ? { finalReplyId } : {}),
  };
}

/** Loading an existing trace identifies the same saved answer, not a new answer. */
export function sameWorkProcessAnswer(
  previous: WorkProcessPresentation,
  current: WorkProcessPresentation,
) {
  return (
    previous.answerGeneration === current.answerGeneration ||
    (previous.runId === current.runId && !previous.identityKnown)
  );
}

/** Bridge public lifecycle facts into DSH's original disclosure selection. */
export function workProcessDisplayState({
  policy,
  presentation,
  running,
  failed,
  canceled,
  hasHistory,
  disclosure,
}: {
  policy: ChatPresentationPolicy;
  presentation: WorkProcessPresentation;
  running: boolean;
  failed: boolean;
  canceled: boolean;
  hasHistory: boolean;
  disclosure?: WorkProcessDisclosure;
}) {
  const alwaysOpen =
    running || failed || canceled || presentation.hasInterleavedInput;
  const canFold = policy.foldCompletedTurns && !alwaysOpen && hasHistory;
  const deferCollapse =
    policy.collapseTiming === 'next-input' && !presentation.hasNextInput;
  const manual =
    disclosure && sameWorkProcessAnswer(disclosure.presentation, presentation)
      ? disclosure
      : undefined;
  const open =
    !canFold ||
    turnProcessOpen(
      {
        turnProcesses: manual
          ? [
              {
                turn: 0,
                answerStep: 0,
                ...(manual.open ? {} : { collapsed: true }),
              },
            ]
          : [],
      },
      { turn: 0, answerStep: 0 },
      deferCollapse,
    );
  return {
    canFold,
    open,
    deferCollapse,
    groupSteps:
      policy.stepGrouping === 'collapsed' ||
      (policy.stepGrouping === 'history' && !running && !deferCollapse),
  };
}
