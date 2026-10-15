import { departmentMethodAcceptancePhrases as phrases } from './employee-method-department.fixture.ts';
import { companyMethodAcceptancePhrases as companyPhrases } from './employee-method-company.fixture.ts';
import { expect, it } from 'vitest';
import {
  explicitEmployeeMethodIntent,
  employeeMethodRequestedScope,
  explicitEmployeeMethodRestoreIntent,
  explicitEmployeeMethodReferenceIntent,
  explicitEmployeeMethodRemovalIntent,
  explicitEmployeeMethodTestIntent,
  explicitEmployeeMethodTestRetryIntent,
} from './employee-method-chat.ts';
const retryId = 'abcdefab-0000-4000-8000-000000000001';
it.each([
  `请重试测试 ${retryId}。`,
  `帮我重跑专项测试：${retryId}`,
  `请重新执行候选测试 \`${retryId}\`，沿用原断言。`,
  `网络中断了。请重试测试 ${retryId}。`,
  `刚才连接中断，尚未执行修改。现在只续办这一步：请重试测试 ${retryId}。`,
  `Please retry the candidate test ${retryId.toUpperCase()}.`,
])('authorizes only a named test retry: %s', (text) => {
  expect(explicitEmployeeMethodTestRetryIntent(text, retryId)).toBe(true);
  expect(explicitEmployeeMethodTestIntent(text)).toBe(false);
});
it.each([
  '请测试我的工作场景候选。',
  '请重试失败的测试。',
  `请重试测试 ${retryId.replace(/1$/u, '2')}。`,
  `请重试测试 ${retryId} 和 ${retryId.replace(/1$/u, '2')}。`,
  `请翻译：请重试测试 ${retryId}。`,
  `资料原文如下：\n请重试测试 ${retryId}。`,
  `> 请重试测试 ${retryId}。`,
  `\`\`\`\n请重试测试 ${retryId}\n\`\`\``,
  `“请重试测试 ${retryId}。”`,
  `    请重试测试 ${retryId}。`,
  `网络中断了。\n\t请重试测试 ${retryId}。`,
  `网络中断了。\n> 请重试测试 ${retryId}。`,
  `请不要重试测试 ${retryId}。`,
  `请重试测试 ${retryId}，不要重试，只讨论。`,
  `请重试测试 ${retryId}。不要测试，只查看结果。`,
  `请重试测试 ${retryId}。不要执行，只查看结果。`,
  `请重试测试 ${retryId}，无需验证。`,
  `Please retry test ${retryId}. Do not run it.`,
  `Please retry test ${retryId}. Don't execute the test.`,
  `Please retry test ${retryId}.\nDo not retry.`,
])('does not infer permission for another paid attempt: %s', (text) => {
  expect(explicitEmployeeMethodTestRetryIntent(text, retryId)).toBe(false);
});
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

it.each([
  '请调整我的「金额汇总」工作场景候选：先逐笔核对再相加。',
  '帮我保存“每月对账”的工作方法候选。',
  '请更新我的『周度汇总』执行流程：保留来源。',
  '请修改我的"月度汇总"工作场景候选。',
  '请调整我的`核对金额`工作场景候选。',
])(
  'accepts a literal quoted name inside a direct authoring header: %s',
  (text) => {
    expect(explicitEmployeeMethodIntent(text)).toBe(true);
  },
);
it.each([
  '“请调整我的金额汇总工作场景候选。”',
  '请翻译：请调整我的「金额汇总」工作场景候选。',
  '请修改「工作方法」这篇文章的错别字。',
  '> 请调整我的「金额汇总」工作场景候选。',
  '资料原文如下：\n请调整我的「金额汇总」工作场景候选。',
  '请不要调整我的「金额汇总」工作场景候选。',
  '请调整我的「金额汇总」工作场景候选。不要保存，只讨论。',
  '请调整我的「金额汇总”工作场景候选。',
])(
  'keeps quoted-name discussion and denied writes unauthorized: %s',
  (text) => {
    expect(explicitEmployeeMethodIntent(text)).toBe(false);
    expect(explicitEmployeeMethodTestIntent(text)).toBe(false);
  },
);
it('uses the same literal-name boundary for a separately requested test', () => {
  expect(
    explicitEmployeeMethodTestIntent('请测试我的「金额汇总」工作场景候选。'),
  ).toBe(true);
  expect(
    explicitEmployeeMethodTestIntent('请调整我的「金额汇总」工作场景候选。'),
  ).toBe(false);
});

