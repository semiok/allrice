import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { requestNotFinished } from './request-failure';
import { responseError, userFacingMessage } from './user-facing-error';

afterEach(() => vi.restoreAllMocks());

describe('errors shown to people', () => {
  it('reads the real API error shapes through the shared rule (request-failure.ts)', () => {
    // apps/web/lib/bridge/responses.ts and api-error-response.ts
    expect(
      responseError(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Rice Bridge request failed',
          retryable: false,
        },
      }).message,
    ).toBe('服务暂时不可用，请稍后刷新页面再试');
    expect(
      responseError(401, {
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
        },
      }).message,
    ).toBe('登录已过期，请重新登录');
    expect(
      responseError(404, {
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Bridge resource not found',
        },
      }).message,
    ).toBe('内容不存在或已删除');
    // Scheduled-task routes: {error: code, message: Chinese copy}.
    expect(
      responseError(409, {
        error: 'binding_conflict',
        message: '任务状态已变化，请重新读取。',
      }).message,
    ).toBe('任务状态已变化，请重新读取。');
    // The computer settings' usual failure: the paired computer is asleep.
    expect(
      responseError(503, {
        error: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Bridge device is offline',
          retryable: true,
        },
      }).message,
    ).toBe('电脑未连接，请打开 AllRice 助手后再试');
    expect(responseError(400, null).message).toBe(requestNotFinished);
    expect(
      responseError(429, { error: { message: 'Too many requests' } }).message,
    ).toBe('操作太频繁，请稍后再试');
  });

  it('shows only Chinese words and sends everything else to the console', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      userFacingMessage(new Error('任务状态已变化，请重新读取。'), 'x'),
    ).toBe('任务状态已变化，请重新读取。');
    let schema: unknown;
    try {
      z.object({ tasks: z.array(z.string().min(1, '请填写')) }).parse({
        tasks: [''],
      });
    } catch (cause) {
      schema = cause;
    }
    let json: unknown;
    try {
      JSON.parse('<html>');
    } catch (cause) {
      json = cause;
    }
    for (const cause of [
      new Error('Access denied'),
      new Error('request persistence unconfirmed'),
      schema,
      json,
      new TypeError('Failed to fetch'),
      'boom',
    ])
      expect(userFacingMessage(cause, '暂时读不到自动化任务')).toBe(
        '暂时读不到自动化任务',
      );
    expect(log).toHaveBeenCalledTimes(6);
  });
});
