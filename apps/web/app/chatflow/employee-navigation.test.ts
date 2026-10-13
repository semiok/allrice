import { describe, expect, it } from 'vitest';
import {
  employeeGroups,
  employeePreferenceKey,
  employeeSessionPreview,
} from './employee-navigation';
import type { Session, Workspace } from './chatflow-types';
import { EmployeeInstanceSchema } from '@allrice/contracts';
import {
  employeeChoice,
  employeeChoiceId,
  employeeChoices,
} from './employee-instances';

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
  it('keeps multiple instances of the same assignment separate in selection, counts and session history', () => {
    const assignmentId = '00000000-0000-4000-8000-000000000001';
    const customId = '00000000-0000-4000-8000-000000000002';
    const source = {
      kind: 'tenant_version',
      employeeVersionId: '00000000-0000-4000-8000-000000000003',
    };
    const instances = [assignmentId, customId].map((id, n) =>
      EmployeeInstanceSchema.parse({
        id,
        assignmentId,
        organizationId: assignmentId,
        workspaceId: assignmentId,
        ownerId: assignmentId,
        kind: n ? 'custom' : 'general',
        revision: 1,
        profile: n ? { name: 'Weekly reviewer' } : {},
        creationSource: source,
        source,
        createdAt: '2026-10-13T00:00:00Z',
        updatedAt: '2026-10-13T00:00:00Z',
      }),
    );
    const view: Workspace = {
      ...workspace,
      employees: [{ ...employee(assignmentId), isDefault: true, instances }],
    };
    expect(
      employeeChoices(view).map((e) => [
        employeeChoiceId(e),
        e.id,
        e.isDefault,
      ]),
    ).toEqual([
      [assignmentId, assignmentId, true],
      [customId, assignmentId, false],
    ]);
    expect(employeeChoice(view, customId)?.currentVersion.manifest.name).toBe(
      'Weekly reviewer',
    );
    const original = session('general-session', assignmentId);
    const custom = {
      ...session('custom-session', assignmentId),
      employeeInstanceId: customId,
    };
    const groups = employeeGroups(
      view,
      [original, custom],
      custom.id,
      {},
      'default',
      [
        {
          employeeAssignmentId: assignmentId,
          employeeInstanceId: customId,
          employeeName: 'Weekly reviewer',
          count: 9,
        },
      ],
    );
    expect(groups.map((g) => [g.key, g.sessionCount])).toEqual([
      [assignmentId, 1],
      [customId, 9],
    ]);
    expect(groups[1]?.sessions.map((s) => s.id)).toEqual(['custom-session']);
    expect(groups[1]?.label).toBe('Weekly reviewer');
  });
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
  it('counts running work within five preview rows and retains its pending interaction', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      session(String(index), 'a'),
    );
    sessions[6] = {
      ...sessions[6]!,
      running: true,
      pendingInteraction: 'approval',
    };
    const group = employeeGroups(workspace, sessions, '0', {})[0]!;
    const collapsed = employeeSessionPreview(group.sessions, '0');
    expect(collapsed.rows.map((row) => row.id)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '6',
    ]);
    expect(collapsed.hiddenCount).toBe(2);
    expect(collapsed.rows.at(-1)?.pendingInteraction).toBe('approval');
  });
  it('keeps an older selected session inside the five-row limit even with many running sessions', () => {
    const sessions = Array.from({ length: 9 }, (_, index) => ({
      ...session(String(index), 'a'),
      running: true,
    }));
    const group = employeeGroups(workspace, sessions, '8', {})[0]!;
    const preview = employeeSessionPreview(group.sessions, '8');
    expect(preview.rows.map((row) => row.id)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '8',
    ]);
    expect(preview.hiddenCount).toBe(4);
    sessions.forEach((s) => {
      s.running = false;
    });
    const idle = employeeGroups(workspace, sessions, '8', {})[0]!;
    expect(employeeSessionPreview(idle.sessions, '8').rows).toHaveLength(5);
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
