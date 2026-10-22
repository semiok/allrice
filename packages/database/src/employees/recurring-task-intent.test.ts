import type { RecurringScheduleRule } from '@allrice/contracts';
import { describe, expect, it } from 'vitest';
import { explicitRecurringTaskIntent as intent } from './recurring-task-intent.ts';

const accepted: { text: string; rule: RecurringScheduleRule }[] = [
  {
    text: '请每月31日02:30:17，时区America/New_York，整理本会话报表。请分别列出金额和异常。',
    rule: {
      kind: 'monthly',
      monthDay: 31,
      time: '02:30:17',
      timezone: 'America/New_York',
    },
  },
  {
    text: '请每月31日02:30:45，时区America/New_York，整理本会话报表。',
    rule: {
      kind: 'monthly',
      monthDay: 31,
      time: '02:30:45',
      timezone: 'America/New_York',
    },
  },
  {
    text: '每月末 9:00，Asia/Shanghai，回复校验词「MONTHLY」。',
    rule: {
      kind: 'monthly',
      monthDay: 31,
      time: '09:00:00',
      timezone: 'Asia/Shanghai',
    },
  },
  {
    text: '请每周一和周三，09:30，时区Asia/Shanghai，整理报告；附上数据来源。',
    rule: {
      kind: 'weekly',
      weekdays: [1, 3],
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
    },
  },
  {
    text: '每周一09:30，时区Asia/Shanghai，回复标记。',
    rule: {
      kind: 'weekly',
      weekdays: [1],
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
    },
  },
  {
    text: '请每周一、三09:30，时区Asia/Shanghai，汇总本会话报表。请创建周期任务。',
    rule: {
      kind: 'weekly',
      weekdays: [1, 3],
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
    },
  },
  {
    text: '每星期天 1:30:05，America/New_York，回复「如果明天需要，三分钟后再说」。',
    rule: {
      kind: 'weekly',
      weekdays: [7],
      time: '01:30:05',
      timezone: 'America/New_York',
    },
  },
  {
    text: '麻烦你帮我每周日、周一09:30，时区Asia/Kathmandu，整理结果；请附上来源。',
    rule: {
      kind: 'weekly',
      weekdays: [1, 7],
      time: '09:30:00',
      timezone: 'Asia/Kathmandu',
    },
  },
  {
    text: '每 2 分钟就提醒我一次，要吃药',
    rule: { kind: 'every', seconds: 120 },
  },
  {
    text: '每两分钟就提醒我喝水。',
    rule: { kind: 'every', seconds: 120 },
  },
  {
    text: '每两分钟提醒我一次喝水。',
    rule: { kind: 'every', seconds: 120 },
  },
  {
    text: '请每隔两分钟，在当前对话中只回复校验词「RECURRING-NL-A」。请实际创建周期任务，不要现在执行。',
    rule: { kind: 'every', seconds: 120 },
  },
  {
    text: '请每隔十五分钟提醒我喝水。',
    rule: { kind: 'every', seconds: 900 },
  },
  {
    text: '每1分钟回复标记。',
    rule: { kind: 'every', seconds: 60 },
  },
  {
    text: '麻烦你帮我每两小时整理报告。然后给出三点结论。',
    rule: { kind: 'every', seconds: 7_200 },
  },
  {
    text: '请为我每隔一天汇总结果；请附上来源。',
    rule: { kind: 'every', seconds: 86_400 },
  },
  {
    text: '每一百零五分钟检查报告。',
    rule: { kind: 'every', seconds: 6_300 },
  },
  {
    text: '每一千零一十分钟回复标记。',
    rule: { kind: 'every', seconds: 60_600 },
  },
  {
    text: '每一万零一十分钟回复标记。',
    rule: { kind: 'every', seconds: 600_600 },
  },
  {
    text: '每525600分钟回复标记。',
    rule: { kind: 'every', seconds: 31_536_000 },
  },
  {
    text: '每五十二万五千六百分钟回复标记。',
    rule: { kind: 'every', seconds: 31_536_000 },
  },
  {
    text: '每8760小时回复标记。',
    rule: { kind: 'every', seconds: 31_536_000 },
  },
  {
    text: '每三百六十五天回复标记。',
    rule: { kind: 'every', seconds: 31_536_000 },
  },
  {
    text: '每隔一小时\n请在此对话回复标记。\n请创建一个周期任务。',
    rule: { kind: 'every', seconds: 3_600 },
  },
  {
    text: '请每天09:30，时区Asia/Shanghai，在这个对话中只回复校验词「RECURRING-NL-B」。请创建周期任务。',
    rule: { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
  },
  {
    text: '请每天01:30，时区America/New_York，提醒我检查报表。',
    rule: { kind: 'daily', time: '01:30:00', timezone: 'America/New_York' },
  },
  {
    text: '每日 9:30:05 时区：Asia/Kathmandu 回复标记。',
    rule: { kind: 'daily', time: '09:30:05', timezone: 'Asia/Kathmandu' },
  },
  {
    text: '每天00:00:00 UTC回复标记。',
    rule: { kind: 'daily', time: '00:00:00', timezone: 'UTC' },
  },
  {
    text: '每天23:59:59，时区Etc/UTC，汇总结果。请不要立即执行。',
    rule: { kind: 'daily', time: '23:59:59', timezone: 'Etc/UTC' },
  },
];

describe('explicit recurring intent in one complete current human message', () => {
  it.each(['分别', '逐项', '逐一', '依次'])(
    'recognizes a work action with the ordering adverb %s without rewriting the source',
    (adverb) => {
      const text = `请每隔十五分钟，整理报表。请${adverb}列出金额和异常。`;
      expect(intent(text)).toEqual({
        rule: { kind: 'every', seconds: 900 },
        authoritativeRequest: text,
      });
    },
  );
  it.each([
    '请每月31日02:30:17，时区America/New_York，整理报表。请分别列出金额，如果我确认再创建任务。',
    '请每月31日02:30:17，时区America/New_York，整理报表。请分别列出金额和异常。以后默认简洁。',
    '“请每月31日02:30:17，时区America/New_York，整理报表。请分别列出金额和异常。”',
    '请每月31日02:30:17，时区America/New_York，整理报表。请分别不要创建任务。',
  ])('keeps authorization boundaries around work adverbs: %s', (text) => {
    expect(intent(text)).toBeNull();
  });
  it.each([
    '每周一09:30整理报表。',
    '每周一09:30，时区北京时间，整理报表。',
    '每周一、一09:30，时区Asia/Shanghai，整理报表。',
    '每周一、天、日09:30，时区Asia/Shanghai，整理报表。',
    '每周一09:30，时区Asia/Shanghai，如果我确认就整理报表。',
    '每周一09:30，时区Asia/Shanghai，整理报表。不要创建任务。',
    '每周一09:30，时区Asia/Shanghai，整理报表；每周三也整理。',
    '每周一09:30，时区Asia/Shanghai，整理报表。以后默认简洁。',
    '「每周一09:30，时区Asia/Shanghai，整理报表。」',
    '示例：每周一09:30，时区Asia/Shanghai，整理报表。',
    '每周一24:00，时区Asia/Shanghai，整理报表。',
    '每周末09:30，时区Asia/Shanghai，整理报表。',
    '每月一日09:30，整理报表。',
  ])('keeps weekly authorization boundaries: %s', (text) => {
    expect(intent(text)).toBeNull();
  });
  it.each([
    '每两分钟如果我确认就提醒我喝水。',
    '每两分钟提醒我一次，如果没喝水就提醒我。',
    '每两分钟只提醒我一次。',
    '每两分钟提醒我一次，明天开始。',
    '每两分钟提醒我一次，不要创建任务。',
    '每两分钟提醒我一次，要每小时提醒我喝水。',
  ])(
    'keeps ambiguity and enrollment refusal after reminder normalization: %s',
    (text) => {
      expect(intent(text)).toBeNull();
    },
  );
  it.each(accepted)('parses the explicit rule: $text', ({ text, rule }) => {
    expect(intent(text)).toEqual({ rule, authoritativeRequest: text });
  });

  it.each(['请帮我', '请为我', '麻烦你帮我'])(
    'accepts an explicit trailing enrollment qualifier: %s',
    (prefix) => {
      const text = `请每两分钟提醒我喝水，${prefix}创建一个周期任务。`;
      expect(intent(text)).toEqual({
        rule: { kind: 'every', seconds: 120 },
        authoritativeRequest: text,
      });
    },
  );

  it('preserves original whitespace and literal bytes as the authority', () => {
    const text =
      '  请每隔两分钟，在当前对话中只回复校验词「NL-🍚-A」。\r\n请实际创建周期任务，不要现在执行。  ';
    expect(intent(text)).toEqual({
      rule: { kind: 'every', seconds: 120 },
      authoritativeRequest: text,
    });
  });

  it.each([
    '请每隔一天整理工作文档并生成报告。',
    '请每隔一天整理人才报告。',
    '请每隔一天汇总每日订单并生成报表。',
    '请每隔一天汇总每天下午的订单并生成报表。',
    '请每隔一天检查不合格记录并列出结果。',
    '请每隔一天整理若干文档并生成报告。',
    '请每隔一天检查重复订单并汇总周期报告。',
    '请每隔一天整理循环经济研究文档。',
    '请每隔一天整理每十五分钟的日志并生成报告。',
    '请每隔一天生成示例文档并附上说明。',
    '请每隔一天汇总取消订单。',
    '请每隔一天整理暂停服务的报告。',
    '请每隔一天整理不需要审批的文档并生成报告。',
    '请每隔一天检查不同人才类别的报表。',
    '请每隔一天整理假设检验文档。',
    '请每隔一天整理用户行为文档并生成报告。',
  ])('does not confuse work objects with instruction syntax: %s', (text) => {
    expect(intent(text)).toEqual({
      rule: { kind: 'every', seconds: 86_400 },
      authoritativeRequest: text,
    });
  });

  it('accepts a daily work object containing conditional or negative characters', () => {
    const text =
      '请每天09:30，时区Asia/Shanghai，整理人才报告并检查不合格记录。';
    expect(intent(text)).toEqual({
      rule: { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
      authoritativeRequest: text,
    });
  });

  it('accepts the complete daily talent-report request', () => {
    const text = '请每天09:30，时区Asia/Shanghai，整理人才报告。';
    expect(intent(text)).toEqual({
      rule: { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
      authoritativeRequest: text,
    });
  });

  it.each([
    '每两分钟回复「不要创建周期任务」。',
    '每两分钟回复“如果每天都需要，三分钟后再说”。',
    '每两分钟回复‘每天09:30，时区Europe/London’。',
    '每两分钟回复校验词 `NL-A`。',
    '每两分钟回复“原文说「不要执行」”。',
    '每两分钟翻译“如何设置每周一十点的提醒？”。',
    '每两分钟回复“2026-10-21开始，只执行三次，这是示例”。',
  ])('keeps quoted task content separate from authority: %s', (text) => {
    expect(intent(text)).toEqual({
      rule: { kind: 'every', seconds: 120 },
      authoritativeRequest: text,
    });
  });

  it.each([
    '',
    ' \n ',
    '好。',
    '确认。',
    '就按上面说的。',
    '请在十五分钟后回复标记。',
    '每分钟回复标记。',
    '每小时回复标记。',
    '定期提醒我喝水。',
    '每天九点提醒我。',
    '每天九点，时区Asia/Shanghai，提醒我喝水。',
    '每天09:30提醒我喝水。',
    '每天09:30，按本地时区提醒我喝水。',
    '每天09:30，时区北京时间，提醒我喝水。',
    '每天09:30，时区CST，提醒我喝水。',
    '每天09:30，时区+08:00，提醒我喝水。',
    '每天09:30，时区GMT+8，提醒我喝水。',
    '每天09:30，时区Not/A_Zone，提醒我喝水。',
    '每天09:30，时区Asia/Nonexistent，提醒我喝水。',
    '每天24:00，时区Asia/Shanghai，回复标记。',
    '每天09:60，时区Asia/Shanghai，回复标记。',
    '每天09:30:60，时区Asia/Shanghai，回复标记。',
    '每天09:30:05.5，时区Asia/Shanghai，回复标记。',
    '每七天的周一回复标记。',
    '每月31日提醒我提交报告。',
    '每个月提醒我提交报告。',
    'cron */5 * * * * 回复标记。',
  ])('does not infer a period, wall time or zone: %s', (text) => {
    expect(intent(text)).toBeNull();
  });

  it.each([
    '每30秒回复标记。',
    '每90秒回复标记。',
    '每0分钟回复标记。',
    '每〇分钟回复标记。',
    '每零小时回复标记。',
    '每-1分钟回复标记。',
    '每01分钟回复标记。',
    '每１分钟回复标记。',
    '每1.5分钟回复标记。',
    '每一点五小时回复标记。',
    '每半小时回复标记。',
    '每一刻钟回复标记。',
    '每1小时30分钟回复标记。',
    '每两小时零五分钟回复标记。',
    '每1到2小时回复标记。',
    '每一百二分钟回复标记。',
    '每一二十分钟回复标记。',
    '每十零三分钟回复标记。',
    '每一万万分钟回复标记。',
    '每1十分钟回复标记。',
    '每525601分钟回复标记。',
    '每8761小时回复标记。',
    '每366天回复标记。',
    '每99999999999999999999分钟回复标记。',
    '大约每两分钟回复标记。',
    '每两分钟左右回复标记。',
    '每两分钟至少回复标记。',
  ])('never rounds, clamps or chooses a numeric interpretation: %s', (text) => {
    expect(intent(text)).toBeNull();
  });

  it.each([
    '如果我确认了，再每十五分钟提醒我。',
    '不要每天提醒我。',
    '请不要每两分钟回复标记。',
    '可以每两分钟回复标记吗？',
    '每两分钟回复标记，可以吗？',
    '每两分钟回复标记吗。',
    '每两分钟回复标记好不好。',
    '每两分钟回复标记？',
    '每两分钟回复标记。不要创建任务。',
    '每两分钟回复标记。别安排。',
    '每两分钟不要回复标记。',
    '每两分钟回复我并不希望被提醒。',
    '每两分钟如果有空就回复标记。',
    '每两分钟回复标记，除非我已经处理。',
    '每两分钟等我确认后回复标记。',
    '每两分钟只在我同意后回复标记。',
    '每两分钟只要报告齐全就回复标记。',
    '每两分钟整理报告并等我确认才发送。',
    '每两分钟检查报告假设我同意才执行。',
    '每两分钟整理报告但不要创建周期任务。',
    '每两分钟汇总订单并不要执行任务。',
    '每两分钟回复标记但不创建任务。',
    '每两分钟回复标记并别安排提醒。',
    '每两分钟回复标记并勿实际创建任务。',
    '每两分钟回复刚才的任务。',
    '每两分钟执行上次的任务。',
    '每两分钟完成该任务。',
    '每两分钟完成这项工作。',
    '每两分钟按原计划回复标记。',
    '每两分钟保持以后回复都简洁。',
    '每两分钟保存我的长期偏好。',
    '每两分钟提醒我。',
    '每两分钟回复。',
    '每两分钟执行这个任务。',
    '每两分钟创建周期任务。',
    '每两分钟创建周期任务。然后回复标记。',
    '每两分钟不要现在执行。',
  ])(
    'rejects questions, denial, conditions, history and incomplete work: %s',
    (text) => {
      expect(intent(text)).toBeNull();
    },
  );

  it.each([
    '不要再帮我',
    '别现在为我',
    '不得立即自动',
    '不允许你继续帮我',
    '不用再擅自给我',
  ])('rejects a sequence of modifiers before a denied action: %s', (denial) => {
    expect(intent(`每两分钟回复标记但${denial}创建任务。`)).toBeNull();
  });

  it.each(['早上', '早晨', '上午', '中午', '下午', '傍晚', '晚上', '夜间'])(
    'rejects a second ambiguous daily wall time: %s',
    (clock) => {
      expect(intent(`每两分钟回复标记并每天${clock}提醒我喝水。`)).toBeNull();
    },
  );

  it.each([
    '每两分钟回复标记。每三分钟再回复标记。',
    '每两分钟回复标记并每三分钟提醒我喝水。',
    '每两分钟回复标记并每天10:30提醒我检查报告。',
    '每两分钟回复标记并重复执行任务。',
    '每两分钟回复标记。每两分钟再回复标记。',
    '每两分钟回复标记，或者每天09:30回复标记。',
    '每天09:30，时区Asia/Shanghai，回复标记。每天10:30再回复。',
    '每天09:30，时区Asia/Shanghai，回复标记。时区改为America/New_York。',
    '每天09:30，时区Asia/Shanghai，回复标记。每两分钟也回复。',
    '每两分钟回复标记。15分钟后再回复。',
    '每两分钟回复标记。请在十点回复。',
    '每两分钟回复标记。请在10:30回复。',
    '明天开始每两分钟回复标记。',
    '每两分钟从明天开始回复标记。',
    '每两分钟回复标记，明天开始。',
    '每两分钟回复标记，到星期五结束。',
    '每两分钟回复标记，直到我终止。',
    '每两分钟回复标记，共三次。',
    '每两分钟回复标记，只执行一次。',
    '每两分钟执行三次检查。',
    '每两分钟回复2026-10-21开始的提醒。',
    '每两分钟持续回复标记。',
  ])(
    'rejects conflicting rules, extra targets and start/end boundaries: %s',
    (text) => {
      expect(intent(text)).toBeNull();
    },
  );

  it.each([
    '“每两分钟回复标记。”',
    '「请每天09:30，时区Asia/Shanghai，回复标记。」',
    '"每两分钟回复标记。"',
    '`每两分钟回复标记。`',
    '> 每两分钟回复标记。',
    '    每两分钟回复标记。',
    '\t每两分钟回复标记。',
    '```text\n每两分钟回复标记。\n```',
    '~~~\n每两分钟回复标记。\n~~~',
    '示例：每两分钟回复标记。',
    '请解释示例：“每十五分钟提醒我喝水”。',
    '文档说：每两分钟回复标记。',
    '请翻译：每两分钟回复标记。',
    '以下是附件内容：\n每两分钟回复标记。',
    '每两分钟回复标记。这是示例。',
    '每两分钟回复标记这只是文档示例。',
    '每两分钟回复标记是示例。',
    '每两分钟回复标记，仅供参考。',
    '每两分钟翻译这个示例。',
    '每两分钟提醒我喝水。翻译成英文。',
    '每两分钟提醒我喝水。翻译成法语。',
    '每两分钟「回复标记」。',
    '每两分钟回复“标记。',
    '每两分钟回复「标记』。',
    '每两分钟回复“”。',
    '每两分钟回复“  ”。',
    '每两分钟回复标记。\n> 不要创建任务。',
    '每两分钟回复标记。\n```\n创建周期任务\n```',
  ])(
    'never extracts authority from quotes, code or documentation: %s',
    (text) => {
      expect(intent(text)).toBeNull();
    },
  );

  it.each([
    '每两分钟回复标记。\u0000',
    '每两分钟回复标记。不\u200b要创建任务。',
    '每两分钟回复标记。\u202e',
    '每两分钟回复标记。\u2066',
    `每两分钟回复${'字'.repeat(32_000)}。`,
  ])('fails closed on hidden controls or oversized messages', (text) => {
    expect(intent(text)).toBeNull();
  });

  it.each(accepted)(
    'cannot promote a quoted known-good request: $text',
    ({ text }) => {
      expect(intent(`“${text}”`)).toBeNull();
      expect(intent(`文档示例：\n${text}`)).toBeNull();
      expect(intent(`请翻译：\n${text}`)).toBeNull();
      expect(intent(`如果有空，${text}`)).toBeNull();
    },
  );
});
