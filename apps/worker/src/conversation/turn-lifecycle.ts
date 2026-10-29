import {
  bindConversationThread,
  claimConversationSteer,
  consumeConversationSteer,
  deferConversationSteer,
  recordConversationTurn,
  rejectConversationSteer,
} from '@allrice/database';

import type { HarnessAdapter } from '../harness/adapter.js';

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
}) {
  const deadline = Date.now() + 3_000;
  while (
    (input.drain ? Date.now() < deadline : input.polling()) &&
    !input.signal.aborted
  ) {
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
    if (!input.adapter.capabilities.steer || !input.adapter.steer) {
      await rejectConversationSteer({
        commandId: command.id,
        workerId: input.ownership.workerId,
        errorCode: 'HARNESS_STEER_UNSUPPORTED',
      });
      continue;
    }
    try {
      const proof = await input.adapter.steer({
        threadId: input.threadId,
        turnId: input.turnId,
        message: command.message,
        clientUserMessageId: command.clientUserMessageId,
        ...(command.inputKind ? { inputKind: command.inputKind } : {}),
      });
      if (command.inputKind && (!proof || proof.status !== 'adopted')) {
        if (proof?.status === 'unknown' || input.drain)
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
        continue;
      }
      await consumeConversationSteer({
        commandId: command.id,
        workerId: input.ownership.workerId,
        ...(proof ? { proof } : {}),
      });
    } catch (error) {
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
  }
}
