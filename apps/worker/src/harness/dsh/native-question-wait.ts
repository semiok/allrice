import type { NativeQuestionCheckpoint } from '@allrice/contracts';
import type { AssistantFailureUsage } from './assistant-outcome.js';

export class NativeQuestionParked extends Error {
  persisted = false;
  constructor(
    readonly checkpoint: NativeQuestionCheckpoint,
    readonly receipt: AssistantFailureUsage,
  ) {
    super('native_question_parked');
  }
}