it.each([
  '不要保存我的「金额汇总」工作场景候选。',
  '不要调整我的『金额汇总』工作场景候选。',
  '请勿更新我的“金额汇总”工作方法。',
  '不允许修改这个"金额汇总"执行流程。',
  '无需创建我的金额汇总工作场景候选。',
  '不要保存我的「金额汇总」工作场景候选，只讨论。',
  '先核对，不要保存我的「金额汇总」工作场景候选。',
  '先核对,请勿更新我的“金额汇总”工作方法,只讨论。',
])('a later named denial overrides candidate authoring: %s', (denial) => {
  expect(
    explicitEmployeeMethodIntent(
      '请调整我的「金额汇总」工作场景候选。' + denial,
    ),
  ).toBe(false);
});
it('rejects a named denial after a comma in the candidate body', () => {
  expect(
    explicitEmployeeMethodIntent(
      '请调整我的「金额汇总」工作场景候选：先核对，不要保存我的「金额汇总」工作场景候选。',
    ),
  ).toBe(false);
});
it('does not infer a paid test from the method body of an authoring request', () => {
  const text =
    '请调整我的「金额汇总」工作场景候选：逐笔核对再相加。保存并回读后，使用平台固定 cny-total-v1 原样例测试一次，不改标准答案、先不启用。';
  expect(explicitEmployeeMethodIntent(text)).toBe(true);
  expect(explicitEmployeeMethodTestIntent(text)).toBe(false);
});

const historySource = { id: retryId, number: 1 };
it.each([
  '请恢复我的整份工作方法到第1版。只保存候选，不启用。',
  '请恢复我的整份工作方法到第1版，保存候选后，只展示差异。',
  '请恢复我的整份工作方法到第1版，保存候选，先不要测试或启用。',
  '请还原个人工作方法至第 1 版',
  '请帮我回退我的工作方法候选到r1',
  '网络中断了。请恢复我的整份工作方法到第1版。',
  `请恢复我的工作方法到版本 ${retryId}`,
  'Please restore my entire work method to version 1.',
])('requires the selected whole-method version: %s', (text) => {
  expect(explicitEmployeeMethodRestoreIntent(text, historySource)).toBe(true);
  expect(
    explicitEmployeeMethodRestoreIntent(text, { id: 'other', number: 2 }),
  ).toBe(false);
});
it.each([
  '请恢复我的每周场景到第1版',
  '请恢复到第1版',
  '请恢复我的整份工作方法到第2版',
  '请恢复我的整份工作方法到第1版或第2版',
  '请恢复我的整份工作方法到第1版。不要恢复，只讨论。',
  '请恢复我的整份工作方法到第1版，不要执行。',
  '请恢复我的整份工作方法到第1版：不要保存，只展示差异。',
  '请恢复我的整份工作方法到第1版，先不要保存，只展示差异。',
  '请恢复我的整份工作方法到第1版，只讨论，不执行。',
  '请恢复我的整份工作方法到第1版，本次暂时不要实际恢复。',
  '请恢复我的整份工作方法到第1版，先别保存候选。',
  '请恢复我的整份工作方法到第1版，暂不保存。',
  '请恢复我的整份工作方法到第1版，只展示差异。',
  '请恢复我的整份工作方法到第1版，保存候选后，先不要保存，只展示差异。',
  '请恢复我的工作方法到第1版，只恢复周度场景，月度场景保持不变。',
  '请翻译：请恢复我的整份工作方法到第1版',
  '资料原文如下：\n请恢复我的整份工作方法到第1版',
  '> 请恢复我的整份工作方法到第1版',
  '“请恢复我的整份工作方法到第1版”',
  '    请恢复我的整份工作方法到第1版',
  '```\n请恢复我的整份工作方法到第1版\n```',
  'Please restore my work method to version 1. Do not restore it.',
])(
  'does not infer whole-method restore from an ambiguous or quoted request: %s',
  (text) => {
    expect(explicitEmployeeMethodRestoreIntent(text, historySource)).toBe(
      false,
    );
  },
);

