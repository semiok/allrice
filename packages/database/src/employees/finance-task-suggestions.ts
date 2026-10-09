import type { EmployeeManifest, TaskSuggestion } from '@allrice/contracts';

const requiredTools = [
  'workspace.document.read',
  'workspace.skill.read',
  'cloud.process.execute',
  'workspace.reconciliation.export',
];

/** Discovery only: the frozen script and actual grants remain authoritative. */
export function financeTaskSuggestions(
  manifest: Extract<EmployeeManifest, { schemaVersion: 2 }>,
): TaskSuggestion[] {
  const skill = manifest.runtimePackage?.skills.find(
    (value) =>
      value.name === 'business-reconciliation' &&
      requiredTools.every((tool) => value.requiredToolRefs.includes(tool)) &&
      value.bundle?.resources.some(
        (resource) => resource.path === 'scripts/reconcile.mjs',
      ),
  );
  if (
    !skill ||
    !requiredTools.every((tool) =>
      manifest.capabilityBindings.toolNames.includes(tool),
    )
  )
    return [];
  const requires = { nativeSkillIds: [skill.id], toolNames: requiredTools };
  return [
    {
      id: 'reconcile-payments',
      title: '核对发票与回款',
      description: '财务：核对 CNY 清单，列出差异并交付 Excel 对账表。',
      template:
        '核对我添加的发票与回款 CSV。先确认文件、列映射和 CNY 口径，实际计算分笔回款、欠款、超额与未分配金额；重复记录保留待核查，不自行去重。交付可下载的 Excel 对账表和异常说明，注明来源与仍待人工确认的项目。',
      requires,
      preparation: ['files'],
    },
    {
      id: 'revise-reconciliation',
      title: '修正并继续对账',
      description: '财务：按已确认的更正复算，保留原件与旧版对账表。',
      template:
        '继续本会话的对账，按{{更正}}及本次添加的更正文件重新核对。先确认前一版和变更口径，实际复算；交付 Excel 对账表新版本、变化说明与未解决异常，保留原始输入和上一版成果。不把净差额直接认定为真实应收余额。',
      slots: [{ name: '更正', label: '本次数据或口径更正', required: true }],
      requires,
    },
  ];
}
