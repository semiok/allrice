import { describe, expect, it } from 'vitest';
import {
  employeeGroups,
  employeePreferenceKey,
  employeeSessionPreview,
} from './employee-navigation';
import type { Session, Workspace } from './chatflow-types';
import {
  EmployeeInstanceSchema,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import {
  employeeChoice,
  employeeChoiceId,
  employeeChoiceProfile,
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
const nativeSummary = (
  rootId: string,
  running: boolean | null,
  childId = 'same-child',
): NativeSubagentSummary => ({
  rootId,
  root: { source: 'live', cursor: 1 },
  descendants: [
    {
      kind: 'child',
      id: childId,
      parentId: rootId,
      depth: 1,
      mode: 'continuable',
      running,
      activity: running === null ? 'unknown' : 'running',
      observation: { source: 'live', cursor: 1 },
      timing: { settledMs: 0 },
      usage: {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
      lastReply: null,
    },
  ],
});

describe('native child counts in each business Session namespace', () => {
  const parents = [session('parent-a', 'a'), session('parent-b', 'a')];
  const rows = (
    reads: Record<string, NativeSubagentSummary | null | 'error'>,
    sessions = parents,
  ) =>
    employeeGroups(
      workspace,
      sessions,
      'parent-a',
      {},
      'default',
      [],
      reads,
    )[0]!.sessions;
  const counts = (reads: Parameters<typeof rows>[0]) =>
    rows(reads).map((row) => [row.id, row.runningSubagentCount]);

  it.each(['root-a', 'root-b'])(
    'isolates identical raw child IDs even when the second root is %s',
    (secondRoot) => {
      const entries = [
        ['parent-a', nativeSummary('root-a', true)],
        ['parent-b', nativeSummary(secondRoot, false)],
      ] as const;
      for (const ordered of [entries, [...entries].reverse()]) {
        const reads = Object.fromEntries(ordered);
        expect(counts(reads)).toEqual([
          ['parent-a', 1],
          ['parent-b', 0],
        ]);
        expect(
          Object.values(reads).map((read) => read.descendants[0]?.id),
        ).toEqual(['same-child', 'same-child']);
      }
    },
  );

  it('keeps A running while B updates its same-ID child or becomes unknown or unreadable', () => {
    const a = nativeSummary('root-a', true);
    for (const running of [true, false, null])
      expect(
        counts({ 'parent-a': a, 'parent-b': nativeSummary('root-b', running) }),
      ).toEqual([
        ['parent-a', 1],
        ['parent-b', running === true ? 1 : 0],
      ]);
    for (const read of [null, 'error'] as const)
      expect(counts({ 'parent-a': a, 'parent-b': read })).toEqual([
        ['parent-a', 1],
        ['parent-b', 0],
      ]);
  });

  it('does not overwrite a business Session running or pending status with a matching raw child ID', () => {
    const result = rows(
      { 'parent-a': nativeSummary('root-a', true, 'parent-b') },
      [
        parents[0]!,
        { ...parents[1]!, running: false, pendingInteraction: 'question' },
      ],
    );
    expect(result[0]?.runningSubagentCount).toBe(1);
    expect(result[1]).toMatchObject({
      id: 'parent-b',
      running: false,
      pendingInteraction: 'question',
      runningSubagentCount: 0,
    });
  });

  it('counts only known-running direct children without falling back to a same-ID business Session', () => {
    const unknown = nativeSummary('root-a', null, 'parent-b');
    const running = nativeSummary('root-a', true).descendants[0]!;
    unknown.descendants.push(
      running,
      { ...running, id: 'grandchild', parentId: 'same-child', depth: 2 },
      {
        kind: 'diagnostic',
        id: 'parent-c',
        parentId: 'root-a',
        depth: 1,
        reason: 'unavailable',
      },
    );
    const result = rows({ 'parent-a': unknown }, [
      parents[0]!,
      { ...parents[1]!, running: true },
      { ...session('parent-c', 'a'), running: true },
    ]);
    expect(
      result.map((row) => [row.running, row.runningSubagentCount]),
    ).toEqual([
      [false, 1],
      [true, 0],
      [true, 0],
    ]);
    expect(unknown.descendants[0]).toMatchObject({
      id: 'parent-b',
      running: null,
    });
  });
});

describe('Allrice employee projection into the native DSH tree', () => {
  it('does not resurrect an archived default instance through the legacy fallback', () => {
    const archived = {
      ...workspace,
      employees: [{ ...employee('a'), instances: [] }],
    };
    expect(employeeChoices(archived)).toEqual([]);
    expect(employeeChoice(archived, 'a')).toBeUndefined();
    expect(
      employeeGroups(archived, [session('old', 'a')], 'old', {})[0]?.sessions[0]
        ?.id,
    ).toBe('old');
    expect(employeeChoices(workspace)).toHaveLength(2);
  });
  it('pins within each employee group and keeps pinned work visible in the five-row preview', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      ...session(`a${i}`, 'a'),
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
      pinnedAt: i === 0 ? '2026-10-21T00:00:00Z' : null,
    }));
    const groups = employeeGroups(
      workspace,
      [...rows, { ...session('b1', 'b'), pinnedAt: '2026-10-21T00:00:00Z' }],
      'a8',
      { a: true, b: true },
    );
    expect(groups.map((g) => g.key)).toEqual(['a', 'b']);
    expect(groups[0]!.sessions[0]!.id).toBe('a0');
    expect(groups[0]!.sessions[0]!.pinned).toBe(true);
    expect(groups[1]!.sessions[0]!.id).toBe('b1');
    const preview = employeeSessionPreview(groups[0]!.sessions, 'a8');
    expect(preview.rows).toHaveLength(5);
    expect(preview.rows[0]!.id).toBe('a0');
    expect(preview.hiddenCount).toBe(4);
  });
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

it('keeps general employee list and details on published identity despite legacy personal fields', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const source = { kind: 'tenant_version', employeeVersionId: id };
  const instance = EmployeeInstanceSchema.parse({
    id,
    assignmentId: id,
    organizationId: id,
    workspaceId: id,
    ownerId: id,
    kind: 'general',
    revision: 2,
    profile: {
      name: 'Legacy name',
      description: 'Legacy description',
      role: 'Legacy role',
      expressionStyle: 'concise',
    },
    creationSource: source,
    source,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
  });
  const base = {
    assignmentId: id,
    name: 'Published name',
    description: 'Published description',
    identity: { role: 'Published role' },
  } as Workspace['employeeProfiles'][number];
  const view: Workspace = {
    ...workspace,
    employeeProfiles: [base],
    employees: [
      {
        ...employee(id),
        currentVersion: {
          id: 'published',
          manifest: { name: 'Published name' },
        },
        instances: [instance],
      },
    ],
  };
  expect(employeeChoice(view, id)?.currentVersion.manifest.name).toBe(
    'Published name',
  );
  expect(employeeChoiceProfile(view, id)).toEqual(base);
  view.employees[0]!.instances![0] = { ...instance, kind: 'custom' };
  expect(employeeChoice(view, id)?.currentVersion.manifest.name).toBe(
    'Legacy name',
  );
  expect(employeeChoiceProfile(view, id)).toMatchObject({
    name: 'Legacy name',
    identity: { role: 'Legacy role' },
  });
});
