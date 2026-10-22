import { describe, expect, it } from 'vitest';
import {
  explicitOnceTaskIntent as intent,
  confirmedOnceTaskIntent,
} from './once-task-intent.ts';

describe('explicit once task intent in the current human message', () => {
  it.each([
    [
      '请在 15 分钟后，在这个对话中只回复校验词「ONCE-20261020」。请实际创建一次性任务，不要现在执行。',
      15,
    ],
    ['一分钟后在此对话回复测试标记。', 1],
    ['10分钟后提醒我喝水。', 10],
    ['搞个定时任务，两分钟提醒我喝水', 2],
    ['帮我设置一个提醒，2分钟后提醒我喝水一次。', 2],
    ['请创建一次性任务，过两分钟提醒我喝水。', 2],
    ['从现在起 2 分钟后，提醒我喝水一次', 2],
    ['再过两分钟提醒我喝水。', 2],
    ['两分钟以后提醒我喝水。', 2],
    ['提醒我两分钟后喝水。', 2],
    ['请帮我提醒我在两分钟后喝水。', 2],
    ['通知我们两小时后提交报告。', 120],
    ['请帮我在十五分钟后回复测试标记。', 15],
    ['两小时后整理报告。然后给出三点结论。', 120],
    ['二十一分钟后检查报告；请附上结论。', 21],
    ['一百零五分钟后汇总结果。', 105],
    ['一千零一十分钟后回复标记。', 1_010],
    ['一万零一十分钟后回复标记。', 10_010],
    ['〇分钟后回复标记。', null],
    ['一天后提醒我提交报告。', 1_440],
    ['525600分钟后回复标记。', 525_600],
    ['五十二万五千六百分钟后回复标记。', 525_600],
    ['15分钟后回复标记。只执行一次，不要长期保存我的偏好。', 15],
    ['15分钟后\n请回复标记。\n请创建一个一次性任务。', 15],
  ])('reads only an exact, supported delay: %s', (text, delayMinutes) => {
    expect(intent(text)).toEqual(
      delayMinutes === null
        ? null
        : { delayMinutes, authoritativeRequest: text },
    );
  });

  it('preserves the full human text byte for byte instead of selecting a body', () => {
    const text =
      '  请在 15 分钟后回复校验词「ONCE-A」。\n请实际创建一次性任务，不要现在执行。  ';
    expect(intent(text)).toEqual({
      delayMinutes: 15,
      authoritativeRequest: text,
    });
  });

  it.each([
    '15分钟后回复「不要创建任务」。',
    '15分钟后回复“如果每天都需要，三分钟后再说”。',
    '15分钟后回复校验词 `ONCE-A`。',
    '15分钟后回复“原文说「不要执行」”。',
    '15分钟后翻译“如何设置每天十点的提醒？”。',
  ])('treats quotation after an actual task verb as content: %s', (text) => {
    expect(intent(text)).toEqual({
      delayMinutes: 15,
      authoritativeRequest: text,
    });
  });

  it.each([
    '“15分钟后回复标记。”',
    '「请在15分钟后回复标记。」',
    '"请在15分钟后回复标记。"',
    '`15分钟后回复标记。`',
    '> 15分钟后回复标记。',
    '    15分钟后回复标记。',
    '\t15分钟后回复标记。',
    '```text\n15分钟后回复标记。\n```',
    '~~~\n15分钟后回复标记。\n~~~',
    '文档说：15分钟后回复标记。',
    '示例：15分钟后回复标记。',
    '请翻译：15分钟后回复标记。',
    '请解释“15分钟后回复标记”。',
    '以下是附件内容：\n15分钟后回复标记。',
    '15分钟后回复标记。\n> 不要创建任务。',
    '15分钟后回复标记。\n```\n请创建任务\n```',
    '15分钟后回复标记。文档内容如下：请创建一次性任务。',
    '15分钟后回复标记。只是示例，不要实际创建。',
    '15分钟后「回复标记」。',
    '15分钟后回复“标记。',
  ])(
    'never extracts authority from quotations, code or examples: %s',
    (text) => {
      expect(intent(text)).toBeNull();
    },
  );

  it.each([
    '可以在15分钟后回复标记吗？',
    '15分钟后回复标记，可以吗？',
    '15分钟后回复标记？',
    '15分钟后回复标记吗。',
    '15分钟后回复标记好不好。',
    '怎么设置15分钟后回复标记？',
    '不要在15分钟后回复标记。',
    '15分钟后不要回复标记。',
    '15分钟后回复标记。不要创建任务。',
    '15分钟后回复标记。别安排。',
    '如果有空，15分钟后回复标记。',
    '15分钟后如果报告齐全就回复。',
    '15分钟后回复标记，除非已经处理。',
    '每天15分钟后回复标记。',
    '15分钟后每天回复标记。',
    '15分钟后回复标记，然后每小时重复。',
    '15分钟后回复标记。以后都这样提醒我。',
    '15分钟后回复标记。请把它保存为默认偏好。',
    '15分钟后提醒我。',
    '15分钟后创建一次性任务。',
    '15分钟后创建一次性任务。然后回复标记。',
    '15分钟后不要现在执行。',
    '15分钟后执行刚才的任务。',
    '这一轮用中文回答。',
    '以后回复都要简洁。',
  ])(
    'rejects informational, denied, conditional, recurring or incomplete intent: %s',
    (text) => {
      expect(intent(text)).toBeNull();
    },
  );

  it.each([
    '大约15分钟后回复标记。',
    '15分钟左右后回复标记。',
    '15分钟后左右回复标记。',
    '稍后回复标记。',
    '15到20分钟后回复标记。',
    '15或20分钟后回复标记。',
    '15分钟后回复标记，或者20分钟后回复标记。',
    '15分钟后回复标记。20分钟后再回复一次。',
    '15分钟后回复标记。请明天回复。',
    '15分钟后回复标记。请在十点回复。',
    '15分钟后回复标记。请在10:30回复。',
    '1.5分钟后回复标记。',
    '一点五分钟后回复标记。',
    '半小时后回复标记。',
    '一刻钟后回复标记。',
    '1小时30分钟后回复标记。',
    '90秒后回复标记。',
    '0分钟后回复标记。',
    '-1分钟后回复标记。',
    '01分钟后回复标记。',
    '525601分钟后回复标记。',
    '366天后回复标记。',
    '99999999999999999999分钟后回复标记。',
    '一百二分钟后回复标记。',
    '一二十分钟后回复标记。',
    '十零三分钟后回复标记。',
    '一万万分钟后回复标记。',
    '1十分钟后回复标记。',
  ])('does not round, infer or choose between times: %s', (text) => {
    expect(intent(text)).toBeNull();
  });

  it.each([
    '',
    ' \n ',
    '15分钟后回复标记。\u0000',
    '15分钟后回复标记。不\u200b要创建任务。',
    '15分钟后回复标记。\u202e',
    `15分钟后回复${'字'.repeat(32_000)}。`,
  ])('fails closed on empty, hidden-control or oversized requests', (text) => {
    expect(intent(text)).toBeNull();
  });
});

