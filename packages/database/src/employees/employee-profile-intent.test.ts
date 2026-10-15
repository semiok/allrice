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
  [
    '以后回答保持简洁。请保存为我自己的长期默认表达偏好。',
    { expressionStyle: 'concise' },
    true,
  ],
  [
    '以后回答保持简洁，请保存为我的长期默认表达偏好。',
    { expressionStyle: 'concise' },
    true,
  ],
  [
    '请保存为我的默认回复风格。今后，回复采用结构化。',
    { expressionStyle: 'structured' },
    true,
  ],
  ['请保存为我的长期默认表达偏好。', { expressionStyle: 'concise' }, false],
  [
    '以后回答保持简洁。请保存为公司的长期默认表达偏好。',
    { expressionStyle: 'concise' },
    false,
  ],
  [
    '以后回答保持简洁。不要保存为我的长期默认表达偏好。',
    { expressionStyle: 'concise' },
    false,
  ],
  [
    '这次回答保持简洁，请保存为我的长期默认表达偏好。',
    { expressionStyle: 'concise' },
    false,
  ],
  [
    '请改写这句话：以后回答保持简洁，请保存为我的长期默认表达偏好。',
    { expressionStyle: 'concise' },
    false,
  ],
  [
    '以后回答保持简洁。请保存为我的长期默认表达偏好。计算二加二。',
    { expressionStyle: 'concise' },
    false,
  ],
  [
    '以后回答保持简洁，请保存为我的长期默认表达偏好。',
    { expressionStyle: 'structured' },
    false,
  ],
  [
    '以后回答保持简洁，请保存为我的长期默认表达偏好。以后回答采用结构化。',
    { expressionStyle: 'concise' },
    false,
  ],
  [
    '以后回答保持简洁。请把你的名字改为“小白，助手”，请保存为我的默认表达风格。',
    { name: '小白，助手', expressionStyle: 'concise' },
    true,
  ],
  [
    '以后回答保持简洁。请把你的名字改为“小白，助手”，请保存为我的默认表达风格。',
    { name: '小白,助手', expressionStyle: 'concise' },
    false,
  ],
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
