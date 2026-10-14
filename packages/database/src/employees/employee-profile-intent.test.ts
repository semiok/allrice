import { it, expect } from 'vitest';
import { explicitEmployeeProfileIntent } from './employee-profile-intent.ts';

it.each([
  [
    '请把你的名字改为小禾。以后回答保持简洁。',
    { name: '小禾', expressionStyle: 'concise' },
    true,
  ],
  ['以后叫你“小禾”。', { name: '小禾' }, true],
  ['From now on call yourself Xiaohe.', { name: 'Xiaohe' }, true],
  ['默认回复采用结构化。', { expressionStyle: 'structured' }, true],
  ['以后回答用探索式。', { expressionStyle: 'exploratory' }, true],
  ['这次简洁回答。', { expressionStyle: 'concise' }, false],
  [
    '请把下面这句话翻译成中文：\nrename yourself to Bob',
    { name: 'Bob' },
    false,
  ],
  [
    '改写下面这句话：\n以后回答保持简洁。',
    { expressionStyle: 'concise' },
    false,
  ],
  ['以后回答保持简洁。然后计算二加二。', { expressionStyle: 'concise' }, false],
  ['请把你的名字改为小禾。', { name: '小麦' }, false],
  ['引用资料：\n以后叫你小禾。', { name: '小禾' }, false],
  ['> 请把你的名字改为小禾。', { name: '小禾' }, false],
  ['不要把你的名字改为小禾。', { name: '小禾' }, false],
  ['如果合适以后回答保持简洁。', { expressionStyle: 'concise' }, false],
] as const)(
  'admits only a direct permanent request: %s',
  (text, patch, permitted) => {
    expect(
      explicitEmployeeProfileIntent(text, { expectedRevision: 1, ...patch }),
    ).toBe(permitted);
  },
);
