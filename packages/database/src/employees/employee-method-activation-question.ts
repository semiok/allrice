import {
  UserQuestionRequestSchema,
  UserQuestionItemSchema,
  UserQuestionAnswerSubmissionSchema,
  RuntimeNativeInputProofSchema,
  methodActivationQuestionPrefix,
  methodActivationApprove,
  UuidSchema,
} from '@allrice/contracts';
import type { ContentTx } from './employee-content-model.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  readNativeQuestion,
  nativeQuestionAnswerAdopted,
} from '../native-questions.ts';

export class EmployeeMethodActivationError extends Error {
  constructor(
    readonly code:
      | 'activation_question_invalid'
      | 'activation_answer_pending'
      | 'activation_declined'
      | 'activation_expired'
      | 'activation_test_coverage',
  ) {
    super(code);
  }
}

/** The lease-checked native event transaction is the sole presentation path.
 * Ordinary questions are untouched; reserved IDs cannot hide a rewritten body. */
export async function recordEmployeeMethodActivationQuestion(
  tx: ContentTx,
  job: { id: string; run_id: string; attempt: number },
  payload: unknown,
) {
  const event = payload as {
    source?: string;
    sourceEventType?: string;
    nativePayload?: unknown;
  } | null;
  if (
    event?.source !== 'dsh' ||
    event.sourceEventType !== 'session/user-question'
  )
    return;
  const native = event.nativePayload as
    { questions?: { id?: unknown }[] } | undefined;
  if (
    !Array.isArray(native?.questions) ||
    !native.questions.some(
      (q) =>
        typeof q.id === 'string' &&
        q.id.startsWith(methodActivationQuestionPrefix),
    )
  )
    return;
  const parsed = UserQuestionRequestSchema.safeParse(native);
  const fail = () => {
    throw new EmployeeMethodActivationError('activation_question_invalid');
  };
  if (!parsed.success || parsed.data.questions.length !== 1) return fail();
  const request = parsed.data,
    question = request.questions[0]!;
  const id = UuidSchema.safeParse(
    question.id.slice(methodActivationQuestionPrefix.length),
  );
  if (!id.success) return fail();
  const [receipt] =
    await tx`select * from allrice_employee_method_activations where id=${id.data} for update`;
  if (
    !receipt ||
    receipt.source_run_id !== job.run_id ||
    receipt.source_job_id !== job.id ||
    receipt.consumed_at ||
    receipt.expires_at <= new Date() ||
    runtimePolicyDigest(UserQuestionItemSchema.parse(receipt.question)) !==
      runtimePolicyDigest(question)
  )
    return fail();
  if (receipt.presented_at) {
    if (receipt.question_id !== request.questionId) return fail();
    return;
  }
  if (receipt.source_attempt !== job.attempt) return fail();
  const [runtime] =
    await tx`select active_turn_id,thread_generation from allrice_conversation_runtimes
    where session_id=${receipt.session_id} and active_run_id=${job.run_id} and state='running'`;
  if (!runtime?.active_turn_id) return fail();
  await tx`update allrice_employee_method_activations
    set question_id=${request.questionId},question_turn_id=${runtime.active_turn_id},question_generation=${runtime.thread_generation},presented_at=clock_timestamp()
    where id=${id.data}`;
}

export async function requireEmployeeMethodActivationAnswer(
  tx: ContentTx,
  r: {
    id: string;
    organization_id: string;
    workspace_id: string;
    owner_id: string;
    session_id: string;
    source_run_id: string;
    question: unknown;
    question_id: string | null;
    question_turn_id: string | null;
    question_generation: number | null;
    presented_at: Date | null;
  },
) {
  if (!r.presented_at || !r.question_id)
    throw new EmployeeMethodActivationError('activation_answer_pending');
  const answers =
    await tx`select m.id,m.content,c.client_user_message_id,c.native_proof,c.expected_turn_id,c.expected_generation
    from allrice_chat_input_requests i
    join allrice_messages m on m.id=i.user_message_id and m.role='user'
    join allrice_conversation_commands c on c.organization_id=i.organization_id and c.workspace_id=i.workspace_id
      and c.session_id=i.session_id and c.owner_id=i.owner_id and c.client_user_message_id=i.client_message_id
    where i.organization_id=${r.organization_id} and i.workspace_id=${r.workspace_id} and i.owner_id=${r.owner_id}
      and i.session_id=${r.session_id} and i.kind='ask_user' and c.input_kind='ask_user' and c.state='consumed'
      and m.organization_id=i.organization_id and m.workspace_id=i.workspace_id and m.session_id=i.session_id and m.owner_id=i.owner_id
      and m.content->'interaction'->>'type'='user_question_answer'
      and m.content->'interaction'->'answer'->>'questionId'=${r.question_id}
      and m.created_at>=${r.presented_at}
    order by m.created_at,m.id`;
  for (const row of answers) {
    const proof = RuntimeNativeInputProofSchema.safeParse(row.native_proof);
    if (
      !proof.success ||
      proof.data.status !== 'adopted' ||
      proof.data.inputId !== row.client_user_message_id ||
      proof.data.messageId !== r.question_id
    )
      continue;
    const answer = UserQuestionAnswerSubmissionSchema.parse(
      row.content.interaction.answer,
    );
    const native = await readNativeQuestion(tx, r.session_id, r.question_id);
    if (
      native
        ? native.source_run_id !== r.source_run_id ||
          runtimePolicyDigest(native.questions) !==
            runtimePolicyDigest([UserQuestionItemSchema.parse(r.question)]) ||
          !(await nativeQuestionAnswerAdopted(
            tx,
            r.session_id,
            r.question_id,
            proof.data,
            answer,
          ))
        : r.question_id.startsWith(`dsh-${r.session_id}:`) ||
          proof.data.checkpoint !== 'question_resolved' ||
          row.expected_turn_id !== r.question_turn_id ||
          row.expected_generation !== r.question_generation ||
          proof.data.turnId !== r.question_turn_id
    )
      continue;
    const item = answer.answers[0];
    // Exact structured affirmative only. Quotes, conditionals, extra items,
    // conflicting free text and a generic 'OK' confer no publication authority.
    if (
      answer.answers.length !== 1 ||
      item?.id !== methodActivationQuestionPrefix + r.id ||
      !(
        (item.selected.length === 1 &&
          item.selected[0] === methodActivationApprove &&
          !item.custom) ||
        (!item.selected.length && item.custom === methodActivationApprove)
      )
    )
      throw new EmployeeMethodActivationError('activation_declined');
    const [newInput] =
      await tx`select id from allrice_messages where session_id=${r.session_id}
      and owner_id=${r.owner_id} and role='user' and id<>${row.id}
      and created_at>(select created_at from allrice_messages where id=${row.id}) limit 1`;
    if (newInput)
      throw new EmployeeMethodActivationError('activation_declined');
    return row.id as string;
  }
  throw new EmployeeMethodActivationError('activation_answer_pending');
}
