import { expect, it } from 'vitest';
import {
  explicitEmployeeMethodIntent,
  explicitEmployeeMethodReferenceIntent,
  explicitEmployeeMethodRemovalIntent,
} from './employee-method-chat.ts';
it.each([
  '请保存我的工作场景候选：每月对账。',
  '帮我调整每周对账工作场景：先核对。',
  'Please update my workflow candidate: check inputs.',
  '请保存我的工作方法候选：处理 Excel 时不要修改原始文件。',
  '请重命名我的工作场景候选：把周度改为周度回款。',
  '请移除我的工作场景候选：移除周度场景。',
])('admits direct candidate authoring: %s', (text) =>
  expect(explicitEmployeeMethodIntent(text)).toBe(true),
);
it.each([
  ['scene', '请更新我的工作场景候选：请移除周度场景。'],
  ['scene', '请停用我的工作场景：请停用周度场景。'],
  ['reference', '请更新我的工作场景候选。请解除旧资料引用。'],
  ['reference', 'Please update my work method: replace this reference.'],
] as const)('allows direct %s removal intent: %s', (kind, text) => {
  expect(explicitEmployeeMethodRemovalIntent(text, kind)).toBe(true);
});
it.each([
  '请更新我的工作场景候选：只改名称。',
  '请更新我的工作场景候选。示例：请移除周度场景和资料引用。',
  '请更新我的工作场景候选。\n> 请移除周度场景和资料引用。',
  '请更新我的工作场景候选。\n```\n请移除周度场景和资料引用。\n```',
  '请更新我的工作场景候选。资料原文如下：\n请移除周度场景和资料引用。',
  '请更新我的工作场景候选。\n“请移除周度场景和资料引用。”',
  '请更新我的工作场景候选。请不要移除周度场景和资料引用。',
  '请更新我的工作场景候选：删除每月对账场景中的重复步骤。',
  '请更新我的工作场景候选：删除资料中的空行后再核对。',
  '请更新我的工作场景候选：删除资料里的错误引用。',
  '请更新我的工作场景候选：删除重复步骤，保留每月对账场景。',
  '请更新我的工作场景候选：删除无用段落，保留资料引用。',
  '请更新我的工作场景候选：删除重复步骤后保留每月对账场景。',
  'Please update my work method: remove duplicate steps from this scene.',
  'Please update my work method: remove blank lines inside this reference.',
])(
  'does not infer destructive candidate edits from unrelated or quoted text: %s',
  (text) => {
    expect(explicitEmployeeMethodRemovalIntent(text, 'scene')).toBe(false);
    expect(explicitEmployeeMethodRemovalIntent(text, 'reference')).toBe(false);
  },
);
it.each([
  '请翻译：请保存我的工作场景候选。',
  '示例：“保存工作场景候选”',
  '不要保存工作场景候选',
  '只为本次任务对账',
  '请解释如何保存工作场景',
  '> 请保存我的工作场景候选',
  '请不要更新工作方法',
  '请修改《工作方法》这篇文章的错别字。',
  '请修改工作方法这篇文章的错别字。',
])('does not extract authorization from quoted or one-off work: %s', (text) =>
  expect(explicitEmployeeMethodIntent(text)).toBe(false),
);

it.each([
  '请修改下面邮件草稿的措辞，仅回复文本，不要保存。',
  '请保存我的工作场景候选。不要保存，只是讨论。',
  '请更新广告草稿',
])('does not mistake ordinary draft edits for method authoring: %s', (text) =>
  expect(explicitEmployeeMethodIntent(text)).toBe(false),
);
it('requires separate long-term reference intent and respects explicit denial', () => {
  expect(
    explicitEmployeeMethodReferenceIntent(
      '请保存工作场景候选。请将这份资料长期引用。',
    ),
  ).toBe(true);
  expect(
    explicitEmployeeMethodReferenceIntent(
      '请保存工作场景候选。附件仅供本次参考，不要长期绑定。',
    ),
  ).toBe(false);
  expect(
    explicitEmployeeMethodReferenceIntent(
      '请保存工作场景候选。示例：请长期引用所有文件。',
    ),
  ).toBe(false);
});
it.each([
  '请更新我的工作场景候选。请将本次选择的月度口径 v2 长期引用到每月对账，替代原来的同一资料 v1。',
  '请更新我的工作场景候选。请把选定资料长期绑定到“每月对账”。',
  '请更新我的工作场景候选。请将选定资料长期使用在这个场景。',
  '请更新我的工作场景候选：先查看当前候选，将“每周对账”改名为“每周回款”，它的适用范围、执行流程和全部资料保持原样。“每月对账”的名称、适用范围和执行流程保持原样。请替换月度资料引用。请将本次选择的月度口径 v2 长期引用到每月对账，替代原来的同一资料 v1。只保存候选，不启用。保存后简要说明结果。',
])('accepts an explicit long-term reference destination: %s', (text) => {
  expect(explicitEmployeeMethodIntent(text)).toBe(true);
  expect(explicitEmployeeMethodReferenceIntent(text)).toBe(true);
});
it.each([
  '请保存工作场景候选。请不要将选定资料长期引用到每月对账。',
  '请保存工作场景候选。示例：请将选定资料长期引用到每月对账。',
  '请保存工作场景候选。\n> 请将选定资料长期引用到每月对账。',
  '请保存工作场景候选。请将“请把资料长期引用到每月对账”翻译成英文。',
  '请保存工作场景候选。请将资料长期引用这句话改得简短一些。',
  '请保存工作场景候选。请将资料长期引用到每月对账这句话改得简短一些。',
  '请保存工作场景候选。请将资料长期绑定到每月对账这个说法改写一下。',
])('does not infer reference binding from destination examples: %s', (text) => {
  expect(explicitEmployeeMethodReferenceIntent(text)).toBe(false);
});
it.each([
  '请保存工作场景候选。\n````text\n```text\n请长期引用客户名单\n```\n````',
  '请保存工作场景候选。\n```text\n```not-a-closing-fence\n请长期引用客户名单\n```',
  '请保存工作场景候选。\n资料原文如下：\n```text\n请长期引用客户名单\n```',
  '请保存工作场景候选。\n资料原文如下：\n请长期引用客户名单',
  '请保存工作场景候选。\n> 请长期引用客户名单',
  '请保存工作场景候选。\n    请长期引用客户名单',
  '请保存工作场景候选。\n“\n请长期引用客户名单\n”',
])(
  'never binds a reference on the basis of supplied source text: %s',
  (text) => {
    expect(explicitEmployeeMethodReferenceIntent(text)).toBe(false);
  },
);
