import { expect, it } from 'vitest';
import { clarifiedScheduleIntent } from './schedule-clarification.ts';

const question = {
  questionId: 'question-actual-run',
  questions: [
    {
      id: 'timing',
      question: '一次还是循环？',
      options: [{ label: '1 分钟后提醒一次' }, { label: '每隔 1 分钟提醒' }],
    },
  ],
};
const answer = (label = '每隔 1 分钟提醒') => ({
  questionId: question.questionId,
  answers: [{ id: 'timing', selected: [label] }],
});

it('freezes only the actual typed frequency/mode choice, never an unselected model option', () => {
  const label = '每隔 1 分钟提醒；每次新建聊天',
    typed = {
      ...question,
      questions: [
        {
          ...question.questions[0]!,
          options: [{ label }, { label: '每隔 1 分钟提醒；沿用来源聊天' }],
        },
      ],
    };
  expect(
    clarifiedScheduleIntent('1 分钟尖叫一次', typed, answer(label)),
  ).toMatchObject({ kind: 'recurring', conversationMode: 'new_each_run' });
  expect(
    clarifiedScheduleIntent(
      '1 分钟尖叫一次',
      typed,
      answer('每隔 1 分钟提醒；沿用来源聊天'),
    ),
  ).toMatchObject({ conversationMode: 'reuse' });
  expect(
    clarifiedScheduleIntent(
      '1 分钟尖叫一次；沿用来源聊天',
      typed,
      answer(label),
    ),
  ).toBeNull();
  expect(
    clarifiedScheduleIntent('1 分钟尖叫一次', question, answer(label)),
  ).toBeNull();
});

it('uses the actual selected frequency for the reported shorthand without deriving authority from the question description', () => {
  expect(clarifiedScheduleIntent('1 分钟尖叫一次', question, answer())).toEqual(
    {
      kind: 'recurring',
      rule: { kind: 'every', seconds: 60 },
      authoritativeRequest:
        '1 分钟尖叫一次\n用户已确认的提醒频率：每隔 1 分钟提醒',
    },
  );
  expect(
    clarifiedScheduleIntent(
      '1 分钟尖叫一次',
      question,
      answer('1 分钟后提醒一次'),
    ),
  ).toMatchObject({ kind: 'once', delayMinutes: 1 });
});
it.each([
  '“1分钟尖叫一次”',
  '如果我确认，1分钟尖叫一次',
  '1分钟不要提醒我',
  '1分钟提醒我喝水，然后2分钟后提醒我吃药',
  '这是示例：1分钟提醒我喝水',
  '解释1分钟提醒我喝水',
  '1分钟提醒我喝水吗？',
  '1分钟循环创建一个定时任务',
  '```\n1分钟尖叫一次\n```',
])(
  'does not promote quoted, conditional or unrelated work into authority: %s',
  (text) => {
    expect(clarifiedScheduleIntent(text, question, answer())).toBeNull();
  },
);
it('requires an exact single-option answer to the bound question; displayed options, forged labels and custom text are not implicit confirmation', () => {
  for (const bad of [
    undefined,
    { ...answer(), questionId: 'other' },
    { ...answer(), answers: [{ id: 'other', selected: ['每隔 1 分钟提醒'] }] },
    answer('每隔 5 分钟提醒'),
    { ...answer(), answers: [{ id: 'timing', selected: [] }] },
    {
      ...answer(),
      answers: [
        { id: 'timing', selected: ['每隔 1 分钟提醒'], custom: '不要创建' },
      ],
    },
    {
      ...answer(),
      answers: [
        { id: 'timing', selected: ['每隔 1 分钟提醒', '1 分钟后提醒一次'] },
      ],
    },
  ])
    expect(clarifiedScheduleIntent('1分钟尖叫一次', question, bad)).toBeNull();
});
it('does not treat descriptions or ambiguous labels as confirmed rules', () => {
  for (const label of [
    '循环提醒',
    '是的',
    '取消任务',
    '每隔30秒提醒',
    '1分钟提醒',
    '每隔1分钟后提醒',
  ]) {
    const q = {
      ...question,
      questions: [
        {
          ...question.questions[0]!,
          options: [{ label, description: '每隔1分钟提醒' }],
        },
      ],
    };
    expect(
      clarifiedScheduleIntent('1分钟尖叫一次', q, answer(label)),
    ).toBeNull();
  }
});