// These are the complete planned public-chat inputs, not shortened substitutes.
it('admits the original multi-sentence department save and test wording', () => {
  expect(explicitEmployeeMethodIntent(phrases.save)).toBe(true);
  expect(explicitEmployeeMethodTestIntent(phrases.test)).toBe(true);
  expect(employeeMethodRequestedScope(phrases.save)).toBe('department');
  expect(employeeMethodRequestedScope(phrases.test)).toBe('department');
});
it('admits the complete company QA wording before real model acceptance', () => {
  expect(explicitEmployeeMethodIntent(companyPhrases.save)).toBe(true);
  expect(explicitEmployeeMethodTestIntent(companyPhrases.test)).toBe(true);
  expect(employeeMethodRequestedScope(companyPhrases.save)).toBe('company');
  expect(employeeMethodRequestedScope(companyPhrases.test)).toBe('company');
});
it.each([
  '请更新我们公司的「金额，合计」工作场景候选。只相加；暂不启用。',
  '请保存公司工作场景候选：以后用整数分。',
  '请创建全公司的“周度汇总”工作场景：先检查输入。',
])(
  'recognizes direct company targets with quoted names and punctuation: %s',
  (text) => {
    expect(explicitEmployeeMethodIntent(text)).toBe(true);
    expect(employeeMethodRequestedScope(text)).toBe('company');
  },
);
it.each([
  `“${companyPhrases.save}”`,
  `资料原文如下：\n${companyPhrases.save}`,
  `请翻译：${companyPhrases.save}`,
  `> ${companyPhrases.save}`,
  `这次临时按公司流程做一次。${companyPhrases.save}`,
  `${companyPhrases.save}请先别保存。`,
  `${companyPhrases.save}只用于本次任务。`,
  `${companyPhrases.save}不要长期保存。`,
  'Please save company work method: sum integer cents; do not save company work method.',
  '请保存本公司工作场景候选：整数分相加。只用于这次任务。',
])(
  'does not persist quoted, temporary or denied company requests: %s',
  (text) => {
    expect(explicitEmployeeMethodIntent(text)).toBe(false);
  },
);
it.each([
  '请保存本公司工作场景候选：整数分相加。请不要共享。',
  '请更新本公司的“金额合计”工作场景。仅供我个人使用。',
  '请创建公司工作场景候选。不要向公司共享。',
])('does not grant contradictory company sharing: %s', (text) => {
  expect(employeeMethodRequestedScope(text)).toBe('unsupported');
});
it.each([
  '请保存我的“全公司共享”工作场景：公司样本。',
  '请创建“公司汇总”工作场景：公司数据。',
  '请保存仅供我个人使用而非公司共享的工作场景候选：金额只相加。',
  '请创建我的公司资料汇总工作场景：每周使用。',
])(
  'never turns a name or body mention into company authorization: %s',
  (text) => {
    expect(explicitEmployeeMethodIntent(text)).toBe(true);
    expect(employeeMethodRequestedScope(text)).toBe('personal');
  },
);
it.each([
  '请创建本部门的「金额，合计」工作场景：只相加。保存候选，不启用。',
  '请更新我们部门的“周度对账”工作场景候选。保留原始数据。',
  '请保存本部门工作场景候选：以后使用整数分。',
])('recognizes a direct scoped request with literal names: %s', (text) => {
  expect(explicitEmployeeMethodIntent(text)).toBe(true);
  expect(employeeMethodRequestedScope(text)).toBe('department');
});
it.each([
  `“${phrases.save}”`,
  `资料原文如下：\n${phrases.save}`,
  `请翻译：${phrases.save}`,
  `> ${phrases.save}`,
  `这次临时按部门流程做一次。${phrases.save}`,
  `${phrases.save}请先别保存。`,
  `${phrases.save}本次不要修改工作场景。`,
  `${phrases.save}只讨论，暂不保存。`,
])(
  'does not convert source text or a temporary/denied operation into persistence: %s',
  (text) => {
    expect(explicitEmployeeMethodIntent(text)).toBe(false);
  },
);
it('scope in quoted names/body cannot expand the leading request', () => {
  expect(
    employeeMethodRequestedScope('请保存我的“本部门”工作场景：公司样本。'),
  ).toBe('personal');
  expect(
    employeeMethodRequestedScope('请保存公司工作场景候选：金额汇总。'),
  ).toBe('company');
  expect(employeeMethodRequestedScope('请保存财务部门工作场景候选。')).toBe(
    'unsupported',
  );
});

it('a personal-only request mentioning department exclusion never grants sharing', () => {
  const text = '请保存仅供我个人使用而非本部门共享的工作场景候选：金额只相加。';
  expect(explicitEmployeeMethodIntent(text)).toBe(true);
  expect(employeeMethodRequestedScope(text)).toBe('personal');
});
it.each([
  '请保存本部门工作场景候选：整数分相加。请不要共享。',
  '请更新本部门的“金额合计”工作场景。仅供我个人使用。',
  '请创建本部门工作场景候选。不要在本部门共享。',
])(
  'contradictory sharing instructions do not authorize a shared write: %s',
  (text) => {
    expect(employeeMethodRequestedScope(text)).toBe('unsupported');
  },
);
