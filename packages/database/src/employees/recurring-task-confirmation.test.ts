import { expect, it } from 'vitest';
import { UserQuestionItemSchema } from '@allrice/contracts';
import {
  confirmedRecurringRequest,
  recurringConfirmation,
  recurringConfirmationQuestion,
  recurringRuleText,
} from './recurring-task-confirmation.ts';

it('renders each rule kind and the conversation mode exactly', () => {
  expect(recurringRuleText({ kind: 'every', seconds: 120 })).toBe(
    '每隔 2 分钟，在本聊天中执行',
  );
  expect(recurringRuleText({ kind: 'every', seconds: 7_200 }, 'reuse')).toBe(
    '每隔 2 小时，在本聊天中执行',
  );
  expect(recurringRuleText({ kind: 'every', seconds: 86_400 })).toBe(
    '每隔 1 天，在本聊天中执行',
  );
  expect(recurringRuleText({ kind: 'every', seconds: 90 })).toBe(
    '每隔 90 秒，在本聊天中执行',
  );
  expect(
    recurringRuleText(
      { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
      'new_each_run',
    ),
  ).toBe('每天 09:30（Asia/Shanghai），每次新建聊天执行');
  expect(
    recurringRuleText({
      kind: 'weekly',
      weekdays: [1, 3, 7],
      time: '02:49:43',
      timezone: 'UTC',
    }),
  ).toBe('每周一、三、日 02:49:43（UTC），在本聊天中执行');
  expect(
    recurringRuleText({
      kind: 'monthly',
      monthDay: 23,
      time: '05:17:00',
      timezone: 'Asia/Shanghai',
    }),
  ).toBe('每月 23 日 05:17（Asia/Shanghai），在本聊天中执行');
});

const request = '弄个定时，每 2 分钟提醒我去吃饭';
const prompt = '提醒我去吃饭';
const rule = { kind: 'every', seconds: 120 } as const;
// The card as DSH presents it after ask_user_question.
const presented = (args: ReturnType<typeof recurringConfirmationQuestion>) =>
  args.questions.map(({ multi_select, ...item }) =>
    UserQuestionItemSchema.parse({ ...item, multiSelect: multi_select }),
  );
const answer = (item: ReturnType<typeof presented>[number], label: string) => [
  { item, label },
];

it('shows what will run, the human words and an explicit decline', () => {
  const card = recurringConfirmationQuestion(request, prompt, rule);
  expect(card.questions).toHaveLength(1);
  expect(card.questions[0]).toMatchObject({
    id: expect.stringMatching(/^schedule-confirm:[0-9a-f]{24}$/),
    multi_select: false,
    options: [
      { label: '确认：每隔 2 分钟，在本聊天中执行' },
      { label: '先不创建' },
    ],
  });
  expect(card.questions[0]!.question).toContain(`每次到点执行：「${prompt}」`);
  expect(card.questions[0]!.question).toContain(request);
  expect(confirmedRecurringRequest(request, prompt, rule)).toBe(
    `${request}\n用户已确认的任务内容：${prompt}\n用户已确认的频率：每隔 2 分钟，在本聊天中执行`,
  );
  // A task too long for the card is not shown, so only the human words run.
  const long = 'x'.repeat(2_001);
  expect(
    recurringConfirmationQuestion(request, long, rule).questions[0]!.question,
  ).not.toContain(long);
  expect(confirmedRecurringRequest(request, long, rule)).not.toContain(long);
});

it('confirms only the server card for exactly this call', () => {
  const [card] = presented(
    recurringConfirmationQuestion(request, prompt, rule),
  );
  const yes = card!.options![0]!.label;
  const confirm = recurringConfirmation;
  expect(confirm(request, prompt, rule, undefined, answer(card!, yes))).toBe(
    'confirmed',
  );
  expect(confirm(request, prompt, rule, 'reuse', answer(card!, yes))).toBe(
    'confirmed',
  );
  const others: [
    string,
    string,
    Parameters<typeof confirm>[2],
    Parameters<typeof confirm>[3],
  ][] = [
    [request, prompt, { kind: 'every', seconds: 180 }, undefined],
    [request, prompt, rule, 'new_each_run'],
    [request, '提醒我去喝水', rule, undefined],
    ['每 3 分钟提醒我喝水', prompt, rule, undefined],
  ];
  for (const [r, p, other, mode] of others)
    expect(confirm(r, p, other, mode, answer(card!, yes))).toBeNull();
  // A model-written question with the same option words confirms nothing.
  for (const forged of [
    { ...card!, question: '哪个按钮需要翻译？' },
    { ...card!, id: 'translate' },
    { ...card!, options: [{ label: yes }] },
    { ...card!, header: '翻译' },
  ])
    expect(
      confirm(request, prompt, rule, undefined, answer(forged, yes)),
    ).toBeNull();
});

it('finds its own card among several on one question', () => {
  const morning = {
    kind: 'daily',
    time: '09:00:00',
    timezone: 'Asia/Shanghai',
  } as const;
  const evening = { ...morning, time: '21:00:00' } as const;
  const [a] = presented(
    recurringConfirmationQuestion(request, prompt, morning),
  );
  const [b] = presented(
    recurringConfirmationQuestion(request, prompt, evening),
  );
  const both = [
    { item: a!, label: a!.options![0]!.label },
    { item: b!, label: '先不创建' },
  ];
  expect(recurringConfirmation(request, prompt, morning, undefined, both)).toBe(
    'confirmed',
  );
  expect(recurringConfirmation(request, prompt, evening, undefined, both)).toBe(
    'declined',
  );
});

it('never offers a card whose confirmed request could not be stored', () => {
  const long = '提'.repeat(38_913);
  const task = '提醒'.repeat(750);
  const stored = confirmedRecurringRequest(long, task, rule);
  expect(stored.length).toBeLessThanOrEqual(40_000);
  expect(stored).not.toContain(`用户已确认的任务内容`);
  expect(
    recurringConfirmationQuestion(long, task, rule).questions[0]!.question,
  ).not.toContain(task);
});

it('includes new_each_run in the selectable label and requires the exact mode and punctuation', () => {
  const [fresh] = presented(
    recurringConfirmationQuestion(request, prompt, rule, 'new_each_run'),
  );
  const label = '确认：每隔 2 分钟，每次新建聊天执行';
  expect(fresh!.options![0]!.label).toBe(label);
  expect(
    recurringConfirmation(
      request,
      prompt,
      rule,
      'new_each_run',
      answer(fresh!, label),
    ),
  ).toBe('confirmed');
  expect(
    recurringConfirmation(
      request,
      prompt,
      rule,
      'reuse',
      answer(fresh!, label),
    ),
  ).toBeNull();
  expect(
    recurringConfirmation(
      request,
      prompt,
      rule,
      'new_each_run',
      answer(fresh!, '确认:每隔2分钟,每次新建聊天执行'),
    ),
  ).toBeNull();
});

it.each([1_999, 2_000, 2_001])(
  'stores only the work actually shown at the %i-character boundary',
  (length) => {
    const work = '水'.repeat(length);
    const [item] = presented(
      recurringConfirmationQuestion(request, `  ${work}\n`, rule),
    );
    const saved = confirmedRecurringRequest(request, `  ${work}\n`, rule);
    expect(item!.id).toMatch(/^schedule-confirm:[0-9a-f]{24}$/);
    if (length <= 2_000) {
      expect(item!.question).toContain(`每次到点执行：「${work}」`);
      expect(saved).toBe(
        `${request}\n用户已确认的任务内容：${work}\n用户已确认的频率：每隔 2 分钟，在本聊天中执行`,
      );
    } else {
      expect(item!.question).not.toContain(work);
      expect(saved).toBe(
        `${request}\n用户已确认的频率：每隔 2 分钟，在本聊天中执行`,
      );
    }
  },
);

it('binds the full human request even when its displayed excerpt is truncated', () => {
  const long = '请提醒我'.repeat(160);
  const [item] = presented(recurringConfirmationQuestion(long, prompt, rule));
  const label = item!.options![0]!.label;
  expect(item!.question).toContain(`${long.slice(0, 600)}…`);
  expect(
    confirmedRecurringRequest(long, prompt, rule).startsWith(`${long}\n`),
  ).toBe(true);
  expect(
    recurringConfirmation(
      `${long}不同内容`,
      prompt,
      rule,
      undefined,
      answer(item!, label),
    ),
  ).toBeNull();
});
