import type {
  Employee,
  EmployeeProfile,
  Session,
  Workspace,
} from './chatflow-types';
import type { CSSProperties } from 'react';
import {
  employeeColorPalette,
  resolveEmployeeAccent,
  type EmployeeAccentColor,
} from '@allrice/contracts';
import { deriveGroups } from './dsh-upstream/workspace/tree';
import type {
  SessionListState,
  WorkspaceView,
  SessionStatusSnapshot,
} from './dsh-upstream/workspace/contracts';
import { zh } from './dsh-upstream/workspace/locales';
import type { WorkspaceBrowserProps } from './dsh-upstream/workspace/contracts';

export const employeeAccent = resolveEmployeeAccent;

export function employeeAccentStyle(
  name: string,
  configured?: EmployeeAccentColor,
): CSSProperties {
  const color = employeeColorPalette[employeeAccent(name, configured)];
  return {
    '--employee-start': color.start,
    '--employee-end': color.end,
  } as CSSProperties;
}

export function employeeIntroduction(
  employee?: Employee,
  profile?: EmployeeProfile,
) {
  const introduction = [
    profile?.description,
    employee?.currentVersion.manifest.description,
  ].find((value) => value?.trim() && !/平台管理员草稿/.test(value));
  const officeOnly =
    profile?.skills.length === 1 &&
    profile.skills[0]?.name.toLowerCase() === 'office';
  return (
    introduction?.trim() ||
    (officeOnly ? '阅读和整理文档，制作报告、表格与演示文稿。' : '') ||
    profile?.identity.mission?.trim() ||
    profile?.identity.role?.trim() ||
    '告诉我你的目标，一起把工作完成。'
  )
    .split(/\r?\n|(?<=[。！？])/u)[0]!
    .trim();
}

export const employeeTranslate: WorkspaceBrowserProps['t'] = (key, params) => {
  const copy =
    key === 'actions.newSession.aria'
      ? '与 {name} 新建工作'
      : key === 'copy'
        ? '复制'
        : zh[key];
  return copy.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ''),
  );
};

export function employeePreferenceKey(workspace: Workspace) {
  return workspace.viewerId
    ? `allrice.employee-tree.v1:${workspace.organizationId}:${workspace.workspaceId}:${workspace.viewerId}`
    : null;
}

export function readEmployeeExpansion(
  key: string | null,
): Record<string, boolean> {
  if (!key || typeof window === 'undefined') return {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, open]) => typeof open === 'boolean'),
    );
  } catch {
    return {};
  }
}

/** Pure projection into the native tree; no backend workspace is created. */
export function employeeGroups(
  workspace: Workspace,
  sessions: Session[],
  activeId: string | null,
  expansion: Record<string, boolean>,
) {
  const assignments = new Map(
    workspace.employees.map((employee) => [employee.id, employee]),
  );
  const ids = [...assignments.keys()];
  for (const session of sessions)
    if (!ids.includes(session.employeeAssignmentId))
      ids.push(session.employeeAssignmentId);
  const nativeGroups: WorkspaceView[] = ids.map((id) => {
    const employee = assignments.get(id);
    const history = sessions.filter(
      (session) => session.employeeAssignmentId === id,
    );
    return {
      workspaceId: id,
      title:
        employee?.currentVersion.manifest.name ??
        `${history[0]?.employeeName ?? '历史员工'}（已撤回）`,
      // No filesystem semantics or host operations are attached to these groups.
      path: '',
      createdAt: '',
      sessionIds: history.map((session) => session.id),
    };
  });
  const list: SessionListState = {
    ids: sessions.map((session) => session.id),
    byId: Object.fromEntries(
      sessions.map((session) => [
        session.id,
        {
          id: session.id,
          displayTitle: session.title,
          blank: false,
          running: session.running ?? false,
          updatedAt: Date.parse(session.updatedAt),
          retainedBy: { mainView: session.id === activeId ? 1 : 0 },
        },
      ]),
    ),
    projectionsBySession: {},
  };
  const statuses: SessionStatusSnapshot = new Map(
    sessions.map((session) => [
      session.id,
      {
        running: session.running ?? false,
        ...(session.pendingInteraction
          ? { pendingInteraction: { kind: session.pendingInteraction } }
          : {}),
      },
    ]),
  );
  const defaultId =
    workspace.employees.find((employee) => employee.isDefault)?.id ??
    workspace.employees[0]?.id;
  const activeGroup = sessions.find(
    (session) => session.id === activeId,
  )?.employeeAssignmentId;
  return deriveGroups(
    list,
    nativeGroups,
    { pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default' },
    statuses,
    {
      expandedGroups: ids.filter(
        (id) => expansion[id] ?? id === (activeGroup ?? defaultId),
      ),
    },
  ).map((group) => ({ ...group, createdAt: undefined }));
}
