import {
  EmployeeExecutionSnapshotSchema,
  EmployeePromptSnapshotSchema,
  HarnessExecutionSnapshotSchema,
  DshNativeSkillSnapshotSchema,
  FrozenEmployeeSkillBindingSchema,
  UserQuestionAnswerSubmissionSchema,
  matchUserQuestionAnswer,
  type ExecutionContext,
  type RuntimeNativeInputProof,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import type { TransactionSql } from 'postgres';
import type { EnqueueOptions } from './execution/queue.ts';
import type { ExperienceRunScope } from './experience-runtime.ts';
import { readEmployeeRuntimeContent } from './employees/employee-runtime-content.ts';
import {
  assertPersonalSkillsReadable,
  assertFrozenPersonalSkills,
} from './employees/personal-skills.ts';
import { runtimePolicyDigest } from './runtime-policy-digest.ts';
import { lockNativeQuestionOwner } from './task-native-wait.ts';
import {
  lockNativeQuestionMode,
  readNativeQuestionMode,
  readNativeQuestion,
  NativeQuestionError,
  nativeQuestionAnswerAdopted,
} from './native-questions.ts';

type ReplyOwner = {
  context: ExecutionContext;
  worker: { jobId: string; workerId: string; leaseToken: string };
  sessionId: string;
};

async function replyRequest(
  input: ReplyOwner,
  db: ReturnType<typeof getDatabase>,
) {
  const [request] = await db`select m.content->'interaction'->'answer' as answer
    from allrice_employee_runs e join allrice_messages m on m.id=e.user_message_id
    join allrice_chat_input_requests i on i.user_message_id=m.id and i.kind='ask_user'
    where e.run_id=${input.context.runId} and e.session_id=${input.sessionId}
      and e.organization_id=${input.context.organizationId} and e.workspace_id=${input.context.workspaceId!}
      and e.owner_id=${input.context.delegatedBy.id}`;
  if (!request?.answer?.questionId?.startsWith('dsh-')) return undefined;
  return UserQuestionAnswerSubmissionSchema.parse(request.answer);
}

async function currentQuestion(
  tx: Parameters<typeof lockNativeQuestionOwner>[0],
  input: ReplyOwner,
  questionId: string,
) {
  await lockNativeQuestionMode(tx);
  await lockNativeQuestionOwner(tx, input);
  const q = await readNativeQuestion(tx, input.sessionId, questionId);
  if (!q || q.closed_at || (await readNativeQuestionMode(tx)) !== 'timed')
    throw new NativeQuestionError();
  return q;
}

/** Called only after the ordinary current-configuration admission checks. Copy
 * immutable execution inputs into the new Run; current ownership/policy, Job
 * identity, lease and accounting are still issued by the normal queue. */
export async function restoreNativeQuestionRunBinding(
  tx: TransactionSql,
  scope: Omit<ExperienceRunScope, 'runId'>,
  questionId: string,
  current: NonNullable<EnqueueOptions['employeeBinding']>,
) {
  const q = await readNativeQuestion(tx, scope.sessionId, questionId);
  if (!q || q.closed_at || (await readNativeQuestionMode(tx)) !== 'timed')
    throw new NativeQuestionError();
  const [source] = await tx`select e.* from allrice_employee_runs e
    where e.run_id=${q.source_run_id} and e.session_id=${scope.sessionId}
      and e.organization_id=${scope.organizationId} and e.workspace_id=${scope.workspaceId} and e.owner_id=${scope.ownerId}`;
  const snapshot = EmployeeExecutionSnapshotSchema.parse(
    source?.execution_snapshot,
  );
  if (
    snapshot.schemaVersion !== 2 ||
    snapshot.workflowInvocation ||
    source!.employee_assignment_id !== current.employeeAssignmentId ||
    snapshot.employee.id !== current.executionSnapshot.employee.id ||
    snapshot.instance?.id !== current.executionSnapshot.instance?.id
  )
    throw new NativeQuestionError();
  const identity = {
    actor: { type: 'user' as const, id: scope.ownerId },
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
  };
  if (snapshot.content)
    await readEmployeeRuntimeContent(
      identity,
      snapshot.content,
      tx,
      undefined,
      true,
    );
  const nativeSkills = DshNativeSkillSnapshotSchema.array().parse(
    source!.native_skills,
  );
  if (snapshot.personalSkills) {
    assertFrozenPersonalSkills(
      snapshot.personalSkills,
      nativeSkills,
      snapshot.instance?.id,
    );
    await assertPersonalSkillsReadable(identity, snapshot.personalSkills, tx);
  }
  return {
    ...current,
    employeeVersionId: source!.employee_version_id as string,
    providerSnapshot: HarnessExecutionSnapshotSchema.parse(
      source!.provider_snapshot,
    ),
    nativeSkills,
    skillBindings: FrozenEmployeeSkillBindingSchema.array().parse(
      source!.skill_bindings,
    ),
    skillVersionIds: snapshot.capabilitySnapshot.bindings.skillVersionIds,
    promptSnapshot: EmployeePromptSnapshotSchema.parse(source!.prompt_snapshot),
    executionSnapshot: snapshot,
  };
}

/** A historical handle is valid only through this admitted typed input's exact
 * question and native binding. Callers independently hold current Run authority. */
export async function nativeQuestionReplySourceRunId(
  tx: TransactionSql,
  scope: ExperienceRunScope,
) {
  const [row] =
    await tx`select m.content->'interaction'->'answer' answer,c.message
    from allrice_employee_runs e join allrice_messages m on m.id=e.user_message_id
    join allrice_chat_input_requests i on i.user_message_id=m.id and i.kind='ask_user'
    join allrice_conversation_commands c on c.followup_run_id=e.run_id and c.client_user_message_id=i.client_message_id
      and c.input_kind='ask_user' and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
    where e.run_id=${scope.runId} and e.session_id=${scope.sessionId} and c.session_id=e.session_id
      and e.organization_id=${scope.organizationId} and e.workspace_id=${scope.workspaceId} and e.owner_id=${scope.ownerId}`;
  if (!row?.answer?.questionId?.startsWith('dsh-')) return undefined;
  const answer = UserQuestionAnswerSubmissionSchema.safeParse(row.answer);
  if (
    !answer.success ||
    row.message !== `allrice:user-question:v1:${JSON.stringify(answer.data)}`
  )
    throw new NativeQuestionError();
  const q = await readNativeQuestion(
    tx,
    scope.sessionId,
    answer.data.questionId,
  );
  if (!q || q.closed_at || (await readNativeQuestionMode(tx)) !== 'timed')
    throw new NativeQuestionError();
  return q.source_run_id as string;
}

/** Read-only preparation after Job start, before ordinary content selection.
 * Exact binding + current lease authorize the source context, never its prefix.
 * The actual command claim remains after acquiring the current runtime. */
export async function readNativeQuestionReplyContext(
  input: ReplyOwner,
  db = getDatabase(),
) {
  const answer = await replyRequest(input, db);
  if (!answer) return undefined;
  return db.begin(async (tx) => {
    const q = await currentQuestion(tx, input, answer.questionId);
    const [source] = await tx<
      { content_generation_id: string | null }[]
    >`select content_generation_id
      from allrice_employee_runs where run_id=${q.source_run_id} and session_id=${input.sessionId}
      and organization_id=${input.context.organizationId} and workspace_id=${input.context.workspaceId!}
      and owner_id=${input.context.delegatedBy.id}`;
    if (!source) throw new NativeQuestionError();
    const generationId = source.content_generation_id;
    const nativeSessionId = q.native_session_id as string;
    const nativeContextKey = generationId
      ? nativeSessionId.slice(`dsh-${input.sessionId}-`.length)
      : undefined;
    if (
      generationId &&
      (nativeSessionId !== `dsh-${input.sessionId}-${nativeContextKey}` ||
        (nativeContextKey !== generationId &&
          !nativeContextKey?.startsWith(`${generationId}-`)))
    )
      throw new NativeQuestionError();
    return {
      sourceRunId: q.source_run_id as string,
      generationId,
      nativeContextKey,
    };
  });
}

/** A private port for this Job's typed input, never the active-turn poller.
 * Existing command + followup identities also scope terminal receipt recovery. */
export async function prepareNativeQuestionReply(
  input: ReplyOwner,
  db = getDatabase(),
) {
  const answer = await replyRequest(input, db);
  if (!answer) return undefined;
  const current = async (tx: Parameters<typeof lockNativeQuestionOwner>[0]) => {
    const q = await currentQuestion(tx, input, answer.questionId);
    const [runtime] =
      await tx`select session_id from allrice_conversation_runtimes
      where session_id=${input.sessionId} and active_run_id=${input.context.runId}
        and worker_id=${input.worker.workerId} and state='running'`;
    if (!runtime) throw new NativeQuestionError();
    return q;
  };
  const rejectedAnswer = (
    q: NonNullable<Awaited<ReturnType<typeof readNativeQuestion>>>,
  ) => {
    const matched = matchUserQuestionAnswer(
      { questionId: answer.questionId, questions: q.questions },
      answer,
    );
    return (
      q.state === 'settled' &&
      matched &&
      runtimePolicyDigest(matched.answers) !== runtimePolicyDigest(q.answers)
    );
  };
  const command = await db.begin(async (tx) => {
    const q = await current(tx);
    const [row] = await tx<
      {
        id: string;
        client_user_message_id: string;
        message: string;
        state: string;
        error_code: string | null;
        native_proof: RuntimeNativeInputProof | null;
      }[]
    >`select c.id,c.client_user_message_id,c.message,c.state,c.error_code,c.native_proof
      from allrice_conversation_commands c
      join allrice_conversation_followups f on f.run_id=c.followup_run_id and f.mode='follow_up'
      join allrice_employee_runs e on e.run_id=f.run_id and e.session_id=f.session_id
      join allrice_chat_input_requests i on i.user_message_id=e.user_message_id and i.client_message_id=c.client_user_message_id
      join allrice_conversation_runtimes cr on cr.session_id=e.session_id and cr.active_run_id=e.run_id
      where c.followup_run_id=${input.context.runId} and c.input_kind='ask_user'
        and c.state in ('pending','claimed','consumed','rejected') and e.session_id=${input.sessionId}
        and c.organization_id=e.organization_id and c.workspace_id=e.workspace_id and c.owner_id=e.owner_id
        and cr.state='running' and cr.worker_id=${input.worker.workerId} for update of c`;
    if (
      !row ||
      row.message !== `allrice:user-question:v1:${JSON.stringify(answer)}`
    )
      throw new NativeQuestionError();
    let receipt: 'adopted' | 'rejected' | undefined;
    if (row.state === 'consumed') {
      if (
        row.native_proof?.inputId !== row.client_user_message_id ||
        !(await nativeQuestionAnswerAdopted(
          tx,
          input.sessionId,
          answer.questionId,
          row.native_proof,
          answer,
        ))
      )
        throw new NativeQuestionError();
      receipt = 'adopted';
    } else if (row.state === 'rejected') {
      if (
        row.error_code !== 'QUESTION_ANSWER_NOT_ADOPTED' ||
        !rejectedAnswer(q)
      )
        throw new NativeQuestionError();
      receipt = 'rejected';
    } else {
      await tx`update allrice_conversation_commands c set state='claimed',worker_id=${input.worker.workerId},
        claimed_at=now(),error_code=null,delivery_attempts=delivery_attempts+1,
        expected_generation=cr.thread_generation,expected_turn_id=null,updated_at=now()
        from allrice_conversation_runtimes cr where c.id=${row.id} and cr.session_id=${input.sessionId}`;
    }
    return { ...row, receipt };
  });
  return {
    inputId: command.client_user_message_id,
    text: command.message,
    receipt: command.receipt,
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
        const q = await current(tx);
        if (!rejectedAnswer(q)) throw new NativeQuestionError();
        await tx`update allrice_conversation_commands set state='rejected',error_code='QUESTION_ANSWER_NOT_ADOPTED',updated_at=now()
        where id=${command.id} and state='claimed' and worker_id=${input.worker.workerId}`;
      }),
  };
}
