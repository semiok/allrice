import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeDataError,
  DataAccessError,
  QueueError,
} from '@allrice/database';

import { readJson } from '../../app/chatflow/chatflow-utils';
import { bridgeErrorResponse } from '../bridge/responses';
import { executionErrorResponse } from '../execution/responses';
import { storageErrorResponse } from '../storage/responses';

/** What the person reads for a response produced by the real route helper. */
const shown = (response: Response) =>
  readJson<never>(response).then(
    () => 'no error',
    (error: Error) => error.message,
  );

describe('request failures read the API error code before the status', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { assign: vi.fn() } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['device_offline', '电脑未连接，请打开 AllRice 电脑端后再试'],
    [
      'command_unavailable',
      '电脑端暂时做不了这一步。请确认 AllRice 电脑端已打开并更新到最新版本、文件夹已授权，再试一次',
    ],
    [
      'grant_missing',
      '电脑端暂时做不了这一步。请确认 AllRice 电脑端已打开并更新到最新版本、文件夹已授权，再试一次',
    ],
    ['result_too_large', '电脑上的文件太大，请换小一点的文件'],
    ['pairing_invalid', '配对码无效或已过期，请重新生成配对码'],
    ['lease_lost', '内容已被修改，请刷新后再试'],
  ] as const)('computer: %s', async (code, text) => {
    expect(await shown(bridgeErrorResponse(new BridgeDataError(code)))).toBe(
      text,
    );
  });

  it.each([
    ['quota_exceeded', '空间已用完，请删除不用的文件或联系管理员'],
    ['grant_invalid', '链接无效或已失效，请刷新页面后再试'],
    ['not_found', '内容不存在或已删除'],
    ['authorization_denied', '没有权限，如需使用请联系管理员'],
  ] as const)('storage: %s', async (code, text) => {
    expect(await shown(storageErrorResponse(new DataAccessError(code)))).toBe(
      text,
    );
  });

  it('asks for a page refresh when the request came from a stale page', async () => {
    expect(
      await shown(Response.json({ code: 'ORIGIN_DENIED' }, { status: 403 })),
    ).toBe('请刷新页面后再试');
  });

  it('asks for a refresh when the run event cursor is no longer valid', async () => {
    expect(
      await shown(executionErrorResponse(new QueueError('cursor_invalid'))),
    ).toBe('内容已更新，请刷新页面后再试');
  });

  it('keeps the maintenance notice the server wrote in Chinese', async () => {
    expect(
      await shown(
        Response.json(
          {
            error: {
              code: 'DEPENDENCY_UNAVAILABLE',
              message: '系统正在维护，请稍后重试。',
            },
          },
          { status: 503 },
        ),
      ),
    ).toBe('系统正在维护，请稍后重试。');
  });
});
