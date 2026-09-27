export class HandlerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

// Only the executing handler can confirm a failed attempt before publication.
// Bind the receipt to the exact invocation; error codes or serialized/model
// content alone cannot settle a write whose outcome is unknown.
type ToolFailureIdentity = { runId: string; callId: string; toolName: string };
const knownToolFailures = new WeakMap<object, ToolFailureIdentity>();
export function confirmToolFailure(error: object, call: ToolFailureIdentity) {
  knownToolFailures.set(error, { ...call });
}
export function isConfirmedToolFailure(
  error: unknown,
  call: ToolFailureIdentity,
) {
  if (typeof error !== 'object' || error === null) return false;
  const receipt = knownToolFailures.get(error);
  return (
    !!receipt &&
    receipt.runId === call.runId &&
    receipt.callId === call.callId &&
    receipt.toolName === call.toolName
  );
}
