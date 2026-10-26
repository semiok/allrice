import { describe, expect, it } from 'vitest';
import type { BrowserWorkspaceView } from '@allrice/database';
import {
  approvalErrorMessage,
  browserActionSummary,
  browserOperationStatusLabel,
  browserStateLabel,
  shortDateTime,
  siteLabel,
} from './browser-workspace-presenter';

type Operation = BrowserWorkspaceView['operations'][number];
const operation = (
  status: string,
  extra: Partial<Record<keyof Operation, unknown>> = {},
) =>
  ({
    snapshot: { status },
    approval: null,
    available: true,
    ...extra,
  }) as unknown as Operation;
const approval = (extra: Record<string, unknown> = {}) => ({
  request: { expiresAt: '2099-01-01T00:00:00.000Z' },
  response: null,
  revokedAt: null,
  ...extra,
});

describe('browser panel wording', () => {
  const elements = [
    {
      id: 'e1',
      tag: 'button',
      label: '提交订单',
      inputType: '',
      sensitive: false,
    },
    {
      id: 'e2',
      tag: 'input',
      label: '姓名',
      inputType: 'text',
      sensitive: false,
    },
  ] as never;

  it('says exactly what an approval would allow', () => {
    expect(
      browserActionSummary(
        { type: 'click', elementId: 'e1' },
        'Rice',
        elements,
      ),
    ).toBe('点击「提交订单」按钮');
    expect(
      browserActionSummary(
        { type: 'fill', elementId: 'e2', value: '张三' },
        'Rice',
        elements,
      ),
    ).toBe('在「姓名」输入框填写「张三」');
    // An element the current observation no longer describes stays generic.
    expect(
      browserActionSummary({ type: 'click', elementId: 'e9' }, 'Rice'),
    ).toBe('点击页面上的按钮或链接');
    const request = (method: string) =>
      browserActionSummary(
        {
          type: 'request',
          method,
          url: 'https://shop.example.com/account',
        } as never,
        'Rice',
      );
    expect(request('DELETE')).toBe('删除 shop.example.com/account 上的内容');
    expect(request('POST')).toBe('向 shop.example.com/account 提交内容');
    expect(request('PATCH')).toBe('修改 shop.example.com/account 上的内容');
  });

  it('never shows the internal address of a local preview', () => {
    expect(
      siteLabel(
        'https://p-11111111-1111-4111-8111-111111111111.preview.allrice.invalid/',
      ),
    ).toBe('你的项目预览');
    expect(
      browserActionSummary(
        {
          type: 'navigate',
          url: 'https://p-11111111-1111-4111-8111-111111111111.preview.allrice.invalid/',
        },
        'Rice',
      ),
    ).toBe('打开 你的项目预览');
  });

  it('folds the approval answer and validity into the step state', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z');
    expect(
      browserOperationStatusLabel(operation('waiting_user'), 'Rice', now),
    ).toBe('等你确认');
    expect(
      browserOperationStatusLabel(
        operation('waiting_user', {
          approval: approval({ response: { decision: 'rejected' } }),
        }),
        'Rice',
        now,
      ),
    ).toBe('你已拒绝，没有执行');
    expect(
      browserOperationStatusLabel(
        operation('waiting_user', {
          approval: approval({
            request: { expiresAt: '2026-10-25T00:00:00.000Z' },
          }),
        }),
        'Rice',
        now,
      ),
    ).toBe('已过期，没有执行');
    expect(
      browserOperationStatusLabel(
        operation('waiting_user', { available: false }),
        'Rice',
        now,
      ),
    ).toBe('已失效，没有执行');
    expect(
      browserOperationStatusLabel(operation('failed'), '小红书文案专家'),
    ).toBe('未完成，可以让小红书文案专家再试一次');
    expect(browserOperationStatusLabel(operation('failed'), 'Rice')).toBe(
      '未完成，可以让 Rice 再试一次',
    );
  });

  it('names states without engineering terms and maps approval errors', () => {
    expect(browserStateLabel('agent', 'Rice')).toBe('Rice 正在使用浏览器');
    expect(browserStateLabel('resume_pending', 'Rice')).toBe('正在交还给 Rice');
    expect(browserStateLabel('something-new', 'Rice')).toBe(
      '状态待确认，请刷新状态查看',
    );
    // A stale answer may have run before the response was lost.
    expect(
      approvalErrorMessage('approval_invalid_or_stale', 'Rice'),
    ).not.toContain('没有执行');
    expect(approvalErrorMessage('approval_response_mismatch', 'Rice')).toBe(
      '这一步的答复没有被接受，可能已经过期。请刷新状态查看。',
    );
    expect(approvalErrorMessage(undefined, 'Rice')).toBe(
      '答复可能没有送达。可以再点一次，不会重复执行。',
    );
  });

  it('formats times as 「11 月 1 日 09:00」 and adds the year only when it differs', () => {
    const now = new Date(2026, 9, 26, 12);
    expect(shortDateTime(new Date(2026, 10, 1, 9, 5).toISOString(), now)).toBe(
      '11 月 1 日 09:05',
    );
    expect(shortDateTime(new Date(2025, 0, 2, 18).toISOString(), now)).toBe(
      '2025 年 1 月 2 日 18:00',
    );
    expect(shortDateTime('not a date', now)).toBe('');
  });
});
