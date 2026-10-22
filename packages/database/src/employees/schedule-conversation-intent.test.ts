import { describe, expect, it } from 'vitest';
import { explicitOnceTaskIntent } from './once-task-intent.ts';
import { explicitRecurringTaskIntent } from './recurring-task-intent.ts';

describe('only the current explicit scheduling instruction selects a conversation mode', () => {
  it.each([
    '每隔两分钟回复核对结果',
    '每天02:30:17，时区America/New_York，汇总报表',
    '每周一、三02:30:17，时区America/New_York，汇总报表',
    '每月31日02:30:17，时区America/New_York，汇总报表',
  ])('binds both choices to a complete recurring request: %s', (request) => {
    expect(explicitRecurringTaskIntent(request)).not.toHaveProperty(
      'conversationMode',
    );
    for (const [clause, mode] of [
      ['每次新建聊天', 'new_each_run'],
      ['沿用来源聊天', 'reuse'],
    ] as const)
      expect(
        explicitRecurringTaskIntent(`${request}；${clause}`),
      ).toMatchObject({
        authoritativeRequest: `${request}；${clause}`,
        conversationMode: mode,
      });
  });
  it('also freezes a one-time create selection without granting later editing', () => {
    expect(explicitOnceTaskIntent('2分钟后回复核对结果；每次新建聊天')).toEqual(
      {
        delayMinutes: 2,
        authoritativeRequest: '2分钟后回复核对结果；每次新建聊天',
        conversationMode: 'new_each_run',
      },
    );
    expect(explicitOnceTaskIntent('2分钟后回复核对结果')).not.toHaveProperty(
      'conversationMode',
    );
  });
  it.each([
    '“每月31日02:30 UTC回复好；每次新建聊天”',
    '每月31日02:30 UTC回复“每次新建聊天”',
    '如果需要，每月31日02:30 UTC回复好；每次新建聊天',
    '不要每月31日02:30 UTC回复好；每次新建聊天',
    '每月31日02:30 UTC回复好；上次我说过每次新建聊天',
    '每月31日02:30 UTC回复好；如果可以每次新建聊天',
    '每次新建聊天',
    '刚才的任务照旧，每次新建聊天',
  ])(
    'cannot obtain new_each_run from quote/condition/negation/history/chitchat: %s',
    (text) => {
      expect(explicitRecurringTaskIntent(text)?.conversationMode).not.toBe(
        'new_each_run',
      );
      expect(explicitOnceTaskIntent(text)?.conversationMode).not.toBe(
        'new_each_run',
      );
    },
  );
});
