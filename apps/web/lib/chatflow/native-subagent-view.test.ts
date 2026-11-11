import { describe, expect, it } from 'vitest';
import type { NativeSubagentSummary } from '@allrice/contracts';
import {
  nativeSubagentCallKind,
  nativeSubagentDirectoryCall,
  nativeSubagentElapsedMs,
  nativeSubagentEntryState,
  nativeSubagentReference,
  nativeSubagentReferencedEntry,
  nativeSubagentReferenceFromTabId,
  nativeSubagentScopeKey,
  nativeSubagentTabId,
  type NativeSubagentViewScope,
} from './native-subagent-view';

const scope: NativeSubagentViewScope = {
  organizationId: 'org',
  workspaceId: 'workspace',
  sessionId: 'session',
  viewerId: 'viewer',
  ownerId: 'owner',
  rootRunId: 'run',
  generation: 0,
  bindingRevision: 'binding',
};
const child: Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
> = {
  kind: 'child',
  id: 'child',
  parentId: 'root',
  depth: 1,
  mode: 'continuable',
  label: '复核',
  running: false,
  activity: 'inactive',
  observation: { source: 'live', cursor: 10 },
  timing: {
    settledMs: 1000,
    active: { since: 1000, through: 1500 },
    lastTurnCompleted: true,
  },
  usage: {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  },
  lastReply: null,
};
const summary: NativeSubagentSummary = {
  rootId: 'root',
  root: { source: 'live', cursor: 10 },
  descendants: [child],
};

