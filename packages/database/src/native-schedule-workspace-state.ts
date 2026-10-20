import { runtimePolicyDigest } from './runtime-policy.ts';

/** Normalized, internal workspace storage. No tenant data or business messages. */
export interface NativeOnceWorkspaceRecord {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface NativeOnceWorkspaceGlobal {
  initialized: boolean;
  workspaceIds: string[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  defaultWorkspaceId?: string;
  pendingMutation?: { operation: 'create' | 'delete'; workspaceId: string };
}
export interface NativeOnceWorkspaceSnapshot {
  unitVersion: 2;
  revision: number;
  tables: { workspaces: Record<string, NativeOnceWorkspaceRecord> };
  global: NativeOnceWorkspaceGlobal | null;
}
export type NativeOnceWorkspaceMutation =
  | {
      kind: 'put_record';
      table: 'workspaces';
      key: string;
      value: NativeOnceWorkspaceRecord;
    }
  | { kind: 'delete_record'; table: 'workspaces'; key: string }
  | { kind: 'set_global'; value: NativeOnceWorkspaceGlobal };
export interface NativeOnceWorkspaceWrite {
  writeId: string;
  digest: string;
  expectedRevision: number;
  mutation: NativeOnceWorkspaceMutation;
}
export interface NativeOnceWorkspaceScope {
  stateRoot: string;
  controlSessionIds: ReadonlySet<string>;
}
export class NativeOnceWorkspaceError extends Error {
  constructor(readonly code: string) {
    super(`native_once_workspace_${code}`);
  }
}
function reject(code: string): never {
  throw new NativeOnceWorkspaceError(code);
}
const own = (v: object, key: string) =>
  Object.prototype.hasOwnProperty.call(v, key);
const byteString = (v: unknown, max: number, empty = false): v is string =>
  typeof v === 'string' &&
  (empty || v.length > 0) &&
  Buffer.byteLength(v, 'utf8') <= max;
const safeRevision = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const iso = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;

/** SQL accepts normalized JSON only; optional undefined must be normalized at
 * the approved public schema adapter, never silently discarded in this layer. */
export function nativeOnceWorkspaceDigest(
  value: unknown,
  envelope = false,
): string {
  const maxNodes = envelope ? 80_000 : 40_000;
  const maxDepth = envelope ? 20 : 16;
  const maxBytes = envelope ? 4_194_304 : 2_097_152;
  let nodes = 0;
  const visiting = new Set<object>();
  const visit = (v: unknown, depth: number) => {
    if (++nodes > maxNodes || depth > maxDepth) reject('json_limit');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) reject('invalid_json');
      return;
    }
    if (!v || typeof v !== 'object' || visiting.has(v)) reject('invalid_json');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype)
      reject('invalid_json');
    visiting.add(v);
    const keys = Reflect.ownKeys(v);
    if (array && keys.length !== v.length + 1) reject('invalid_json');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') reject('invalid_json');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
        reject('invalid_json');
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d) || !d.enumerable) reject('invalid_json');
      visit(d.value, depth + 1);
    }
    visiting.delete(v);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes)
    reject('json_limit');
  return runtimePolicyDigest(value);
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return reject('shape');
  const v = value as Record<string, unknown>;
  if (
    required.some((k) => !own(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    reject('shape');
  return v;
}
function ids(
  value: unknown,
  max: number,
  allowed?: ReadonlySet<string>,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((id) => !byteString(id, 64) || (allowed && !allowed.has(id))) ||
    new Set(value).size !== value.length
  )
    return reject('identities');
  return value;
}
function record(value: unknown, scope: NativeOnceWorkspaceScope): void {
  const v = object(value, [
    'path',
    'title',
    'sessionIds',
    'createdAt',
    'updatedAt',
  ]);
  if (
    !byteString(v.path, 4096) ||
    v.path !== scope.stateRoot ||
    !byteString(v.title, 512, true) ||
    !iso(v.createdAt) ||
    !iso(v.updatedAt)
  )
    reject('record');
  ids(v.sessionIds, 10_000, scope.controlSessionIds);
}
function global(value: unknown, scope: NativeOnceWorkspaceScope): void {
  const v = object(
    value,
    ['initialized', 'workspaceIds', 'archivedSessionIds', 'pinnedSessionIds'],
    ['defaultWorkspaceId', 'pendingMutation'],
  );
  if (typeof v.initialized !== 'boolean') reject('global');
  ids(v.workspaceIds, 1);
  const archived = ids(v.archivedSessionIds, 10_000, scope.controlSessionIds);
  const pinned = ids(v.pinnedSessionIds, 10_000, scope.controlSessionIds);
  const pinnedSet = new Set(pinned);
  if (archived.some((id) => pinnedSet.has(id)))
    reject('archived_pinned_overlap');
  if (own(v, 'defaultWorkspaceId') && !byteString(v.defaultWorkspaceId, 64))
    reject('default_workspace');
  if (own(v, 'pendingMutation')) {
    const pending = object(v.pendingMutation, ['operation', 'workspaceId']);
    if (
      (pending.operation !== 'create' && pending.operation !== 'delete') ||
      !byteString(pending.workspaceId, 64)
    )
      reject('pending_mutation');
  }
  // Public pendingMutation recovery legitimately observes non-final table/order
  // states. Do not require table IDs or default ID to equal workspaceIds here.
}
export function validateNativeOnceWorkspaceSnapshot(
  value: unknown,
  scope: NativeOnceWorkspaceScope,
): asserts value is NativeOnceWorkspaceSnapshot {
  nativeOnceWorkspaceDigest(value);
  const v = object(value, ['unitVersion', 'revision', 'tables', 'global']);
  if (v.unitVersion !== 2 || !safeRevision(v.revision))
    reject('snapshot_version');
  const tables = object(v.tables, ['workspaces']);
  if (
    !tables.workspaces ||
    typeof tables.workspaces !== 'object' ||
    Array.isArray(tables.workspaces)
  )
    reject('tables');
  const rows = tables.workspaces as Record<string, unknown>;
  if (Object.keys(rows).length > 1) reject('workspace_limit');
  for (const [key, row] of Object.entries(rows)) {
    if (!byteString(key, 64)) reject('workspace_identity');
    record(row, scope);
  }
  if (v.global !== null) global(v.global, scope);
}
export function validateNativeOnceWorkspaceWrite(
  value: unknown,
  scope: NativeOnceWorkspaceScope,
): asserts value is NativeOnceWorkspaceWrite {
  nativeOnceWorkspaceDigest(value, true);
  const v = object(value, [
    'writeId',
    'digest',
    'expectedRevision',
    'mutation',
  ]);
  if (
    typeof v.writeId !== 'string' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v.writeId) ||
    !safeRevision(v.expectedRevision) ||
    v.expectedRevision === Number.MAX_SAFE_INTEGER
  )
    reject('write_identity');
  const m = v.mutation as Record<string, unknown>;
  if (m?.kind === 'put_record') {
    object(m, ['kind', 'table', 'key', 'value']);
    if (m.table !== 'workspaces' || !byteString(m.key, 64)) reject('table');
    record(m.value, scope);
  } else if (m?.kind === 'delete_record') {
    object(m, ['kind', 'table', 'key']);
    if (m.table !== 'workspaces' || !byteString(m.key, 64)) reject('table');
  } else if (m?.kind === 'set_global') {
    object(m, ['kind', 'value']);
    global(m.value, scope);
  } else reject('mutation');
  if (
    v.digest !==
    nativeOnceWorkspaceDigest(
      {
        entryKind: 'workspace',
        unitVersion: 2,
        expectedRevision: v.expectedRevision,
        mutation: m,
      },
      true,
    )
  )
    reject('write_digest');
}
export function applyNativeOnceWorkspaceWrite(
  before: NativeOnceWorkspaceSnapshot,
  write: NativeOnceWorkspaceWrite,
  scope: NativeOnceWorkspaceScope,
): NativeOnceWorkspaceSnapshot {
  validateNativeOnceWorkspaceSnapshot(before, scope);
  validateNativeOnceWorkspaceWrite(write, scope);
  if (before.revision !== write.expectedRevision) reject('revision_conflict');
  const next = structuredClone(before);
  next.revision++;
  const mutation = write.mutation;
  if (mutation.kind === 'set_global')
    next.global = structuredClone(mutation.value);
  else if (mutation.kind === 'delete_record')
    delete next.tables.workspaces[mutation.key];
  else
    Object.defineProperty(next.tables.workspaces, mutation.key, {
      value: structuredClone(mutation.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  validateNativeOnceWorkspaceSnapshot(next, scope);
  return next;
}
