import { describe, expect, it } from 'vitest';
import { employeeGroups, employeePreferenceKey } from './employee-navigation';
import { collapsedSessionRows } from './dsh-upstream/workspace/collapsed-session-rows';
import type { Session, Workspace } from './chatflow-types';

const employee = (id: string) => ({
  id,
  employeeId: id,
  isDefault: id === 'a',
  currentVersion: { id: `v-${id}`, manifest: { name: id } },
  versions: [],
});
const workspace: Workspace = {
  organizationId: 'org',
  workspaceId: 'work',
  viewerId: 'viewer',
  canAdminister: false,
  employeeProfiles: [],
  sessionModels: [],
  employees: [employee('a'), employee('b')],
  sessions: [],
};
const session = (id: string, assignmentId: string): Session => ({
  id,
  employeeAssignmentId: assignmentId,
  employeeVersionId: `v-${assignmentId}`,
  title: id,
  updatedAt: '2026-09-24T00:00:00Z',
  visibility: 'private',
  archivedAt: null,
});

describe('Allrice employee projection into the native DSH tree', () => {
  it('keeps revoked history with its actual assignment and frozen identity', () => {
    const groups = employeeGroups(
      workspace,
      [
        session('a1', 'a'),
        session('b1', 'b'),
        { ...session('old', 'revoked'), employeeName: '原财务员工' },
      ],
      'old',
      {},
    );
    expect(groups.map((group) => [group.key, group.sessionCount])).toEqual([
      ['a', 1],
      ['b', 1],
      ['revoked', 1],
    ]);
    expect(groups[2]?.label).toBe('原财务员工（已撤回）');
    expect(groups[2]?.sessions[0]?.id).toBe('old');
    expect(groups[0]?.sessions).toEqual([]);
  });
  it('allows manual collapse of the current group and represents zero employees honestly', () => {
    expect(
      employeeGroups(workspace, [session('a1', 'a')], 'a1', { a: false })[0]
        ?.expanded,
    ).toBe(false);
    expect(
      employeeGroups({ ...workspace, employees: [] }, [], null, {}),
    ).toEqual([]);
  });
  it('passes real pending interactions to native rows and keeps running work outside the idle quota', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      session(String(index), 'a'),
    );
    sessions[6] = {
      ...sessions[6]!,
      running: true,
      pendingInteraction: 'approval',
    };
    const group = employeeGroups(workspace, sessions, '0', {})[0]!;
    const collapsed = collapsedSessionRows(group.sessions);
    expect(collapsed.rows.map((row) => row.id)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '6',
    ]);
    expect(collapsed.hiddenCount).toBe(1);
    expect(collapsed.rows.at(-1)?.pendingInteraction).toBe('approval');
  });
  it('isolates remembered expansion across users and workspaces', () => {
    const first = employeePreferenceKey(workspace);
    expect(first).not.toBe(
      employeePreferenceKey({ ...workspace, viewerId: 'other' }),
    );
    expect(first).not.toBe(
      employeePreferenceKey({ ...workspace, workspaceId: 'other' }),
    );
    expect(employeePreferenceKey({ ...workspace, viewerId: null })).toBeNull();
  });
});