describe('native child view projection', () => {
  it('keys exact scope and address, independently of labels or observation source', () => {
    const ref = nativeSubagentReference(scope, summary, child);
    const id = nativeSubagentTabId(ref);
    expect(nativeSubagentReferenceFromTabId(id)).toEqual(ref);
    expect(
      nativeSubagentTabId(
        nativeSubagentReference(scope, summary, {
          ...child,
          label: '同名',
          observation: { source: 'prepared', cursor: 3 },
        }),
      ),
    ).toBe(id);
    for (const patch of [
      { organizationId: 'other' },
      { workspaceId: 'other' },
      { sessionId: 'other' },
      { viewerId: 'other' },
      { ownerId: 'other' },
      { rootRunId: 'other' },
      { generation: 1 },
      { bindingRevision: 'other' },
      { rootId: 'other' },
      { parentId: 'other' },
      { id: 'other' },
    ])
      expect(nativeSubagentTabId({ ...ref, ...patch })).not.toBe(id);
    expect(nativeSubagentScopeKey(scope)).not.toBe(
      nativeSubagentScopeKey({ ...scope, generation: null }),
    );
  });
  it('decodes only canonical complete identity, never child data or permissions', () => {
    const id = nativeSubagentTabId(
      nativeSubagentReference(scope, summary, child),
    );
    const tuple = JSON.parse(id),
      identity = JSON.parse(tuple[0]);
    const invalidKind = [...tuple];
    invalidKind[3] = 'unknown';
    for (const invalid of [
      'child',
      '{}',
      'null',
      ` ${id}`,
      JSON.stringify([...tuple, 'extra']),
      JSON.stringify(invalidKind),
    ])
      expect(nativeSubagentReferenceFromTabId(invalid)).toBeNull();
    for (const invalid of [-1, 0.5, '0']) {
      tuple[0] = JSON.stringify(
        identity.map((value: unknown, index: number) =>
          index === 6 ? invalid : value,
        ),
      );
      expect(
        nativeSubagentReferenceFromTabId(JSON.stringify(tuple)),
      ).toBeNull();
    }
  });
  it('requires a unique current parent and scope and retains child-to-diagnostic explanations', () => {
    const ref = nativeSubagentReference(scope, summary, child);
    expect(nativeSubagentReferencedEntry(scope, ref, summary)).toBe(child);
    expect(
      nativeSubagentReferencedEntry({ ...scope, generation: 1 }, ref, summary),
    ).toBeUndefined();
    expect(
      nativeSubagentReferencedEntry(scope, ref, {
        ...summary,
        rootId: 'other',
      }),
    ).toBeUndefined();
    expect(
      nativeSubagentReferencedEntry(scope, ref, {
        ...summary,
        descendants: [{ ...child, parentId: 'other' }],
      }),
    ).toBeUndefined();
    expect(
      nativeSubagentReferencedEntry(scope, ref, {
        ...summary,
        descendants: [child, child],
      }),
    ).toBeUndefined();
    const diagnostic = {
      kind: 'diagnostic',
      id: child.id,
      parentId: child.parentId,
      depth: 1,
      reason: 'parent_unverified',
    } as const;
    expect(
      nativeSubagentReferencedEntry(scope, ref, {
        ...summary,
        descendants: [diagnostic],
      }),
    ).toBe(diagnostic);
    expect(
      nativeSubagentReferencedEntry(
        scope,
        nativeSubagentReference(scope, summary, diagnostic),
        summary,
      ),
    ).toBeUndefined();
  });
  it('maps only observed native facts, with prepared and null activity taking precedence', () => {
    for (const [running, completed, text] of [
      [true, false, '运行中'],
      [null, true, '状态未知'],
      [false, true, '上次回合已完成'],
      [false, false, '未正常结束'],
      [false, undefined, '未运行'],
    ] as const)
      expect(
        nativeSubagentEntryState(summary, {
          ...child,
          running,
          timing: { settledMs: 0, lastTurnCompleted: completed },
        }).text,
      ).toBe(text);
    expect(
      nativeSubagentEntryState(
        { ...summary, root: { source: 'prepared', cursor: 3 } },
        child,
      ).text,
    ).toBe('状态未知');
    expect(
      nativeSubagentEntryState(summary, {
        ...child,
        observation: { source: 'prepared', cursor: 3 },
      }).text,
    ).toBe('状态未知');
    expect(
      nativeSubagentEntryState(summary, {
        kind: 'diagnostic',
        id: 'bad',
        parentId: 'root',
        depth: 1,
        reason: 'identity_mismatch',
      }),
    ).toEqual({ state: 'invalid', text: '身份校验未通过' });
  });
  it('ticks only a live running active interval and freezes prepared/unknown observations', () => {
    const running = { ...child, running: true };
    expect(nativeSubagentElapsedMs(summary, running, 2000)).toBe(2000);
    expect(nativeSubagentElapsedMs(summary, child, 2000)).toBe(1500);
    expect(
      nativeSubagentElapsedMs(
        { ...summary, root: { source: 'prepared', cursor: 3 } },
        running,
        2000,
      ),
    ).toBe(1500);
    expect(
      nativeSubagentElapsedMs(summary, { ...child, timing: { settledMs: 0 } }),
    ).toBe(0);
    expect(
      nativeSubagentElapsedMs(summary, {
        ...child,
        timing: { settledMs: Number.NaN },
      }),
    ).toBeUndefined();
  });
  it('opens the root directory only from recorded create/list call identities', () => {
    const call = {
      id: 'tool:call',
      kind: 'tool',
      sequence: 1,
      status: 'completed',
      title: '创建',
      toolName: 'subagent',
    } as const;
    expect(nativeSubagentDirectoryCall([call])).toBe(call);
    for (const toolName of ['subagent', 'subagent_fork'])
      expect(nativeSubagentCallKind(toolName)).toBe('create');
    expect(nativeSubagentCallKind('list_agents')).toBe('directory');
    for (const toolName of [
      'send_message',
      'interrupt_agent',
      '标题说创建子智能体',
    ]) {
      expect(nativeSubagentCallKind(toolName)).toBeNull();
      expect(
        nativeSubagentDirectoryCall([{ ...call, toolName }]),
      ).toBeUndefined();
    }
    expect(
      nativeSubagentDirectoryCall([{ ...call, id: 'unrelated' }]),
    ).toBeUndefined();
  });
});
