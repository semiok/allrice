/** One deterministic dataset for the pinned 3.x entry and native sidebar. */
export function createSidebarFixtureData() {
  const fixedNow = Date.parse('2026-11-21T12:00:00.000Z');
  const employee = (id, name) => ({
    id,
    employeeId: id,
    isDefault: id === 'rice',
    versions: [],
    currentVersion: {
      id: `${id}-v1`,
      manifest: { name, description: '合成员工：验证现有左栏组件。' },
    },
  });
  return {
    fixedNow,
    employees: [
      employee('rice', 'Rice'),
      employee('writer', '文案助理与季度报告编辑员'),
      employee('empty', '空员工'),
    ],
    sessions: Array.from({ length: 39 }, (_, index) => ({
      id: `thread-${index}`,
      title:
        index === 0
          ? '核对季度销售预算与重点客户跟进计划：覆盖全部区域、长标题和待办事项'
          : index === 1
            ? 'QuarterlyRevenueCustomerFollowUpReport_2026_AllRegions_FinalReview_NoSpaces'
            : `工作 ${index + 1} · 合成历史记录`,
      ownerId: 'person',
      employeeAssignmentId: index < 32 ? 'rice' : 'writer',
      employeeVersionId: index < 32 ? 'rice-v1' : 'writer-v1',
      visibility: 'private',
      updatedAt: new Date(fixedNow - index * 60000).toISOString(),
      archivedAt:
        index === 31 ? new Date(fixedNow - 86400000).toISOString() : null,
    })),
  };
}
