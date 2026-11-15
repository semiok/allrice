import type {
  EmployeeDetails,
  EmployeeResolvedContent,
} from '@allrice/contracts';

/** Source labels remain quoted data; the model interprets the requested edit. */
export function createEmployeeScenePrompt(details: EmployeeDetails) {
  return [
    '请新增我的工作场景：',
    `AI 员工：${JSON.stringify(details.profile.name)}`,
    `已有场景：${details.content.scenes.length ? details.content.scenes.map((scene) => JSON.stringify(scene.name)).join('、') : '暂无'}`,
    '仅新增我的个人场景，保留现有场景及公司、部门和平台要求。',
    '场景名称和用途：',
  ].join('\n');
}

export function adjustEmployeeContentPrompt({
  employeeName,
  sceneName,
  source,
}: {
  employeeName: string;
  sceneName?: string;
  source: EmployeeResolvedContent;
}) {
  const kind = source.reference.sourceKind;
  const dimension =
    kind === 'requirement' || kind === 'company_rule'
      ? '执行要求'
      : kind === 'procedure' || kind === 'workflow'
        ? '执行流程'
        : '参考资料';
  const header = sceneName
    ? '请调整我的工作场景：'
    : dimension === '执行要求' || dimension === '执行流程'
      ? `请调整我的通用${dimension}：`
      : '请调整我的工作方法：';
  return [
    header,
    `AI 员工：${JSON.stringify(employeeName)}`,
    `范围：${sceneName ? JSON.stringify(sceneName) : '通用内容'} · ${dimension}`,
    `调整内容：${JSON.stringify(source.title ?? '个人内容')}`,
    ...(source.body
      ? [
          `当前内容${source.body.length > 1600 ? '节选' : ''}：${JSON.stringify(source.body.slice(0, 1600))}`,
        ]
      : []),
    '仅调整我的个人内容，保留未提及的内容及公司、部门和平台要求。',
    '我的调整要求：',
  ].join('\n');
}
