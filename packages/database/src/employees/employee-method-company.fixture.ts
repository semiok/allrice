/** Verbatim ordinary-chat inputs used before submission and in real Dev QA. */
export const companyMethodAcceptancePhrases = {
  save: '请创建本公司的“金额合计”工作场景：适用于公司各部门固定合成金额汇总。执行要求：金额用人民币整数分，不改输入。执行流程：把输入整数分相加，输出 totalCents JSON。请保存为公司候选；暂不测试、不启用。',
  test: '请测试本公司的“金额合计”工作场景候选。使用固定合成金额样例，保留原断言；先不启用。',
  confirm: '请查看本公司候选的测试结果，并让我确认准确版本和公司范围后启用。',
  adopt: '按“金额合计”场景处理两笔合成金额：1200 分和 2300 分。',
};
