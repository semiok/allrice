import { expect, it } from 'vitest';
import {
  explicitEmployeeMethodIntent,
  explicitEmployeeMethodReferenceIntent,
} from './employee-method-chat.ts';
it.each([
  '请保存我的工作场景候选：每月对账。',
  '帮我调整每周对账工作场景：先核对。',
  'Please update my workflow candidate: check inputs.',
  '请保存我的工作方法候选：处理 Excel 时不要修改原始文件。',
])('admits direct candidate authoring: %s', (text) =>
  expect(explicitEmployeeMethodIntent(text)).toBe(true),
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
