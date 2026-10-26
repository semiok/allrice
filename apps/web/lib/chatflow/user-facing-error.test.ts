import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { userFacingMessage } from './user-facing-error';

afterEach(() => vi.restoreAllMocks());

describe('errors shown to people', () => {
  it('shows words written for people and sends technical errors to the console', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      userFacingMessage(new Error('任务状态已变化，请重新读取。'), 'x'),
    ).toBe('任务状态已变化，请重新读取。');
    let schema: unknown;
    try {
      z.object({ tasks: z.array(z.string()) }).parse({});
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
      schema,
      json,
      new TypeError('Failed to fetch'),
      'boom',
    ])
      expect(userFacingMessage(cause, '暂时读不到自动化任务')).toBe(
        '暂时读不到自动化任务',
      );
    expect(log).toHaveBeenCalledTimes(4);
  });
});
