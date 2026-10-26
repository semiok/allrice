import { requestFailureMessage } from './request-failure';

// One rule for every request failure (request-failure.ts): Chinese server
// copy for people first, then the error code, then the status.
const writtenForPeople = (value: unknown): value is string =>
  typeof value === 'string' && /[\u3400-\u9fff]/.test(value);

/** An Error for a rejected response, from `{error:{code,message}}` or `{message}`. */
export function responseError(status: number, body: unknown) {
  const value = body as {
    code?: unknown;
    error?: { code?: unknown; message?: unknown } | string;
    message?: unknown;
  } | null;
  const nested =
    value && typeof value.error === 'object' ? value.error : undefined;
  return new Error(
    requestFailureMessage({
      status,
      code: nested?.code ?? value?.code,
      message: nested?.message ?? value?.message,
    }),
  );
}

/**
 * The message of a plain Error written in Chinese is shown as is. Everything
 * else (English API wording, SyntaxError from a body that is not JSON,
 * ZodError, a failed fetch) goes to the console and the person sees the fallback.
 */
export function userFacingMessage(cause: unknown, fallback: string) {
  if (
    cause instanceof Error &&
    cause.name === 'Error' &&
    writtenForPeople(cause.message)
  )
    return cause.message;
  console.error(cause);
  return fallback;
}
