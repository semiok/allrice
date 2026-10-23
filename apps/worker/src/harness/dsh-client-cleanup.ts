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
