import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from './chatflow-utils';

const failure = (status: number, body: unknown = null) =>
  new Response(
    body === null
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body),
    { status },
  );
const thrown = (response: Response, options?: { read?: boolean }) =>
  readJson<never>(response, options).catch((e: unknown) => e as Error);
/** A 200 whose body stops halfway with `reason`. */
function brokenBody(reason: unknown) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"history":'));
        queueMicrotask(() => controller.error(reason));
      },
    }),
  );
}

describe('readJson failures in plain words', () => {
  const assign = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('window', { location: { assign } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockClear();
  });

  const notFinished =
    '这次操作未完成。请刷新页面后重新操作；仍不行请联系管理员。';
  it.each([
    [403, '没有权限，如需使用请联系管理员'],
    [404, '内容不存在或已删除'],
    [409, '内容已被修改，请刷新后再试'],
    [413, '内容太大，请减少内容或换小一点的文件'],
    [429, '操作太频繁，请稍后再试'],
    [500, '服务暂时不可用，请稍后刷新页面再试'],
    [502, '服务暂时不可用，请稍后刷新页面再试'],
    [503, '服务暂时不可用，请稍后刷新页面再试'],
    [504, '服务暂时不可用，请稍后刷新页面再试'],
    [400, notFinished],
    [422, notFinished],
  ])(
    'says what happened for %i without the status code',
    async (status, text) => {
      for (const body of [
        null,
        { error: { code: 'X', message: 'Request validation failed' } },
        '<html><body>Bad Gateway</body></html>',
      ]) {
        const error = await thrown(failure(status, body));
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(text);
        expect(error.message).not.toMatch(/\d{3}|[A-Za-z]/);
      }
    },
  );

  it('keeps a Chinese message the server wrote for people', async () => {
    const message = '任务正在更新执行状态，本次修改未生效。请稍后重试。';
    await expect(
      readJson(failure(409, { error: { code: 'CONFLICT', message } })),
    ).rejects.toThrow(message);
  });

  it('ignores a message that is not text', async () => {
    await expect(
      readJson(failure(404, { error: { message: { detail: 'gone' } } })),
    ).rejects.toThrow('内容不存在或已删除');
  });

  it('sends an expired login back to the login page', async () => {
    await expect(
      readJson(failure(401, { error: { message: 'Authentication required' } })),
    ).rejects.toThrow('登录已过期，请重新登录');
    expect(assign).toHaveBeenCalledWith('/login?next=/chatflow');
  });

  it('returns JSON, and null only for a response without content', async () => {
    await expect(readJson(Response.json({ ok: 1 }))).resolves.toEqual({
      ok: 1,
    });
    for (const status of [204, 205])
      await expect(
        readJson(new Response(null, { status })),
      ).resolves.toBeNull();
  });

  it.each([
    ['an empty body', ''],
    ['JSON null', 'null'],
    ['a gateway page', '<html>Gateway</html>'],
  ])('never hands %s of a success to the caller as data', async (_, body) => {
    const write = await thrown(new Response(body, { status: 200 }));
    expect(write.message).toBe('结果待确认，请刷新页面查看');
    const read = await thrown(new Response(body, { status: 200 }), {
      read: true,
    });
    expect(read.message).toBe('暂时读不到内容，请刷新页面');
  });

  it('keeps a cancellation halfway through the body a cancellation', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const error = await thrown(brokenBody(abort));
    expect(error.name).toBe('AbortError');
  });

  it('treats a body cut off by the network as an unknown result', async () => {
    const error = await thrown(brokenBody(new TypeError('network error')));
    expect(error.message).toBe('结果待确认，请刷新页面查看');
  });
});
