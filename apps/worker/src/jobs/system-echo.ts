import { HandlerError } from '../errors.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';

function objectInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

async function delayWithAbort(milliseconds: number, signal: AbortSignal) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (signal.aborted) {
      throw new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200, Math.max(1, end - Date.now()))),
    );
  }
}

export async function executeSystemEcho({
  execution,
  signal,
}: ClaimedJobHandlerInput) {
  if (execution.payload.type !== 'allrice.system.echo') {
    throw new HandlerError(
      'UNSUPPORTED_JOB_TYPE',
      `Echo handler cannot execute ${execution.payload.type}`,
      false,
    );
  }

  const input = objectInput(execution.payload.input);
  const delayMs = boundedInteger(input.delayMs, 0, 0, 30_000);
  const failUntilAttempt = boundedInteger(input.failUntilAttempt, 0, 0, 10);
  await delayWithAbort(delayMs, signal);
  if (execution.job.attempt <= failUntilAttempt) {
    throw new HandlerError(
      'ECHO_RETRY_REQUESTED',
      'The echo acceptance handler requested a retry',
      true,
    );
  }
  return {
    echo: Object.hasOwn(input, 'value') ? input.value : execution.payload.input,
    attempt: execution.job.attempt,
    isolated: true,
  };
}
