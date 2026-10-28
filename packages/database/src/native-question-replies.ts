import {
  UserQuestionAnswerSubmissionSchema,
  type ExecutionContext,
  type RuntimeNativeInputProof,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { lockNativeQuestionOwner } from './task-native-wait.ts';
import {
  lockNativeQuestionMode,
  readNativeQuestionMode,
  readNativeQuestion,
  NativeQuestionError,
  nativeQuestionAnswerAdopted,
} from './native-questions.ts';

/** A private port for this Job's typed input, never the active-turn poller.
 * The existing followup_run_id uniquely binds command, messages and Job; every
 * operation rechecks the exact current lease and current Session authority. */
export async function prepareNativeQuestionReply(
  input: {
    context: ExecutionContext;
    worker: { jobId: string; workerId: string; leaseToken: string };
    sessionId: string;
  },
  db = getDatabase(),
) {
  const [request] = await db`select m.content->'interaction'->'answer' as answer
    from allrice_employee_runs e join allrice_messages m on m.id=e.user_message_id
    join allrice_chat_input_requests i on i.user_message_id=m.id and i.kind='ask_user'
    where e.run_id=${input.context.runId} and e.session_id=${input.sessionId}
      and e.organization_id=${input.context.organizationId} and e.workspace_id=${input.context.workspaceId!}
      and e.owner_id=${input.context.delegatedBy.id}`;
  if (!request?.answer?.questionId?.startsWith('dsh-')) return undefined;
  const answer = UserQuestionAnswerSubmissionSchema.parse(request.answer);
  const current = async (tx: Parameters<typeof lockNativeQuestionOwner>[0]) => {
    await lockNativeQuestionMode(tx);
    await lockNativeQuestionOwner(tx, input);
    const q = await readNativeQuestion(tx, input.sessionId, answer.questionId);
    if (!q || q.closed_at || (await readNativeQuestionMode(tx)) !== 'timed')
      throw new NativeQuestionError();
  };
  const command = await db.begin(async (tx) => {
    await current(tx);
    const [row] = await tx<
      { id: string; client_user_message_id: string; message: string }[]
    >`
      update allrice_conversation_commands c set state='claimed',worker_id=${input.worker.workerId},
        claimed_at=now(),error_code=null,delivery_attempts=delivery_attempts+1,
        expected_generation=cr.thread_generation,expected_turn_id=null,updated_at=now()
      from allrice_conversation_followups f,allrice_conversation_runtimes cr,allrice_employee_runs e,
        allrice_chat_input_requests i
      where c.followup_run_id=${input.context.runId} and c.input_kind='ask_user'
        and c.state in ('pending','claimed') and f.run_id=c.followup_run_id and f.mode='follow_up'
        and e.run_id=f.run_id and e.session_id=${input.sessionId} and f.session_id=e.session_id
        and i.user_message_id=e.user_message_id and i.client_message_id=c.client_user_message_id
        and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
        and cr.session_id=e.session_id and cr.active_run_id=e.run_id and cr.state='running'
        and cr.worker_id=${input.worker.workerId}
      returning c.id,c.client_user_message_id,c.message`;
    if (!row) throw new NativeQuestionError();
    return row;
  });
  return {
    inputId: command.client_user_message_id,
    text: command.message,
    assertCurrent: () => db.begin(current),
    adopted: (proof: RuntimeNativeInputProof) =>
      db.begin(async (tx) => {
        await current(tx);
        if (
          proof.status !== 'adopted' ||
          proof.inputId !== command.client_user_message_id ||
          !(await nativeQuestionAnswerAdopted(
            tx,
            input.sessionId,
            answer.questionId,
            proof,
            answer,
          ))
        )
          throw Error('QUESTION_ANSWER_NOT_ADOPTED');
        await tx`update allrice_conversation_commands set state='consumed',native_proof=${tx.json(proof)},
        expected_turn_id=${proof.turnId},consumed_at=now(),updated_at=now()
        where id=${command.id} and followup_run_id=${input.context.runId}
          and state='claimed' and worker_id=${input.worker.workerId}`;
      }),
    rejected: () =>
      db.begin(async (tx) => {
        await current(tx);
        await tx`update allrice_conversation_commands set state='rejected',error_code='QUESTION_ANSWER_NOT_ADOPTED',updated_at=now()
        where id=${command.id} and state='claimed' and worker_id=${input.worker.workerId}`;
      }),
  };
}
