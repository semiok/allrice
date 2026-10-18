import { z } from 'zod';

// AllRice owns the exact private payload contract. Released native vocabulary
// remains upstream-owned; no unknown required event becomes ignorable.
const text = z.string().min(1);
const inputId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const turnId = text.regex(/:turn:[1-9][0-9]*$/);
const question = z
  .object({
    id: text,
    question: text,
    header: z.string().optional(),
    detail: z.string().optional(),
    options: z
      .array(
        z.object({ label: text, description: z.string().optional() }).strict(),
      )
      .optional(),
    multiSelect: z.boolean().optional(),
    intent: z
      .object({ kind: z.literal('plan-review'), approve: text })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (q) =>
      !q.intent ||
      (typeof q.detail === 'string' &&
        q.options?.some((o) => o.label === q.intent.approve)),
  );
const privatePayloads = {
  'allrice/wait/checkpoint': z
    .object({
      sessionId: text,
      questionId: text,
      turnId,
      questions: z.array(question).min(1),
    })
    .strict()
    .refine((p) => p.turnId.startsWith(p.sessionId + ':turn:')),
  'allrice/input/request': z
    .object({
      inputId,
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      messageId: text,
      turnId,
    })
    .strict(),
  'allrice/input/answered': z
    .object({ inputId, questionId: text, turnId })
    .strict(),
  'allrice/wait/continued': z.object({ questionId: text, inputId }).strict(),
};

const privateTypes = new Set([
  'allrice/wait/checkpoint',
  'allrice/wait/continued',
  'allrice/input/request',
  'allrice/input/answered',
]);

/** Validate private facts against the migrated chronology before opening a writer.
 * Digests remain opaque commitments until the exact typed input is presented;
 * deliverDshInput compares that input's digest before returning adoption proof.
 */
export function validateAllriceSessionJournal(header, events) {
  const requests = new Map();
  const answers = new Map();
  const checkpoints = new Map();
  const continued = new Set();
  let turn;
  const invalid = () => {
    throw new Error('ALLRICE_SESSION_PRIVATE_FACTS_INVALID');
  };
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (!privateTypes.has(event.type)) continue;
    privatePayloads[event.type].parse(event.data);
    const data = event.data;
    // Seeded child histories require a separately reviewed migration path.
    // Never attribute an inherited root question to the child reading it.
    if (header.isSeeded || header.parentSession) invalid();
    if (
      data.turnId !== undefined &&
      data.turnId !== `${header.id}:turn:${turn}`
    )
      invalid();
    switch (event.type) {
      case 'allrice/wait/checkpoint':
        if (data.sessionId !== header.id || checkpoints.has(data.questionId))
          invalid();
        if (
          new Set(data.questions.map((q) => q.id)).size !==
          data.questions.length
        )
          invalid();
        checkpoints.set(data.questionId, data);
        break;
      case 'allrice/input/request':
        if (requests.has(data.inputId)) invalid();
        requests.set(data.inputId, data);
        break;
      case 'allrice/input/answered': {
        const request = requests.get(data.inputId);
        if (
          !request ||
          answers.has(data.inputId) ||
          request.turnId !== data.turnId ||
          request.messageId !== data.questionId
        )
          invalid();
        answers.set(data.inputId, data);
        break;
      }
      case 'allrice/wait/continued': {
        const answer = answers.get(data.inputId);
        const checkpoint = checkpoints.get(data.questionId);
        if (
          !checkpoint ||
          !answer ||
          continued.has(data.questionId) ||
          answer.questionId !== data.questionId ||
          answer.turnId !== checkpoint.turnId
        )
          invalid();
        continued.add(data.questionId);
        break;
      }
    }
  }
}

/** A read handle can prepare a migration but cannot publish a new generation. */
export async function readStoredDshSession(ctx, sessionId) {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read');
  try {
    const { events } = await handle.read();
    validateAllriceSessionJournal(handle.header, events);
    return { header: handle.header, events };
  } finally {
    await handle.close();
  }
}
