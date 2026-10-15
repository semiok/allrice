/** The ordinary-page QA uses these exact multi-sentence inputs as well. */
export function selectedDepartmentMethodAcceptancePhrases(
  departmentName: string,
) {
  return {
    save: `请创建部门“${departmentName}”的“金额合计”工作场景：适用于该部门固定合成金额汇总。执行要求：金额用人民币整数分，不改输入。执行流程：把输入整数分相加，输出 totalCents JSON。请保存为该部门候选；暂不测试、不启用。`,
    test: `请测试部门“${departmentName}”的“金额合计”工作场景候选。使用固定合成金额样例，保留原断言；先不启用。`,
    confirm: `请查看部门“${departmentName}”候选的测试结果，并让我确认准确版本和目标部门范围后启用。`,
    adopt: '按“金额合计”场景处理两笔合成金额：1200 分和 2300 分。',
  };
}
