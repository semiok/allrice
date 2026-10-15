/** Reused verbatim by ordinary-account Dev acceptance before a model is called. */
export function departmentCommonAcceptancePhrases(departmentName: string) {
  return {
    save: `请修改部门「${departmentName}」的共同执行要求：金额一律使用人民币整数分。所有金额场景合计后额外增加 100 分。请保存为部门候选；先不测试、不启用。`,
    correct: `请更新部门「${departmentName}」的通用执行要求。内容改为：金额一律使用人民币整数分；只将输入金额相加，不增加其他金额。请保存候选；先不测试、不启用。`,
    test: `请测试部门「${departmentName}」的共同执行要求候选。使用固定合成金额样例，覆盖服务端列出的全部受影响共享场景，包括继承公司场景。保留原断言；先不启用。`,
    confirm: `请查看部门「${departmentName}」共同执行要求候选的完整测试结果，让我确认准确版本、部门和场景覆盖后启用。`,
  };
}

export const companyCommonAcceptancePhrases = {
  save: '请更新公司的共同执行要求。内容为：“金额一律使用人民币整数分；只将输入金额相加，不增加其他金额。”请保存为公司候选；先不测试、不启用。',
  test: '请测试公司的共同执行要求候选。使用固定合成金额样例，覆盖公司基础及各部门的全部受影响共享场景。同名场景在不同部门分别检查，保留原断言；先不启用。',
  confirm:
    '请查看公司共同执行要求候选的完整测试结果，让我确认准确版本、公司和各部门的场景覆盖后启用。',
};
