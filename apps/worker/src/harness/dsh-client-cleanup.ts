import { HandlerError } from '../errors.js';

/** These callers exclusively own one client. Await its existing close contract;
 * never replace an operation failure with a cleanup failure or turn uncertain
 * cleanup into a normal result. This helper does not prove persistence/retirement. */
interface OwnedDshClient {
  close(): Promise<void>;
}

export class DshClientCleanupError extends AggregateError {
  readonly code = 'DSH_CLIENT_CLEANUP_UNCONFIRMED';

  constructor(closeError: unknown, operationFailure?: { error: unknown }) {
    super(
      operationFailure ? [operationFailure.error, closeError] : [closeError],
      'DSH owned client cleanup remains unconfirmed',
    );
    this.name = 'DshClientCleanupError';
  }
}

export async function closeDshClientAfterFailure(
  client: OwnedDshClient,
  operationError: unknown,
): Promise<never> {
  try {
    await client.close();
  } catch (closeError) {
    throw new DshClientCleanupError(closeError, { error: operationError });
  }
  throw operationError;
}

export async function withDshClient<T>(
  client: OwnedDshClient,
  operation: () => Promise<T>,
): Promise<T> {
  let value: T;
  try {
    value = await operation();
  } catch (operationError) {
    return closeDshClientAfterFailure(client, operationError);
  }
  try {
    await client.close();
  } catch (closeError) {
    throw new DshClientCleanupError(closeError);
  }
  return value;
}

// Trusted in-process diagnostics. Non-retryable errors keep their identity,
// including frozen errors. A retryable HandlerError keeps its classification
// but cannot replay while cleanup is unconfirmed; the caller binds usage to the
// returned error. These records do not acknowledge shutdown or grant retirement.
const cleanupFailures = new WeakMap<object, readonly unknown[]>();

export function retainDshCleanupFailure(
  operationError: unknown,
  closeError: unknown,
): unknown {
  const primary =
    operationError instanceof HandlerError && operationError.retryable
      ? new HandlerError(operationError.code, operationError.message, false, {
          cause: operationError,
        })
      : operationError;
  if (
    (typeof primary !== 'object' || primary === null) &&
    typeof primary !== 'function'
  )
    return new DshClientCleanupError(closeError, { error: operationError });
  const failure = primary as object;
  cleanupFailures.set(failure, [
    ...(cleanupFailures.get(failure) ?? []),
    closeError,
  ]);
  // Make the separate close failure visible to existing Error.cause readers
  // when possible, without overwriting a pre-existing cause or frozen object.
  if (failure instanceof Error && !('cause' in failure)) {
    try {
      Object.defineProperty(failure, 'cause', {
        value: closeError,
        configurable: true,
      });
    } catch {
      // Frozen exceptions retain the same trusted record via the WeakMap.
    }
  }
  return primary;
}

export function getDshCleanupFailures(error: unknown): readonly unknown[] {
  if (
    (typeof error !== 'object' || error === null) &&
    typeof error !== 'function'
  )
    return [];
  return [...(cleanupFailures.get(error as object) ?? [])];
}
