/** Exact ordinary-page acceptance wording is covered before the model run. */
export function sharedHistoryMethodAcceptancePhrases(
  target: 'company' | { departmentName: string },
  version: number,
) {
  const scope =
    target === 'company' ? '公司的' : `部门「${target.departmentName}」的`;
  return {
    restore: `请恢复${scope}整份工作方法到第${version}版。只保存新的候选，先不要测试或启用。保存候选后，只展示差异。`,
    edit: `请更新${scope}「金额合计」工作场景候选：核对输入后只将整数分相加，输出 totalCents JSON。保留其他场景和原历史，先不测试、不启用。`,
    test: `请测试${scope}「金额合计」工作场景候选。使用固定合成金额样例，保留原断言；先不启用。`,
    confirm: `请查看${scope}恢复候选的测试结果，并让我确认准确版本及范围后启用。`,
    adopt: '按“金额合计”场景处理两笔合成金额：1200 分和 2300 分。',
  };
}
