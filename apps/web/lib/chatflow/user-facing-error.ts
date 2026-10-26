/**
 * Only a plain Error carries words written for people (the server's message
 * or ours). Subclasses are technical: SyntaxError from a body that is not
 * JSON, ZodError from a schema check, TypeError from a failed fetch. Those go
 * to the console and the person sees the fallback.
 */
export function userFacingMessage(cause: unknown, fallback: string) {
  if (
    cause instanceof Error &&
    Object.getPrototypeOf(cause) === Error.prototype &&
    cause.message
  )
    return cause.message;
  console.error(cause);
  return fallback;
}
