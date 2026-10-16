import {
  SandboxControlFailureSchema,
  type SandboxControlFailure,
} from '@allrice/contracts';
import {
  BridgeClientError,
  type BridgeRequestInput,
  bridgeRequest,
} from './client.js';
import { localExecutionRequestTimeoutMs } from './local-execution-timing.js';

type Stage = SandboxControlFailure['stage'];
const transportCodes = SandboxControlFailureSchema.shape.transportCode.unwrap();

export class BridgeControlError extends Error {
  constructor(readonly failure: SandboxControlFailure) {
    super(
      `BRIDGE_CONTROL_${failure.stage.toUpperCase()}_${failure.kind.toUpperCase()}`,
    );
  }
}

export function controlFailure(
  error: unknown,
  stage: Stage,
  elapsedMs = 0,
  attempts = 1,
): SandboxControlFailure {
  if (error instanceof BridgeControlError) return error.failure;
  const e = error instanceof Error ? error : undefined;
  if (e?.cause instanceof BridgeControlError) return e.cause.failure;
  const cause = e?.cause as { code?: unknown } | undefined;
  const code = transportCodes.safeParse(
    cause?.code ?? (e as { code?: unknown })?.code,
  );
  const message = e?.message;
  const kind: SandboxControlFailure['kind'] =
    e instanceof BridgeClientError
      ? 'rejected'
      : message === 'SANDBOX_EXECUTION_DEADLINE'
        ? 'deadline'
        : e?.name === 'TimeoutError' ||
            message === 'DAEMON_TIMEOUT' ||
            message === 'EXECUTION_CONTROL_TIMEOUT'
          ? 'timeout'
          : e?.name === 'AbortError'
            ? 'canceled'
            : code.success
              ? 'transport'
              : message === 'EXECUTION_REVOKED' ||
                  message === 'SANDBOX_NETWORK_REVOKED'
                ? 'revoked'
                : message === 'SANDBOX_EXECUTION_PROCESS_CHANGED'
                  ? 'process_changed'
                  : stage === 'metrics'
                    ? 'metrics_invalid'
                    : e?.name === 'ZodError' ||
                        e instanceof SyntaxError ||
                        message === 'SANDBOX_EXECUTION_POLICY_CHANGED' ||
                        message === 'INVALID_DAEMON_RESPONSE'
                      ? 'invalid_response'
                      : stage === 'output'
                        ? 'persistence'
                        : 'internal';
  return SandboxControlFailureSchema.parse({
    version: 1,
    stage,
    kind,
    occurredAt: Date.now(),
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    attempts,
    ...(e instanceof BridgeClientError && e.status >= 100 && e.status <= 599
      ? { httpStatus: e.status }
      : {}),
    ...(code.success ? { transportCode: code.data } : {}),
  });
}

export function firstControlFailure(
  ...failures: (SandboxControlFailure | undefined)[]
) {
  return failures
    .filter((f): f is SandboxControlFailure => !!f)
    .sort((a, b) => a.occurredAt - b.occurredAt)[0];
}

/** An HTTP retry is allowed only for these idempotent control/evidence routes.
 * A single shared deadline includes both attempts and the response body. This
 * never retries /start, /next, a tool command, or an external service request. */
export class BridgeControlRequests {
  failure?: SandboxControlFailure;
  constructor(
    private readonly request = bridgeRequest,
    private readonly attempt?: { operationId: string; attemptId: string },
  ) {}

  capture(error: unknown, stage: Stage, elapsedMs = 0, attempts = 1) {
    const failure = controlFailure(error, stage, elapsedMs, attempts);
    if (!this.failure) {
      this.failure = failure;
      console.warn(
        JSON.stringify({
          event: 'bridge.control_failure',
          ...this.attempt,
          ...failure,
        }),
      );
    }
    return new BridgeControlError(failure);
  }

  withFailure<
    T extends {
      reason: string;
      exitCode: number;
      controlFailure?: SandboxControlFailure;
    },
  >(result: T): T {
    const failure = firstControlFailure(result.controlFailure, this.failure);
    return failure && !(result.reason === 'exited' && result.exitCode === 0)
      ? { ...result, controlFailure: failure }
      : result;
  }

  validate<T>(stage: Stage, parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      throw this.capture(error, stage);
    }
  }

  async send<T>(
    stage: 'heartbeat' | 'budget' | 'network_admission' | 'output',
    input: BridgeRequestInput,
  ): Promise<T> {
    const suffix = stage === 'network_admission' ? 'network' : stage;
    if (
      input.method !== 'POST' ||
      !new RegExp(
        `^/api/v1/bridge/device/operations/[a-f0-9-]{36}/${suffix}$`,
      ).test(input.path)
    )
      throw this.capture(Error('INVALID_CONTROL_ROUTE'), stage);
    const started = performance.now();
    const timeoutMs = input.timeoutMs ?? localExecutionRequestTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    // Freeze exact renewal identity/progress and evidence bytes across attempts.
    const body =
      input.body === undefined ? undefined : structuredClone(input.body);
    for (let attempts = 1; attempts <= 2; attempts++) {
      try {
        signal.throwIfAborted();
        const remaining = Math.max(
          1,
          Math.ceil(timeoutMs - (performance.now() - started)),
        );
        const value = await abortable(
          this.request<T>({ ...input, body, signal, timeoutMs: remaining }),
          signal,
        );
        signal.throwIfAborted();
        return value;
      } catch (error) {
        const effective = input.signal?.aborted
          ? new DOMException('Control request canceled', 'AbortError')
          : signal.aborted
            ? signal.reason
            : error;
        const failure = controlFailure(
          effective,
          stage,
          performance.now() - started,
          attempts,
        );
        // Fast transport failure only. No retries for HTTP policy rejection,
        // malformed replies, cancellation, or an exhausted request deadline.
        if (
          attempts === 1 &&
          failure.kind === 'transport' &&
          !signal.aborted &&
          performance.now() - started < timeoutMs
        )
          continue;
        throw this.capture(new BridgeControlError(failure), stage);
      }
    }
    throw this.capture(Error('CONTROL_ATTEMPTS_EXHAUSTED'), stage);
  }
}

async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let reject!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, r) => {
    reject = r;
  });
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
