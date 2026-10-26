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
const thrown = (response: Response) =>
  readJson<never>(response).catch((e: unknown) => e as Error);

describe('readJson failures in plain words', () => {
  const assign = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('window', { location: { assign } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockClear();
  });

  it.each([
    [403, '没有权限'],
    [404, '内容不存在或已删除'],
    [409, '内容已被修改，请刷新后再试'],
    [413, '内容太大'],
    [429, '操作太频繁，请稍后再试'],
    [500, '服务暂时不可用，请稍后再试'],
    [502, '服务暂时不可用，请稍后再试'],
    [503, '服务暂时不可用，请稍后再试'],
    [504, '服务暂时不可用，请稍后再试'],
    [400, '暂时没有完成，请稍后再试'],
    [422, '暂时没有完成，请稍后再试'],
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

  it('returns JSON and keeps an empty success as null', async () => {
    await expect(readJson(Response.json({ ok: 1 }))).resolves.toEqual({
      ok: 1,
    });
    await expect(
      readJson(new Response(null, { status: 204 })),
    ).resolves.toBeNull();
  });

  it('never hands an unreadable success to the caller as data', async () => {
    const error = await thrown(
      new Response('<html>Gateway</html>', { status: 200 }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('结果待确认，请刷新页面查看');
  });
});
