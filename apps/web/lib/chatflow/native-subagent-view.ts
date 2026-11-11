import type { NativeSubagentSummary } from '@allrice/contracts';
import type { NativeExperienceItem } from './native-experience';

export type NativeSubagentEntry = NativeSubagentSummary['descendants'][number];
export type NativeSubagentViewScope = {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
  viewerId: string | null;
  ownerId: string | null;
  rootRunId?: string | null;
  generation?: number | null;
  bindingRevision?: string;
};
export type NativeSubagentReference = NativeSubagentViewScope & {
  rootId: string;
  id: string;
  parentId: string;
  kind: 'child' | 'diagnostic';
};

/** UI identity only; authorization remains in the existing native query. */
export const nativeSubagentScopeKey = (scope: NativeSubagentViewScope) =>
  JSON.stringify([
    scope.organizationId,
    scope.workspaceId,
    scope.sessionId,
    scope.viewerId,
    scope.ownerId,
    scope.rootRunId ?? null,
    scope.generation ?? null,
    scope.bindingRevision ?? null,
  ]);
export const nativeSubagentTabId = (reference: NativeSubagentReference) =>
  JSON.stringify([
    nativeSubagentScopeKey(reference),
    reference.rootId,
    reference.parentId,
    reference.kind,
    reference.id,
  ]);
export function nativeSubagentReferenceFromTabId(
  id: string,
): NativeSubagentReference | null {
  try {
    const tuple: unknown = JSON.parse(id);
    const address = (value: unknown): value is string =>
      typeof value === 'string' && value.length > 0;
    const nullableAddress = (value: unknown) =>
      value === null || address(value);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 5 ||
      typeof tuple[0] !== 'string' ||
      !tuple.slice(1, 3).every(address) ||
      !address(tuple[4]) ||
      !['child', 'diagnostic'].includes(tuple[3])
    )
      return null;
    const scope: unknown = JSON.parse(tuple[0]);
    if (
      !Array.isArray(scope) ||
      scope.length !== 8 ||
      !scope.slice(0, 3).every(address) ||
      !scope.slice(3, 6).every(nullableAddress) ||
      (scope[6] !== null &&
        (!Number.isSafeInteger(scope[6]) || scope[6] < 0)) ||
      (scope[7] !== null && typeof scope[7] !== 'string')
    )
      return null;
    const reference: NativeSubagentReference = {
      organizationId: scope[0],
      workspaceId: scope[1],
      sessionId: scope[2],
      viewerId: scope[3],
      ownerId: scope[4],
      rootRunId: scope[5],
      generation: scope[6],
      bindingRevision: scope[7] ?? undefined,
      rootId: tuple[1],
      parentId: tuple[2],
      kind: tuple[3],
      id: tuple[4],
    };
    return nativeSubagentTabId(reference) === id ? reference : null;
  } catch {
    return null;
  }
}
export function nativeSubagentReference(
  scope: NativeSubagentViewScope,
  summary: NativeSubagentSummary,
  entry: NativeSubagentEntry,
): NativeSubagentReference {
  const address = {
    ...scope,
    rootId: summary.rootId,
    id: entry.id,
    parentId: entry.parentId,
  };
  return { ...address, kind: entry.kind };
}
export function nativeSubagentReferencedEntry(
  scope: NativeSubagentViewScope,
  reference: NativeSubagentReference,
  summary: NativeSubagentSummary | null,
) {
  if (
    nativeSubagentScopeKey(scope) !== nativeSubagentScopeKey(reference) ||
    summary?.rootId !== reference.rootId
  )
    return undefined;
  const matches = summary.descendants.filter(
    (entry) => entry.id === reference.id,
  );
  const entry = matches.length === 1 ? matches[0] : undefined;
  return entry?.parentId === reference.parentId &&
    (reference.kind === 'child' || entry.kind === 'diagnostic')
    ? entry
    : undefined;
}

/** Complete a missing trace fact once, after rechecking the exact authorized address. */
export function nativeSubagentRefineGeneration(
  scope: NativeSubagentViewScope,
  reference: NativeSubagentReference,
  summary: NativeSubagentSummary | null,
): NativeSubagentReference | null {
  if (
    reference.generation != null ||
    scope.generation == null ||
    !scope.rootRunId ||
    !scope.bindingRevision
  )
    return null;
  const entry = nativeSubagentReferencedEntry(
    { ...scope, generation: null },
    reference,
    summary,
  );
  return entry?.kind === reference.kind
    ? { ...reference, generation: scope.generation }
    : null;
}

export const nativeSubagentDiagnostic = {
  corrupt: '记录损坏',
  unavailable: '暂时无法读取',
  unsupported: '暂不支持此类型',
  identity_mismatch: '身份校验未通过',
  parent_unverified: '父子关系未确认',
};
export function nativeSubagentEntryState(
  summary: NativeSubagentSummary,
  entry: NativeSubagentEntry,
) {
  if (entry.kind === 'diagnostic')
    return {
      state: ['corrupt', 'identity_mismatch'].includes(entry.reason)
        ? 'invalid'
        : entry.reason === 'unsupported'
          ? 'idle'
          : 'warning',
      text: nativeSubagentDiagnostic[entry.reason],
    };
  if (
    summary.root.source !== 'live' ||
    entry.observation.source !== 'live' ||
    entry.running === null
  )
    return { state: 'unknown', text: '状态未知' };
  if (entry.running) return { state: 'running', text: '运行中' };
  if (entry.timing.lastTurnCompleted === true)
    return { state: 'completed', text: '上次回合已完成' };
  if (entry.timing.lastTurnCompleted === false)
    return { state: 'failed', text: '未正常结束' };
  return { state: 'idle', text: '未运行' };
}
export function nativeSubagentElapsedMs(
  summary: NativeSubagentSummary,
  child: Extract<NativeSubagentEntry, { kind: 'child' }>,
  now?: number,
) {
  const { settledMs, active } = child.timing;
  if (!Number.isFinite(settledMs) || settledMs < 0) return undefined;
  if (!active) return settledMs;
  if (!Number.isFinite(active.since) || !Number.isFinite(active.through))
    return undefined;
  const ticking =
    summary.root.source === 'live' &&
    child.observation.source === 'live' &&
    child.running === true;
  return (
    settledMs +
    Math.max(
      0,
      (ticking ? (now ?? active.through) : active.through) - active.since,
    )
  );
}
export const nativeSubagentCallKind = (name?: string) =>
  name === 'subagent' || name === 'subagent_fork'
    ? 'create'
    : name === 'list_agents'
      ? 'directory'
      : null;
export const nativeSubagentDirectoryCall = (
  items: readonly NativeExperienceItem[],
) =>
  items.findLast(
    (item) =>
      item.id.startsWith('tool:') &&
      item.id.length > 5 &&
      item.kind === 'tool' &&
      nativeSubagentCallKind(item.toolName),
  );
