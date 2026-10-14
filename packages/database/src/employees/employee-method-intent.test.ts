import { expect, it } from 'vitest';
import {
  explicitEmployeeMethodIntent,
  explicitEmployeeMethodReferenceIntent,
  explicitEmployeeMethodRemovalIntent,
  explicitEmployeeMethodTestIntent,
} from './employee-method-chat.ts';
it.each([
  '请测试我的工作场景候选：金额汇总。',
  '请验证我的工作方法候选。',
  '网络中断了。请测试我的工作场景候选。',
  '刚才连接中断，尚未执行修改。现在只续办这一步：请测试我的工作场景候选：金额汇总。',
  'Please test my workflow candidate.',
])('accepts a direct request for a private candidate test: %s', (text) =>
  expect(explicitEmployeeMethodTestIntent(text)).toBe(true),
);
it.each([
  '请保存我的工作场景候选。',
  '请不要测试我的工作场景候选。',
  '请测试我的工作场景候选。不要测试，只讨论。',
  '请翻译：请测试我的工作场景候选。',
  '> 请测试我的工作场景候选。',
  '网络中断了。\n```\n请测试我的工作场景候选。\n```',
  '资料原文如下：\n请测试我的工作场景候选。',
  '请测试这篇工作方法文章的错别字。',
])(
  'does not turn discussion/source text into paid test authorization: %s',
  (text) => expect(explicitEmployeeMethodTestIntent(text)).toBe(false),
);
it.each([
  '请保存我的工作场景候选：每月对账。',
  '帮我调整每周对账工作场景：先核对。',
  'Please update my workflow candidate: check inputs.',
  '请保存我的工作方法候选：处理 Excel 时不要修改原始文件。',
  '请重命名我的工作场景候选：把周度改为周度回款。',
  '请移除我的工作场景候选：移除周度场景。',
  '上次连接失败后尚未保存修改，请继续未完成的移除操作。请更新我的工作场景候选：请移除每周回款场景。请解除月度资料引用。',
  '刚才网络中断了。请保存我的工作方法候选：保留计算依据。',
  '刚才连接中断，尚未执行修改。现在只续办这一步：请调整我的工作场景候选：金额汇总。去掉额外加固定 100 分的步骤，只将输入的两笔整数分相加，输出 totalCents JSON。保持场景 ID 和适用条件，保存候选即可，不测试、不启用。',
  '上一轮请求超时，尚未保存修改。这次请继续此步骤：请更新我的工作方法候选。',
  'The previous request failed.\nPlease update my workflow candidate: check inputs.',
])('admits direct candidate authoring: %s', (text) =>
  expect(explicitEmployeeMethodIntent(text)).toBe(true),
);
it.each([
  ['scene', '请更新我的工作场景候选：请移除周度场景。'],
  ['scene', '请停用我的工作场景：请停用周度场景。'],
  ['reference', '请更新我的工作场景候选。请解除旧资料引用。'],
  ['reference', 'Please update my work method: replace this reference.'],
  [
    'scene',
    '上次连接失败后尚未保存修改。请更新我的工作场景候选：请移除每周回款场景。',
  ],
  [
    'reference',
    '上次连接失败后尚未保存修改。请更新我的工作场景候选：请解除月度资料引用。',
  ],
  [
    'reference',
    'The request failed.\nPlease update my work method: replace this reference.',
  ],
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
  '网络中断了。\n> 请保存我的工作场景候选。',
  '网络中断了。\n```\n请保存我的工作场景候选。\n```',
  '上次没有保存。资料原文如下：\n请更新我的工作场景候选。',
  '请翻译下文：\n请保存我的工作场景候选。',
  'Please translate this message:\nPlease update my workflow candidate.',
  '请解释下面的提示：请保存工作场景候选。请更新工作方法。',
  '上次网络中断。请保存我的工作场景候选。不要保存，只是讨论。',
  '请翻译下文：\n第一段是背景。\n\n请更新我的工作场景候选：请移除每周回款场景。',
  '客户的原话是：\n请更新我的工作场景候选：请移除每周回款场景。',
  '请翻译下面这段话。\n请更新我的工作场景候选：请移除每周回款场景。',
  '上次连接失败后客户说：请更新我的工作场景候选：请移除每周回款场景。',
  '上次连接失败。\n    请更新我的工作场景候选：请移除每周回款场景。',
  '上次连接失败。\n\t请更新我的工作场景候选：请移除每周回款场景。',
  'The previous request failed.\n    Please update my workflow candidate.',
  '刚才连接中断，尚未执行修改。现在只续办这一步：请翻译：请调整我的工作场景候选。',
  '刚才连接中断，尚未执行修改。现在只续办这一步：资料原文如下：请调整我的工作场景候选。',
  '刚才连接中断，尚未执行修改。现在只续办这一步：\n> 请调整我的工作场景候选。',
  '刚才连接中断，尚未执行修改。现在只续办这一步：\n```\n请调整我的工作场景候选。\n```',
  '刚才连接中断，尚未执行修改。现在只续办这一步：\n    请调整我的工作场景候选。',
  '刚才连接中断，尚未执行修改。现在只续办这一步：“请调整我的工作场景候选。”',
  '刚才连接中断，尚未执行修改。现在只续办这一步：请调整我的工作场景候选。不要保存，只是讨论。',
  '刚才连接中断，客户让我修改。现在只续办这一步：请调整我的工作场景候选。',
  '现在只续办这一步：请调整我的工作场景候选。',
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
