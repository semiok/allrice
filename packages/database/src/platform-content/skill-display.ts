/** Display labels approved in MET-249. These stable catalog identities label
 * actual selected Skills; this map never installs or grants a capability. */
const labels: Readonly<Record<string, { name: string; displayName: string }>> =
  {
    'b04a0000-0019-4000-8000-000000000001': {
      name: 'business-reconciliation',
      displayName: '业务对账',
    },
    'c037049c-4892-403e-84c5-cf14fe07805d': {
      name: 'web-research',
      displayName: '网页调研',
    },
    '733ba913-6f31-41d9-9e8e-eac71b10834a': {
      name: 'workspace-briefing',
      displayName: '工作区简报',
    },
    'f5a5dc62-8209-4f76-9822-7a6157958722': {
      name: 'wechat-research',
      displayName: '公众号调研',
    },
    '63b0d77f-7356-4c1a-a6ae-682d7f58e429': {
      name: 'market-data',
      displayName: '行情数据',
    },
    '8de2b7b4-dd0d-4ce3-a90d-44d9c2e576ca': {
      name: 'research-synthesis',
      displayName: '资料综合',
    },
    'f23bc35e-2c1b-4aca-89e3-f6ca8e2b37e8': {
      name: 'browser-research',
      displayName: '浏览器调研',
    },
    '7f3d020e-0c92-4d3e-96f3-a8e1510bfaba': {
      name: 'office',
      displayName: 'Office 文档',
    },
    'cd2f1428-dba3-57ea-bb4d-d7296c678d1b': {
      name: 'project-development',
      displayName: '项目开发',
    },
    'b9a98b27-c04d-4d1d-a45d-c072fed4d6ca': {
      name: 'scientific-analysis',
      displayName: '科学分析',
    },
    '023f6252-1ecc-54af-adcf-d0ea5e54e89d': {
      name: 'operations-review',
      displayName: '经营复盘',
    },
  };
export function platformSkillDisplayName(skill: { id: string; name: string }) {
  const entry = labels[skill.id];
  return entry?.name === skill.name ? entry.displayName : skill.name;
}
/** Presentation only. Neither native loading nor authorization consults this. */
export const hiddenSystemSkillNames = new Set([
  'governed-memory',
  'workflow-automation',
  'employee-customization',
  'experience-consolidation',
]);
