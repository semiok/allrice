import {
  bindConversationThread,
  claimConversationSteer,
  consumeConversationSteer,
  deferConversationSteer,
  recordConversationTurn,
  rejectConversationSteer,
} from '@allrice/database';
import type { RuntimeNativeInputProof } from '@allrice/contracts';

import type {
  HarnessAdapter,
  HarnessInputDeliveryHold,
} from '../harness/adapter.js';
import { HandlerError } from '../errors.js';

export function isAssistantCompleting(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === 'ASSISTANT_COMPLETING' ||
    (code === undefined &&
      error instanceof Error &&
      error.message === 'ASSISTANT_COMPLETING')
  );
}

function isQuestionDetaching(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as Error & { code?: string }).code === 'QUESTION_DETACHING' ||
      error.message === 'QUESTION_DETACHING')
  );
}

function isSessionQuestion(message: string, sessionId: string) {
  try {
    return (
      JSON.parse(message.slice(message.indexOf('{'))).questionId?.startsWith(
        `dsh-${sessionId}:`,
      ) === true
    );
  } catch {
    return false;
  }
}

/** One existing poller's operation barrier, not an input queue or a scheduler. */
export function createConversationInputDelivery(input: {
  threadId: string;
  turnId: string;
  signal: AbortSignal;
  deadlineAt: number;
  isCurrent(): boolean;
  handoff(): Promise<void>;
}) {
  let active = false,
    closed = false,
    handingOff = false;
  let held: object | undefined;
  const idle = new Set<() => void>();
  const current = () => !closed && !input.signal.aborted && input.isCurrent();
  const assertCurrent = () => {
    if (
      !current() ||
      !Number.isFinite(input.deadlineAt) ||
      Date.now() >= input.deadlineAt
    )
      throw new HandlerError(
        'INPUT_GATE_SCOPE_CHANGED',
        'INPUT_GATE_SCOPE_CHANGED',
        false,
      );
  };
  const waitIdle = () =>
    active
      ? new Promise<void>((resolve) => idle.add(resolve))
      : Promise.resolve();
  const withinLifetime = async (work: Promise<void>) => {
    assertCurrent();
    let timer: NodeJS.Timeout | undefined, aborted!: () => void;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          aborted = () =>
            reject(
              new HandlerError(
                'INPUT_GATE_SCOPE_CHANGED',
                'INPUT_GATE_SCOPE_CHANGED',
                false,
              ),
            );
          input.signal.addEventListener('abort', aborted, { once: true });
          timer = setTimeout(
            aborted,
            Math.min(input.deadlineAt - Date.now(), 2_147_483_647),
          );
          if (input.signal.aborted) aborted();
        }),
      ]);
      assertCurrent();
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', aborted);
    }
  };
  const stop = () => {
    closed = true;
    held = undefined;
    handingOff = false;
  };
  input.signal.addEventListener('abort', stop, { once: true });
  return {
    current,
    paused: () => held !== undefined,
    enter(scope: { threadId: string; turnId: string; handoff?: boolean }) {
      if (scope.threadId !== input.threadId || scope.turnId !== input.turnId)
        return undefined;
      if (!current() || held || active || (handingOff && !scope.handoff))
        return undefined;
      active = true;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        active = false;
        for (const resolve of idle) resolve();
        idle.clear();
      };
    },
    pause(scope: {
      threadId: string;
      turnId: string;
    }): HarnessInputDeliveryHold {
      assertCurrent();
      if (
        scope.threadId !== input.threadId ||
        scope.turnId !== input.turnId ||
        held
      )
        throw new HandlerError(
          'INPUT_GATE_SCOPE_CHANGED',
          'INPUT_GATE_SCOPE_CHANGED',
          false,
        );
      const token = {};
      held = token; // synchronous, including a claim which has not returned yet
      const settled = withinLifetime(waitIdle());
      settled.catch(() => {});
      const dispose = () => {
        if (held === token) held = undefined;
      };
      let resumed: Promise<void> | undefined;
      return {
        settled,
        current: () =>
          held === token &&
          current() &&
          Number.isFinite(input.deadlineAt) &&
          Date.now() < input.deadlineAt,
        dispose,
        resumeBeforeTurnClose: () =>
          (resumed ??= (async () => {
            dispose();
            handingOff = true;
            try {
              assertCurrent();
              await withinLifetime(waitIdle());
              await withinLifetime(input.handoff());
              await withinLifetime(waitIdle());
            } finally {
              handingOff = false;
            }
          })()),
      };
    },
    dispose() {
      stop();
      input.signal.removeEventListener('abort', stop);
    },
  };
}

export interface ConversationOwnership {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  workerId: string;
}

export type ConversationRuntimeBinding = Awaited<
  ReturnType<typeof bindConversationThread>
>;

export type AppendConversationLifecycleEvent = (
  type:
    | 'session.bound'
    | 'turn.started'
    | 'turn.completed'
    | 'turn.failed'
    | 'turn.canceled'
    | 'routing.selected',
  payload: Record<string, unknown>,
) => Promise<unknown>;

export async function bindEmployeeConversationThread(input: {
  ownership: ConversationOwnership;
  adapterKind: HarnessAdapter['kind'];
  threadId: string;
  resumed: boolean;
  replacedThreadId: string | null;
  appendEvent: AppendConversationLifecycleEvent;
}) {
  const runtime = await bindConversationThread({
    ...input.ownership,
    threadId: input.threadId,
  });
  await input.appendEvent('session.bound', {
    source: input.adapterKind,
    threadId: input.threadId,
    generation: runtime.generation,
    resumed: input.resumed,
    replacedThreadId: input.replacedThreadId,
  });
  return runtime;
}

