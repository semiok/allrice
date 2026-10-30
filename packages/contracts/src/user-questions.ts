import { z } from 'zod';

export const UserQuestionOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const UserQuestionItemSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    question: z.string().trim().min(1).max(4_000),
    detail: z.string().trim().min(1).max(20_000).optional(),
    header: z.string().trim().min(1).max(160).optional(),
    options: z.array(UserQuestionOptionSchema).max(20).optional(),
    multiSelect: z.boolean().default(false),
    intent: z
      .object({
        kind: z.literal('plan-review'),
        approve: z.string().trim().min(1).max(240),
      })
      .strict()
      .optional(),
  })
  .strict();

export const UserQuestionAnswerItemSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    selected: z.array(z.string().trim().min(1).max(240)).max(20),
    custom: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

// Native identity is lossless. Keep the existing legacy ID limit; the full
// DSH Session + call ID is not a display label and must never be truncated.
export const NativeUserQuestionIdSchema = z
  .string()
  .regex(/^dsh-[0-9a-f-]{36}(?:-[^:\s]+)?:.+$/s);
const questionIdSchema = z.union([
  NativeUserQuestionIdSchema,
  z.string().trim().min(1).max(240),
]);

export const UserQuestionRequestSchema = z
  .object({
    questionId: questionIdSchema,
    questions: z.array(UserQuestionItemSchema).min(1).max(10),
    // Trusted presentation metadata, not answer authority. Program cards may
    // have callId without a durable tool question in DSH's projection.
    nativeSessionId: z.string().min(1).optional(),
    callId: z.string().min(1).optional(),
    durable: z.boolean().optional(),
    // Host-authored provenance; answer submissions never carry this authority.
    progress: z
      .object({
        runId: z.string().uuid().optional(),
        pauseId: z.string().min(1).max(240),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (request) =>
      !request.durable ||
      (!!request.nativeSessionId &&
        !!request.callId &&
        request.questionId === `${request.nativeSessionId}:${request.callId}`),
    'Native question identity must match its Session and call ID',
  );

export const UserQuestionAnswerSubmissionSchema = z
  .object({
    questionId: questionIdSchema,
    answers: z.array(UserQuestionAnswerItemSchema).min(1).max(10),
  })
  .strict();

type AnsweredQuestions = {
  questionId: string;
  questions: readonly {
    id: string;
    multiSelect?: boolean;
    options?: readonly { label: string }[];
  }[];
};

/** The one AllRice check of an answer batch against its questions (MET-210),
 * matching DSH: each question answered exactly once, and a skipped item
 * ({ id, selected: [] }) is an answer. Labels must be the question's options;
 * a single-select question takes at most one label and never a label plus
 * custom text. Returns the answers in question order, or null. */
export function matchUserQuestionAnswer(
  request: AnsweredQuestions,
  submission: unknown,
): { answers: z.infer<typeof UserQuestionAnswerItemSchema>[] } | null {
  const parsed = UserQuestionAnswerSubmissionSchema.safeParse(submission);
  if (
    !parsed.success ||
    parsed.data.questionId !== request.questionId ||
    parsed.data.answers.length !== request.questions.length
  )
    return null;
  const byId = new Map(parsed.data.answers.map((a) => [a.id, a]));
  if (byId.size !== parsed.data.answers.length) return null;
  const answers = [];
  for (const question of request.questions) {
    const answer = byId.get(question.id);
    const labels = new Set((question.options ?? []).map((o) => o.label));
    if (
      !answer ||
      new Set(answer.selected).size !== answer.selected.length ||
      answer.selected.some((label) => !labels.has(label)) ||
      (!question.multiSelect &&
        (answer.selected.length > 1 ||
          (answer.selected.length > 0 && !!answer.custom)))
    )
      return null;
    answers.push({
      id: question.id,
      selected: [...answer.selected],
      ...(answer.custom ? { custom: answer.custom } : {}),
    });
  }
  return { answers };
}

export type UserQuestionItem = z.infer<typeof UserQuestionItemSchema>;
export type UserQuestionRequest = z.infer<typeof UserQuestionRequestSchema>;
export type UserQuestionAnswerSubmission = z.infer<
  typeof UserQuestionAnswerSubmissionSchema
>;
