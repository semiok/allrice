import type { NativeQuestionCheckpoint } from '@allrice/contracts';
import type { ExecutionFailureUsage } from './execution-failure-usage.js';

export class NativeQuestionParked extends Error {
  persisted = false;
  constructor(
    readonly checkpoint: NativeQuestionCheckpoint,
    readonly receipt: ExecutionFailureUsage,
  ) {
    super('native_question_parked');
  }
}