export async function beginEmployeeConversationTurn(input: {
  ownership: ConversationOwnership;
  adapterKind: HarnessAdapter['kind'];
  threadId: string;
  turnId: string;
  appendEvent: AppendConversationLifecycleEvent;
}) {
  const runtime = await recordConversationTurn({
    ...input.ownership,
    threadId: input.threadId,
    turnId: input.turnId,
  });
  await input.appendEvent('turn.started', {
    source: input.adapterKind,
    threadId: input.threadId,
    turnId: input.turnId,
    generation: runtime.generation,
  });
  return runtime;
}

export async function pollEmployeeConversationSteers(input: {
  ownership: ConversationOwnership;
  generation: number;
  threadId: string;
  turnId: string;
  signal: AbortSignal;
  adapter: HarnessAdapter;
  polling: () => boolean;
  drain?: boolean;
  /** Same live turn only; pending native insertion is deferred, never rejected. */
  handoff?: boolean;
  delivery?: ReturnType<typeof createConversationInputDelivery>;
}) {
  const deadline = Date.now() + 3_000;
  while (
    (input.drain ? Date.now() < deadline : input.polling()) &&
    !input.signal.aborted
  ) {
    const operation = input.delivery?.enter(input);
    if (input.delivery && !operation) {
      if (input.drain || !input.delivery.current()) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    try {
      const command = await claimConversationSteer({
        organizationId: input.ownership.organizationId,
        workspaceId: input.ownership.workspaceId,
        sessionId: input.ownership.sessionId,
        workerId: input.ownership.workerId,
        generation: input.generation,
        turnId: input.turnId,
        drain: input.drain,
      });
      if (!command) {
        if (input.drain) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      if (
        input.delivery &&
        (input.delivery.paused() || !input.delivery.current())
      ) {
        await deferConversationSteer({
          commandId: command.id,
          workerId: input.ownership.workerId,
        });
        if (!input.delivery.current()) return;
        continue;
      }
      if (!input.adapter.capabilities.steer || !input.adapter.steer) {
        await rejectConversationSteer({
          commandId: command.id,
          workerId: input.ownership.workerId,
          errorCode: 'HARNESS_STEER_UNSUPPORTED',
        });
        continue;
      }
      const nativeAnswer =
        command.inputKind === 'ask_user' &&
        isSessionQuestion(command.message, input.ownership.sessionId);
      let proof: RuntimeNativeInputProof | void = undefined;
      try {
        proof = await input.adapter.steer({
          threadId: input.threadId,
          turnId: input.turnId,
          message: command.message,
          clientUserMessageId: command.clientUserMessageId,
          ...(command.inputKind ? { inputKind: command.inputKind } : {}),
        });
        if (command.inputKind && (!proof || proof.status !== 'adopted')) {
          if (
            proof?.status === 'unknown' ||
            (input.drain && !input.handoff && command.inputKind !== 'ask_user')
          )
            await rejectConversationSteer({
              commandId: command.id,
              workerId: input.ownership.workerId,
              errorCode: 'INPUT_OUTCOME_UNKNOWN',
            });
          else
            await deferConversationSteer({
              commandId: command.id,
              workerId: input.ownership.workerId,
              ...(proof ? { proof } : {}),
            });
          if (input.handoff) return;
          continue;
        }
        await consumeConversationSteer({
          commandId: command.id,
          workerId: input.ownership.workerId,
          ...(proof ? { proof } : {}),
        });
      } catch (error) {
        if (
          nativeAnswer &&
          error instanceof Error &&
          /INPUT_TURN_CHANGED|QUESTION_ADOPTION_PENDING/.test(error.message)
        ) {
          await deferConversationSteer({
            commandId: command.id,
            workerId: input.ownership.workerId,
            ...(proof ? { proof } : {}),
          });
          if (
            error.message === 'QUESTION_ADOPTION_PENDING' &&
            !input.drain &&
            !input.handoff
          )
            continue;
          return;
        }
        // Completion rejected this command before native insertion. Retain both
        // typed and legacy inputs in the existing durable defer/readmission path.
        if (
          isAssistantCompleting(error) ||
          (command.inputKind === 'ask_user' && isQuestionDetaching(error))
        ) {
          await deferConversationSteer({
            commandId: command.id,
            workerId: input.ownership.workerId,
          });
          if (input.delivery?.paused() && !input.drain) continue;
          return;
        }
        if (
          command.inputKind &&
          !/INPUT_TURN_CHANGED|QUESTION_|INPUT_ID_CONFLICT|INVALID_TYPED_INPUT/.test(
            error instanceof Error ? error.message : '',
          )
        ) {
          await deferConversationSteer({
            commandId: command.id,
            workerId: input.ownership.workerId,
          });
          if (input.drain) return;
          continue;
        }
        await rejectConversationSteer({
          commandId: command.id,
          workerId: input.ownership.workerId,
          errorCode: 'STEER_REJECTED',
        });
        console.error('[M5] Active turn steer failed', {
          sessionId: input.ownership.sessionId,
          turnId: input.turnId,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    } finally {
      operation?.();
    }
  }
}
