import { z } from 'zod';
import { UserQuestionRequestSchema } from './user-questions.ts';

export const NativeQuestionCheckpointSchema = UserQuestionRequestSchema.extend({
  sessionId: z.string().min(1).max(240),
  turnId: z.string().min(1).max(255),
  sequence: z.number().int().nonnegative(),
}).strict();
export type NativeQuestionCheckpoint = z.infer<
  typeof NativeQuestionCheckpointSchema
>;
