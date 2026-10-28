import type { HarnessExecutionInput } from '../adapter.js';
import type { DshProtocolClient } from '../dsh-protocol-client.js';
import { HandlerError } from '../../errors.js';

/** Drive this Job's command through native receipts, without a turn poller or
 * prompt. Only a native discarded event resubmits the exact original command;
 * REPLY_QUEUED simply awaits DSH's settled projection and persisted adoption. */
export async function driveNativeQuestionReply(input: {
  client: DshProtocolClient;
  sessionId: string;
  reply: NonNullable<HarnessExecutionInput['questionReply']>;
  signal: AbortSignal;
  flushEvents(): Promise<void>;
}) {
  const { client, sessionId, reply, signal } = input;
  if (reply.receipt) {
    await reply.assertCurrent();
    return { rejected: reply.receipt === 'rejected' };
  }
  const questionId = JSON.parse(
    reply.text.slice('allrice:user-question:v1:'.length),
  ).questionId as string;
  const callId = questionId.slice(sessionId.length + 1);
  let resolve!: (value: { rejected: boolean }) => void,
    reject!: (error: unknown) => void;
  let finished = false;
  const completion = new Promise<{ rejected: boolean }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const failed = (error: unknown) => {
    if (!finished) {
      finished = true;
      reject(error);
    }
  };
  // An RPC operation barrier for one command; DSH owns its inbox and lifecycle.
  let operation = Promise.resolve();
  const submit = () => {
    operation = operation.then(async () => {
      if (finished) return;
      await reply.assertCurrent();
      try {
        const proof = await client.typedQuestionReply(sessionId, reply);
        if (proof.status !== 'adopted') return;
        await input.flushEvents();
        await reply.adopted(proof);
        finished = true;
        resolve({ rejected: false });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('QUESTION_ANSWER_NOT_ADOPTED')
        ) {
          await input.flushEvents();
          await reply.rejected();
          finished = true;
          resolve({ rejected: true });
        } else if (!(
          error instanceof HandlerError && error.code === 'DSH_REQUEST_TIMEOUT'
        ))
          throw error;
        // Lost ACK is not a refusal or permission to prompt/replay another input.
      }
    });
    void operation.catch(failed);
  };
  const unsubscribe = client.subscribe((notice) => {
    if (notice.params.sessionId !== sessionId || finished) return;
    const view = notice.params.questions as
      { settled?: { callId: string }[] } | undefined;
    if (
      (notice.method === 'session.user-question-discarded' &&
        notice.params.callId === callId) ||
      (notice.method === 'session.user-questions' &&
        view?.settled?.some((q) => q.callId === callId))
    )
      submit();
  });
  const failure = client.onFailure(() =>
    failed(
      new HandlerError(
        'DSH_EXECUTION_OUTCOME_UNKNOWN',
        '执行进程已中断，回答尚未得到采纳确认。',
        false,
      ),
    ),
  );
  const aborted = () => failed(signal.reason ?? Error('EXECUTION_ABORTED'));
  signal.addEventListener('abort', aborted, { once: true });
  try {
    if (signal.aborted) aborted();
    else submit();
    const result = await completion;
    if (!result.rejected) await client.wait(sessionId);
    await input.flushEvents();
    return result;
  } finally {
    unsubscribe();
    failure();
    signal.removeEventListener('abort', aborted);
  }
}
