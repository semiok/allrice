import type { EmployeeSkillHostCopy } from './employee-skills-host';

// Host text describes the existing API outcomes; it does not change permission,
// request identity or the distinction between unknown and rejected writes.
export const employeeSkillHostCopy: EmployeeSkillHostCopy = {
  loading: '正在读取…',
  catalogError: '技能读取失败，请重试。',
  accessLost: '暂时无法访问这个员工的技能，请返回后重新打开。',
  sourceInvalid: '无法读取这个技能包，请检查根目录的 SKILL.md 和文件限制。',
  sourceLimit: '技能数量或版本已达到上限，请先检查当前安装。',
  sourceConflict: '技能 name 已存在或与原技能不同，请检查后重新读取。',
  nameMismatch: '新包的 name 与当前技能不同，不能用于更新。',
  previewInvalid: '技能预览已失效或内容不完整，请重新读取后确认。',
  submissionUnknown: '暂时无法确认操作结果，操作可能已完成。请重试。',
  submissionUnresolved: '暂时无法确认操作结果，操作可能已完成。',
  removalFailed: '技能状态或权限已变化，请刷新后重试。',
  unchanged: { title: '确认更新', message: '和当前内容完全一样，不用更新。' },
  disabledBindingLabel: '已停用',
};