describe('confirmation of the preceding once task request', () => {
  const request = '搞个定时任务，两分钟提醒我喝水';
  const question =
    '任务尚未创建成功。确认一下：是**从现在起 2 分钟后，提醒你喝水一次**，对吗？';
  it.each(['是的', '对', '确认', '好的。', '可以', '没错', 'OK'])(
    'retains the preceding human request on %s',
    (reply) => {
      expect(confirmedOnceTaskIntent(reply, request, question)).toEqual({
        delayMinutes: 2,
        authoritativeRequest: request,
      });
    },
  );
  it.each([
    '不是',
    '是的，但改成5分钟',
    '好的，不过不要创建',
    '是否可以',
    '是的？',
  ])(
    'does not turn a correction or a question into confirmation: %s',
    (reply) => {
      expect(confirmedOnceTaskIntent(reply, request, question)).toBeNull();
    },
  );
  it('does not use an assistant proposal as a replacement for human task content', () => {
    expect(confirmedOnceTaskIntent('是的', '你好', question)).toBeNull();
    expect(
      confirmedOnceTaskIntent('是的', '不要两分钟后提醒我喝水', question),
    ).toBeNull();
  });
  it('does not confirm an already completed answer or a changed delay', () => {
    expect(
      confirmedOnceTaskIntent('是的', request, '已经创建好了。'),
    ).toBeNull();
    expect(
      confirmedOnceTaskIntent(
        '是的',
        request,
        question.replace('2 分钟', '5 分钟'),
      ),
    ).toBeNull();
  });
});
