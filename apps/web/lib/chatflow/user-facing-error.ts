// Same rule as readJson in chatflow-utils: a server message is shown only when
// it is written in Chinese for people; anything else gets words for its status.
const statusMessages: Record<number, string> = {
  401: '登录已过期，请重新登录',
  403: '没有权限，如需使用请联系管理员',
  404: '内容不存在或已删除',
  409: '内容已被修改，请刷新后再试',
  413: '内容太大，请减少内容或换小一点的文件',
  429: '操作太频繁，请稍后再试',
};
const writtenForPeople = (value: unknown): value is string =>
  typeof value === 'string' && /[\u3400-\u9fff]/.test(value);

/** Plain words for a failed request: Chinese server copy, never a code or status. */
export function requestFailureMessage(status: number, serverMessage?: unknown) {
  if (writtenForPeople(serverMessage)) return serverMessage;
  return (
    statusMessages[status] ??
    (status >= 500
      ? '服务暂时不可用，请稍后刷新页面再试'
      : '未完成，请稍后再试')
  );
}

/** An Error for a rejected response, from `{error:{code,message}}` or `{message}`. */
export function responseError(status: number, body: unknown) {
  const value = body as {
    error?: { message?: unknown } | string;
    message?: unknown;
  } | null;
  const nested =
    value && typeof value.error === 'object' ? value.error.message : undefined;
  return new Error(requestFailureMessage(status, nested ?? value?.message));
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
