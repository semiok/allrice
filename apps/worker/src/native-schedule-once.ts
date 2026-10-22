import type * as CordisModule from '@deepseek-ai/cordis';
import type * as LlmModule from '@deepseek-ai/dsh-llm';
import type * as SessionsModule from '@deepseek-ai/dsh-session';
import type * as ProjectionsModule from '@deepseek-ai/dsh-session-projection';
import type * as SystemPromptModule from '@deepseek-ai/dsh-system-prompt';
import type * as FilesModule from '@deepseek-ai/dsh-fs-local';
import type * as DirectoryModule from '@deepseek-ai/dsh-working-directory';
import type * as ToolsModule from '@deepseek-ai/dsh-tools';
import type * as AgentsModule from '@deepseek-ai/dsh-agent';
import type * as LoopModule from '@deepseek-ai/dsh-agent-loop';
import type * as JsonlModule from '@deepseek-ai/dsh-session-persistence-jsonl';
import type * as StorageModule from '@deepseek-ai/dsh-storage';
import type * as DomainModule from '@deepseek-ai/dsh-storage-domain';
import type * as WorkspaceModule from '@deepseek-ai/dsh-workspace';
import type * as TypertModule from '@deepseek-ai/dsh-typert-registry';
import type * as DefaultModelModule from '@deepseek-ai/dsh-agent-default-model';
import type * as CredentialsModule from '@deepseek-ai/dsh-credentials';
import type * as CommandsModule from '@deepseek-ai/dsh-commands';
import type * as ConnectionModule from '@deepseek-ai/dsh-client-connection';
import type * as AttachmentModule from '@deepseek-ai/dsh-attachment-local';
import type * as UploadModule from '@deepseek-ai/dsh-client-file-upload';
import type * as QueryModule from '@deepseek-ai/dsh-session-query-sqlite';
import type * as ControllerModule from '@deepseek-ai/dsh-api-session-controller';
import type * as SdkModule from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import type * as ScheduleModule from '@deepseek-ai/dsh-schedule';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { StorageBackend, KvUnit } from '@deepseek-ai/dsh-storage';
import type {
  ScheduleTask,
  ScheduleRecord,
  ScheduleCatalogEntry,
} from '@deepseek-ai/dsh-schedule';

const TITLE = 'AllRice once control';
const PROMPT = 'Synthetic schedule control only. Never execute business work.';
const MAX_CONTROLS = 10_000;

type Fault =
  | 'disabled'
  | 'closed'
  | 'lease_lost'
  | 'binding_invalid'
  | 'task_invalid'
  | 'ack_unknown'
  | 'write_rejected'
  | 'history_missing'
  | 'auxiliary_invalid'
  | 'auxiliary_write_unknown'
  | 'host_failed'
  | 'shutdown_failed'
  | 'target_not_future';
export class NativeScheduleOnceError extends Error {
  constructor(readonly code: Fault) {
    super(`NATIVE_SCHEDULE_ONCE_${code.toUpperCase()}`);
  }
}
export interface NativeScheduleControlReference {
  artifactId: string;
  profileId: string;
  storageId: string;
  /** Stable approved storage, never a fresh temporary directory on recovery. */
  stateRoot: string;
}
export interface NativeScheduleWriter {
  partitionId: string;
  ownerId: string;
  epoch: number;
  token: string;
}
export interface NativeScheduleControl {
  kind?: 'once';
  controlId: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  automationId: string;
  revision: number;
  controlSessionId: string;
  at: string;
  sessionState: 'reserved' | 'initializing' | 'ready';
  nativeTaskId: string | null;
  taskDeleted: boolean;
  command: {
    id: string;
    kind: 'create' | 'delete';
    status: 'pending' | 'confirmed' | 'blocked';
  };
}
export type NativeScheduleRecurringRule =
  | { kind: 'every'; seconds: number }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'weekly'; time: string; timezone: string; weekdays: number[] };
/** revision/rule are desired; applied* describe the durably installed rule. */
export interface NativeScheduleRecurringControl extends Omit<
  NativeScheduleControl,
  'kind' | 'at' | 'command'
> {
  kind: 'recurring';
  rule: NativeScheduleRecurringRule;
  appliedRevision: number | null;
  appliedRule: NativeScheduleRecurringRule | null;
  command: {
    id: string;
    kind: 'create' | 'update' | 'delete';
    status: 'pending' | 'confirmed' | 'blocked';
  };
}
export type NativeScheduleAnyControl =
  NativeScheduleControl | NativeScheduleRecurringControl;
export type NativeScheduleMutation =
  | { kind: 'session_initializing' | 'session_ready'; controlId: string }
  | { kind: 'put_task'; controlId: string; task: ScheduleTask }
  | { kind: 'delete_task'; controlId: string; nativeTaskId: string }
  | {
      kind: 'confirm_command';
      controlId: string;
      commandId: string;
      nativeTaskId: string | null;
    }
  | {
      kind: 'reject_command';
      controlId: string;
      commandId: string;
      reason: 'target_not_future';
      absence?: {
        controlSessionId: string;
        catalogDigest: string;
        observedAt: string;
        taskCount: 0;
      };
    };
export interface NativeScheduleWrite {
  writeId: string;
  digest: string;
  mutation: NativeScheduleMutation;
}
/** New DB transaction ports, NOT existing @allrice/database functions.
 * Every mutation validates the DB-time writer fence and immutable scoped mapping.
 * put_task atomically stores the full task, exact receipt, unique revision/target
 * occurrence and pending/blocked outbox. Delete retains the mapping/tombstone.
 * Session state and command CAS use the same exact-write journal. */

export interface NativeScheduleWorkspaceRecord {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface NativeScheduleWorkspaceGlobal {
  initialized: boolean;
  workspaceIds: string[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  defaultWorkspaceId?: string;
  pendingMutation?: { operation: 'create' | 'delete'; workspaceId: string };
}
export interface NativeScheduleWorkspaceSnapshot {
  unitVersion: 2;
  revision: number;
  tables: { workspaces: Record<string, NativeScheduleWorkspaceRecord> };
  global: NativeScheduleWorkspaceGlobal | null;
}
export type NativeScheduleWorkspaceMutation =
  | {
      kind: 'put_record';
      table: 'workspaces';
      key: string;
      value: NativeScheduleWorkspaceRecord;
    }
  | { kind: 'delete_record'; table: 'workspaces'; key: string }
  | { kind: 'set_global'; value: NativeScheduleWorkspaceGlobal };
export interface NativeScheduleWorkspaceWrite {
  writeId: string;
  digest: string;
  expectedRevision: number;
  mutation: NativeScheduleWorkspaceMutation;
}

export interface NativeScheduleOnceStore {
  acquireWriter(): Promise<null | {
    writer: NativeScheduleWriter;
    /** Conservative server TTL measured from before this request was sent. */
    remainingMs: number;
    reference: NativeScheduleControlReference;
    controls: readonly NativeScheduleAnyControl[];
  }>;
  renewWriter(
    writer: NativeScheduleWriter,
  ): Promise<{ writer: NativeScheduleWriter; remainingMs: number } | null>;
  assertWriter(writer: NativeScheduleWriter): Promise<boolean>;
  loadControls(
    writer: NativeScheduleWriter,
  ): Promise<readonly NativeScheduleAnyControl[]>;
  loadTaskRecords(
    writer: NativeScheduleWriter,
  ): Promise<Record<string, unknown>>;
  commitMutation(
    writer: NativeScheduleWriter,
    write: NativeScheduleWrite,
  ): Promise<'committed' | 'rejected'>;
  /** Match this exact writeId + digest + full mutation/associations, not the latest row.
   * Historical ACK readback may succeed after lease loss; it grants no admission. */
  readExactCommit(
    writer: NativeScheduleWriter,
    write: NativeScheduleWrite,
  ): Promise<'committed' | 'absent' | 'unknown'>;
  /** Same exact writer/reference, bounded primary SQL and immutable workspace journal. */
  loadWorkspaceUnit(
    writer: NativeScheduleWriter,
  ): Promise<NativeScheduleWorkspaceSnapshot>;
  /** One submission; resolves only for COMMIT ACK or complete exact-primary proof. */
  commitWorkspaceWrite(
    writer: NativeScheduleWriter,
    write: NativeScheduleWorkspaceWrite,
  ): Promise<{ revision: number }>;
  /** Called only after public Host shutdown AND backend drain succeeded.
   * Acquisition must never replace a still-owned original Session writer/root. */
  releaseClosedWriter(writer: NativeScheduleWriter): Promise<void>;
}
export interface NativeScheduleControlHost {
  boot(): Promise<void>;
  decodeTask(value: unknown): ScheduleTask;
  initializeSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  mountSchedule(): Promise<void>;
  catalog(): Promise<ScheduleCatalogEntry[]>;
  createOnce(sessionId: string, at: string): Promise<ScheduleRecord>;
  createRecurring?(
    sessionId: string,
    rule: NativeScheduleRecurringRule,
  ): Promise<ScheduleRecord>;
  /** null is an explicit non-mutating Schedule conflict, never an unknown ACK. */
  updateRecurring?(
    sessionId: string,
    id: string,
    expected: ScheduleRecord,
    rule: NativeScheduleRecurringRule,
  ): Promise<ScheduleRecord | null>;
  deleteOnce(sessionId: string, id: string): Promise<void>;
  /** Stop Schedule and drain it, then SDK.shutdown, root.dispose. Never self-await from KV. */
  close(): Promise<void>;
}
export interface NativeScheduleControlStats {
  preStepDenials: number;
  modelGateDenials: number;
  adapterCalls: number;
  toolDenials: number;
}
export interface NativeSchedulePublicModules {
  cordis: typeof CordisModule;
  llm: typeof LlmModule;
  sessions: typeof SessionsModule;
  projections: typeof ProjectionsModule;
  systemPrompt: typeof SystemPromptModule;
  files: typeof FilesModule;
  directory: typeof DirectoryModule;
  tools: typeof ToolsModule;
  agents: typeof AgentsModule;
  loop: typeof LoopModule;
  jsonl: typeof JsonlModule;
  storage: typeof StorageModule;
  domain: typeof DomainModule;
  workspace: typeof WorkspaceModule;
  typert: typeof TypertModule;
  defaultModel: typeof DefaultModelModule;
  credentials: typeof CredentialsModule;
  commands: typeof CommandsModule;
  connection: typeof ConnectionModule;
  attachment: typeof AttachmentModule;
  upload: typeof UploadModule;
  query: typeof QueryModule;
  controller: typeof ControllerModule;
  sdk: typeof SdkModule;
  schedule: typeof ScheduleModule;
}
export interface NativeScheduleControlSource {
  reference: NativeScheduleControlReference;
  /** Mainline must verify/retain this EXACT approved artifact/profile/storage tuple.
   * No current-reader fallback, arbitrary module URL, real provider or business tool. */
  loadModules(): Promise<NativeSchedulePublicModules>;
  /** Exact measured AllRice adapter from this approved artifact; no URL/current fallback. */
  loadHostFactory(): Promise<NativeScheduleHostModule>;
}
export type NativeScheduleHostFactory = (input: {
  source: NativeScheduleControlSource;
  backend: StorageBackend;
  auxiliaryBackend: StorageBackend;
  stats: NativeScheduleControlStats;
}) => Promise<NativeScheduleControlHost>;

/** The implementation lives in the approved artifact's measured dsh directory. */
export type NativeScheduleHostInput = Parameters<NativeScheduleHostFactory>[0];
export type NativeScheduleHostModule = (
  input: NativeScheduleHostInput,
  ErrorClass: typeof NativeScheduleOnceError,
) => Promise<NativeScheduleControlHost>;
export const openPublicNativeScheduleOnceHost: NativeScheduleHostFactory =
  async (input) => {
    const open = await input.source.loadHostFactory();
    if (typeof open !== 'function')
      throw new NativeScheduleOnceError('binding_invalid');
    return open(input, NativeScheduleOnceError);
  };

function digest(value: unknown): string {
  const ordered = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(ordered)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [
                key,
                ordered((item as Record<string, unknown>)[key]),
              ]),
          )
        : item;
  return (
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(ordered(value)))
      .digest('hex')
  );
}
const identity = (writer: NativeScheduleWriter) => digest(writer);
function recurringRuleValid(rule: NativeScheduleRecurringRule): boolean {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  if (rule.kind === 'every')
    return (
      Object.keys(rule).sort().join(',') === 'kind,seconds' &&
      Number.isSafeInteger(rule.seconds) &&
      rule.seconds >= 60 &&
      rule.seconds <= 31_536_000
    );
  if (
    !['daily', 'weekly'].includes(rule.kind) ||
    Object.keys(rule).sort().join(',') !==
      (rule.kind === 'weekly'
        ? 'kind,time,timezone,weekdays'
        : 'kind,time,timezone') ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(rule.time) ||
    typeof rule.timezone !== 'string' ||
    !rule.timezone ||
    rule.timezone.length > 64
  )
    return false;
  if (
    rule.kind === 'weekly' &&
    (!Array.isArray(rule.weekdays) ||
      rule.weekdays.length < 1 ||
      rule.weekdays.length > 7 ||
      !Array.from(rule.weekdays).every(
        (day, i, days) =>
          Number.isInteger(day) &&
          day >= 1 &&
          day <= 7 &&
          (i === 0 || day > days[i - 1]!),
      ))
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: rule.timezone });
    return true;
  } catch {
    return false;
  }
}
function recurringRecordMatches(
  record: ScheduleRecord,
  rule: NativeScheduleRecurringRule,
) {
  if (record.kind !== rule.kind) return false;
  if (rule.kind === 'every')
    return record.kind === 'every' && record.everySeconds === rule.seconds;
  if (record.kind !== 'daily' && record.kind !== 'weekly') return false;
  if (
    rule.kind === 'weekly' &&
    (record.kind !== 'weekly' ||
      record.weekdays.length !== rule.weekdays.length ||
      record.weekdays.some((day, i) => day !== rule.weekdays[i]))
  )
    return false;
  try {
    return (
      record.time === `${rule.time}.000` &&
      new Intl.DateTimeFormat('en', {
        timeZone: record.timeZone,
      }).resolvedOptions().timeZone ===
        new Intl.DateTimeFormat('en', {
          timeZone: rule.timezone,
        }).resolvedOptions().timeZone
    );
  } catch {
    return false;
  }
}
function controlsMap(rows: readonly NativeScheduleAnyControl[]) {
  if (rows.length > MAX_CONTROLS)
    throw new NativeScheduleOnceError('binding_invalid');
  const map = new Map<string, NativeScheduleAnyControl>(),
    sessions = new Set<string>(),
    revisions = new Set<string>(),
    tasks = new Set<string>();
  for (const raw of rows) {
    const c = structuredClone(raw),
      revision = JSON.stringify([c.automationId, c.revision]);
    if (
      !c.controlId ||
      !c.organizationId ||
      !c.workspaceId ||
      !c.ownerId ||
      !c.automationId ||
      !c.controlSessionId ||
      !c.command.id ||
      !Number.isSafeInteger(c.revision) ||
      c.revision < 1 ||
      map.has(c.controlId) ||
      sessions.has(c.controlSessionId) ||
      revisions.has(revision) ||
      (c.nativeTaskId !== null &&
        (!c.nativeTaskId || tasks.has(c.nativeTaskId))) ||
      (c.kind !== undefined && c.kind !== 'once' && c.kind !== 'recurring') ||
      (c.kind === 'recurring'
        ? !recurringRuleValid(c.rule) ||
          !['create', 'update', 'delete'].includes(c.command.kind) ||
          (c.appliedRevision === null) !== (c.appliedRule === null) ||
          (c.appliedRevision !== null &&
            (!Number.isSafeInteger(c.appliedRevision) ||
              c.appliedRevision < 1 ||
              c.appliedRevision > c.revision ||
              !recurringRuleValid(c.appliedRule!))) ||
          (c.nativeTaskId !== null && c.appliedRevision === null)
        : !Number.isFinite(Date.parse(c.at)) ||
          new Date(c.at).toISOString() !== c.at) ||
      (c.nativeTaskId !== null && c.sessionState !== 'ready')
    )
      throw new NativeScheduleOnceError('binding_invalid');
    map.set(c.controlId, c);
    sessions.add(c.controlSessionId);
    revisions.add(revision);
    if (c.nativeTaskId) tasks.add(c.nativeTaskId);
  }
  return map;
}
function controlIdentity(c: NativeScheduleAnyControl) {
  if (c.kind === 'recurring')
    return {
      kind: c.kind,
      controlId: c.controlId,
      organizationId: c.organizationId,
      workspaceId: c.workspaceId,
      ownerId: c.ownerId,
      automationId: c.automationId,
      controlSessionId: c.controlSessionId,
    };
  return {
    controlId: c.controlId,
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    automationId: c.automationId,
    revision: c.revision,
    controlSessionId: c.controlSessionId,
    at: c.at,
  };
}
const WORKSPACE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const WORKSPACE_WRITE_BYTES = 4 * 1024 * 1024;
type WorkspaceSchemas = Pick<
  NativeSchedulePublicModules['workspace'],
  'workspaceRecord' | 'workspaceDomainState'
>;
function workspaceInvalid(): never {
  throw new NativeScheduleOnceError('auxiliary_invalid');
}
function workspaceObject(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    workspaceInvalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    Object.values(descriptors).some((d) => !('value' in d) || !d.enumerable)
  )
    workspaceInvalid();
  return value as Record<string, unknown>;
}
function workspaceKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const object = workspaceObject(value),
    allowed = new Set([...required, ...optional]);
  if (
    Object.keys(object).some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(object, key))
  )
    workspaceInvalid();
  return object;
}
function workspaceJson(
  value: unknown,
  bytes = WORKSPACE_SNAPSHOT_BYTES,
  depthLimit = 16,
  nodeLimit = 40_000,
  optionalUndefined = new Set<string>(),
) {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number, path: string): void => {
    if (++nodes > nodeLimit || depth > depthLimit) workspaceInvalid();
    if (item === undefined && optionalUndefined.has(path)) return;
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) workspaceInvalid();
      return;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item))
      workspaceInvalid();
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) workspaceInvalid();
      if (Reflect.ownKeys(item).length !== item.length + 1) workspaceInvalid();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          workspaceInvalid();
        visit(descriptor.value, depth + 1, `${path}[${i}]`);
      }
    } else {
      const object = workspaceObject(item);
      for (const key of Object.keys(object))
        visit(object[key], depth + 1, `${path}.${key}`);
    }
    ancestors.delete(item);
  };
  visit(value, 0, '$');
  // The pre-schema pass permits only two documented optional undefined paths.
  // It does not return a stringified replacement or silently drop other fields.
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) workspaceInvalid();
}
function workspaceString(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max)
    workspaceInvalid();
}
function workspaceIds(
  value: unknown,
  max: number,
  known?: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value) || value.length > max) workspaceInvalid();
  const seen = new Set<string>();
  for (const id of value) {
    workspaceString(id, 64);
    if (seen.has(id) || (known && !known.has(id))) workspaceInvalid();
    seen.add(id);
  }
  return [...seen];
}
function workspaceRecord(
  value: unknown,
  schemas: WorkspaceSchemas,
  stateRoot: string,
  known: ReadonlySet<string>,
) {
  workspaceJson(value);
  workspaceKeys(value, [
    'path',
    'title',
    'sessionIds',
    'createdAt',
    'updatedAt',
  ]);
  let parsed: ReturnType<WorkspaceSchemas['workspaceRecord']['parse']>;
  try {
    parsed = schemas.workspaceRecord.parse(value);
  } catch {
    return workspaceInvalid();
  }
  workspaceString(parsed.path, 4096);
  if (typeof parsed.title !== 'string' || Buffer.byteLength(parsed.title) > 512)
    workspaceInvalid();
  if (parsed.path !== stateRoot) workspaceInvalid();
  workspaceIds(parsed.sessionIds, MAX_CONTROLS, known);
  for (const at of [parsed.createdAt, parsed.updatedAt]) {
    workspaceString(at, 64);
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
      workspaceInvalid();
  }
  return parsed as NativeScheduleWorkspaceRecord;
}
function workspaceGlobal(
  value: unknown,
  schemas: WorkspaceSchemas,
  known: ReadonlySet<string>,
) {
  workspaceJson(
    value,
    WORKSPACE_SNAPSHOT_BYTES,
    16,
    40_000,
    new Set(['$.defaultWorkspaceId', '$.pendingMutation']),
  );
  workspaceKeys(
    value,
    ['initialized', 'workspaceIds'],
    [
      'archivedSessionIds',
      'pinnedSessionIds',
      'defaultWorkspaceId',
      'pendingMutation',
    ],
  );
  // Public schema validation precedes optional-property normalization.
  let parsed: ReturnType<WorkspaceSchemas['workspaceDomainState']['parse']>;
  try {
    parsed = schemas.workspaceDomainState.parse(value);
  } catch {
    return workspaceInvalid();
  }
  if (parsed.pendingMutation !== undefined) {
    workspaceKeys(parsed.pendingMutation, ['operation', 'workspaceId']);
    // Check the raw object too: the public zod schema is stripping by default.
    workspaceKeys(workspaceObject(value).pendingMutation, [
      'operation',
      'workspaceId',
    ]);
    workspaceString(parsed.pendingMutation.workspaceId, 64);
  }
  if (parsed.defaultWorkspaceId !== undefined)
    workspaceString(parsed.defaultWorkspaceId, 64);
  workspaceIds(parsed.workspaceIds, 1);
  const archived = workspaceIds(parsed.archivedSessionIds, MAX_CONTROLS, known);
  const pinned = workspaceIds(parsed.pinnedSessionIds, MAX_CONTROLS, known);
  if (pinned.some((id) => archived.includes(id))) workspaceInvalid();
  const normalized = { ...parsed };
  if (normalized.defaultWorkspaceId === undefined)
    delete normalized.defaultWorkspaceId;
  if (normalized.pendingMutation === undefined)
    delete normalized.pendingMutation;
  workspaceJson(normalized);
  return normalized as NativeScheduleWorkspaceGlobal;
}
function workspaceSnapshot(
  value: unknown,
  schemas: WorkspaceSchemas,
  stateRoot: string,
  known: ReadonlySet<string>,
) {
  workspaceJson(value);
  const raw = workspaceKeys(value, [
    'unitVersion',
    'revision',
    'tables',
    'global',
  ]);
  if (
    raw.unitVersion !== 2 ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0
  )
    workspaceInvalid();
  const tables = workspaceKeys(raw.tables, ['workspaces']);
  const rows = workspaceObject(tables.workspaces);
  if (Object.keys(rows).length > 1) workspaceInvalid();
  const workspaces: Record<string, NativeScheduleWorkspaceRecord> = {};
  for (const [key, row] of Object.entries(rows)) {
    workspaceString(key, 64);
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      workspaceInvalid();
    workspaces[key] = workspaceRecord(row, schemas, stateRoot, known);
  }
  // A never-written global slot stays null even during a legitimate header
  // bootstrap that has already persisted records. Do not invent initialized.
  const global =
    raw.global === null ? null : workspaceGlobal(raw.global, schemas, known);
  return {
    unitVersion: 2 as const,
    revision: Number(raw.revision),
    tables: { workspaces },
    global,
  };
}

interface Generation {
  writer: NativeScheduleWriter;
  controls: Map<string, NativeScheduleAnyControl>;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  host?: NativeScheduleControlHost;
  opening?: Promise<NativeScheduleControlHost>;
  backend: StorageBackend;
  auxiliaryBackend: StorageBackend;
  admitting: boolean;
  fault?: Fault;
  closing?: Promise<void>;
  closed: boolean;
  ready: boolean;
  writes: Set<Promise<void>>;
}
export interface NativeScheduleOnceOptions {
  /** Omitted is disabled. This flag is deployment-owned, never a tool argument. */
  enabled?: boolean;
  store: NativeScheduleOnceStore;
  source: NativeScheduleControlSource;
  hostFactory?: NativeScheduleHostFactory;
  now?: () => number;
}

/** No business provider/tool execution or occurrence dispatch lives here. */
export function createNativeScheduleOnceController(
  options: NativeScheduleOnceOptions,
) {
  const now = options.now ?? (() => performance.now());
  const stats: NativeScheduleControlStats = {
    preStepDenials: 0,
    modelGateDenials: 0,
    adapterCalls: 0,
    toolDenials: 0,
  };
  let current: Generation | undefined,
    stopped = false,
    terminal = false,
    lastFault: Fault | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const failure = (code: Fault): never => {
    throw new NativeScheduleOnceError(code);
  };
  function quarantine(g: Generation, code: Fault) {
    g.admitting = false;
    g.fault ??= code;
    lastFault = g.fault;
    // WorkspaceRegistry may write during boot. An unknown auxiliary COMMIT
    // must not let the next producer tick reboot it with a replacement writeId.
    // Still close/drain this generation; explicit recovery must reconcile SQL.
    if (code === 'auxiliary_write_unknown') terminal = true;
    if (g.timer) clearTimeout(g.timer);
    // Never await disposal from a KV call: Schedule.dispose waits that call.
    queueMicrotask(() => {
      void closeGeneration(g).catch(() => undefined);
    });
  }
  function locallyLive(g: Generation, command = false) {
    if (g.fault || g.closed || (command && (!g.admitting || stopped)))
      failure(g.fault ?? 'closed');
    if (now() >= g.deadline) {
      quarantine(g, 'lease_lost');
      failure('lease_lost');
    }
  }
  async function fenced(g: Generation, command = false) {
    locallyLive(g, command);
    let valid = false;
    try {
      valid = await options.store.assertWriter(g.writer);
    } catch {
      /* unknown fence is no admission */
    }
    if (!valid) {
      quarantine(g, 'lease_lost');
      failure('lease_lost');
    }
    locallyLive(g, command);
  }
  function deadline(g: Generation, sentAt: number, remaining: number) {
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 300_000)
      failure('lease_lost');
    g.deadline = sentAt + remaining;
    if (g.timer) clearTimeout(g.timer);
    if (now() >= g.deadline) {
      quarantine(g, 'lease_lost');
      failure('lease_lost');
    }
    g.timer = setTimeout(
      () => quarantine(g, 'lease_lost'),
      Math.max(1, g.deadline - now()),
    );
    g.timer.unref?.();
  }
  function mutate(g: Generation, mutation: NativeScheduleMutation) {
    const task = (async () => {
      await fenced(
        g,
        mutation.kind !== 'put_task' && mutation.kind !== 'delete_task',
      );
      const write: NativeScheduleWrite = {
        writeId: randomUUID(),
        digest: digest(mutation),
        mutation: structuredClone(mutation),
      };
      try {
        const result = await options.store.commitMutation(g.writer, write);
        if (result === 'committed') return;
        quarantine(g, 'write_rejected');
        failure('write_rejected');
      } catch (error) {
        if (error instanceof NativeScheduleOnceError) throw error;
        let exact: 'committed' | 'absent' | 'unknown' = 'unknown';
        try {
          exact = await options.store.readExactCommit(g.writer, write);
        } catch {
          /* stop the cached Host */
        }
        if (exact === 'committed') return;
        quarantine(g, 'ack_unknown');
        failure('ack_unknown');
      }
    })();
    g.writes.add(task);
    void task.finally(() => g.writes.delete(task)).catch(() => undefined);
    return task;
  }
  function update<C extends NativeScheduleAnyControl>(
    g: Generation,
    c: C,
    change: Partial<C>,
  ) {
    g.controls.set(c.controlId, { ...c, ...change });
  }
  function taskControl(
    g: Generation,
    id: string,
    value: unknown,
    loading: boolean,
  ) {
    let task: ScheduleTask;
    try {
      task = g.host!.decodeTask(value);
    } catch {
      return failure('task_invalid');
    }
    const c = [...g.controls.values()].find(
      (row) => row.controlSessionId === task.sessionId,
    );
    if (c?.kind === 'recurring') {
      const history =
        task.deliveryHistory?.records ??
        (task.lastDelivery ? [task.lastDelivery] : []);
      if (
        !isDeepStrictEqual(task, value) ||
        task.record.id !== id ||
        task.record.title !== TITLE ||
        task.record.prompt !== PROMPT ||
        task.status !== 'active' ||
        c.sessionState !== 'ready' ||
        c.taskDeleted ||
        (c.nativeTaskId !== id &&
          (loading ||
            c.nativeTaskId !== null ||
            c.command.kind !== 'create' ||
            c.command.status !== 'pending')) ||
        !(
          (c.appliedRule &&
            recurringRecordMatches(task.record, c.appliedRule)) ||
          (c.command.status === 'pending' &&
            ['create', 'update'].includes(c.command.kind) &&
            recurringRecordMatches(task.record, c.rule))
        ) ||
        history.length > 200 ||
        history.some(
          (receipt, index) =>
            ('prompt' in receipt &&
              receipt.prompt !== undefined &&
              receipt.prompt !== PROMPT) ||
            (index > 0 &&
              Date.parse(receipt.scheduledAt) <
                Date.parse(history[index - 1]!.scheduledAt)),
        )
      )
        failure('task_invalid');
      return { task, control: c };
    }
    if (
      !c ||
      task.record.id !== id ||
      task.record.kind !== 'at' ||
      task.record.title !== TITLE ||
      task.record.prompt !== PROMPT ||
      task.record.scheduledAt !== c.at ||
      (task.lastDelivery && task.lastDelivery.scheduledAt !== c.at) ||
      (task.deliveryHistory &&
        (task.deliveryHistory.records.length > 1 ||
          task.deliveryHistory.records.some(
            (receipt) =>
              receipt.scheduledAt !== c.at ||
              (receipt.prompt !== undefined && receipt.prompt !== PROMPT),
          ))) ||
      (task.lastDelivery
        ? task.status !== 'inactive'
        : task.status !== 'active') ||
      c.sessionState !== 'ready' ||
      c.taskDeleted ||
      (c.nativeTaskId !== id &&
        (loading ||
          c.nativeTaskId !== null ||
          c.command.kind !== 'create' ||
          c.command.status !== 'pending'))
    )
      failure('task_invalid');
    return { task, control: c! };
  }
  function backend(g: Generation): StorageBackend {
    let opened = false,
      closed = false,
      unitClosed = false;
    const pending = new Set<Promise<unknown>>();
    function operation<T>(work: () => Promise<T>) {
      if (closed || unitClosed)
        return Promise.reject(new NativeScheduleOnceError('closed'));
      const task = Promise.resolve().then(work);
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => undefined);
      return task;
    }
    return {
      kv: {
        async open(descriptor) {
          if (
            closed ||
            opened ||
            descriptor.name !== 'schedule' ||
            descriptor.version !== 1 ||
            descriptor.hasGlobal ||
            descriptor.tables.length !== 1 ||
            descriptor.tables[0] !== 'tasks' ||
            (descriptor.layout && descriptor.layout !== 'single')
          )
            failure('task_invalid');
          opened = true;
          const unit: KvUnit = {
            loadAll: () =>
              operation(async () => {
                await fenced(g);
                const rows = await options.store.loadTaskRecords(g.writer);
                if (Object.keys(rows).length > MAX_CONTROLS)
                  failure('task_invalid');
                for (const [id, value] of Object.entries(rows))
                  taskControl(g, id, value, true);
                for (const c of g.controls.values())
                  if (
                    c.nativeTaskId !== null &&
                    !c.taskDeleted &&
                    !Object.hasOwn(rows, c.nativeTaskId)
                  )
                    failure('task_invalid');
                await fenced(g);
                return {
                  tables: { tasks: structuredClone(rows) },
                  global: null,
                };
              }),
            putRecord: (table, id, value) =>
              operation(async () => {
                if (table !== 'tasks') failure('task_invalid');
                try {
                  const { task, control } = taskControl(g, id, value, false);
                  await mutate(g, {
                    kind: 'put_task',
                    controlId: control.controlId,
                    task,
                  });
                  update(g, control, { nativeTaskId: id });
                } catch (error) {
                  quarantine(
                    g,
                    error instanceof NativeScheduleOnceError
                      ? error.code
                      : 'task_invalid',
                  );
                  throw error;
                }
              }),
            deleteRecord: (table, id) =>
              operation(async () => {
                const c = [...g.controls.values()].find(
                  (row) => row.nativeTaskId === id,
                );
                if (
                  table !== 'tasks' ||
                  !c ||
                  c.command.kind !== 'delete' ||
                  c.command.status !== 'pending'
                )
                  failure('task_invalid');
                await mutate(g, {
                  kind: 'delete_task',
                  controlId: c!.controlId,
                  nativeTaskId: id,
                });
                update(g, c!, { taskDeleted: true });
              }),
            async setGlobal() {
              failure('task_invalid');
            },
            async close() {
              unitClosed = true;
              await Promise.allSettled([...pending]);
            },
          };
          return unit;
        },
      },
      async close() {
        closed = true;
        await Promise.allSettled([...pending]);
      },
    };
  }

  function auxiliaryBackend(g: Generation): StorageBackend {
    // This capability belongs to one immutable generation; never consult a
    // mutable global writer or accept identity from a KV payload/stateRoot.
    const writer = g.writer;
    if (!Object.isFrozen(writer)) failure('binding_invalid');
    let opened = false,
      closed = false,
      unitClosed = false;
    let cached: NativeScheduleWorkspaceSnapshot | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    let closing: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const operation = <T>(work: () => Promise<T>): Promise<T> => {
      if (closed || unitClosed)
        return Promise.reject(new NativeScheduleOnceError('closed'));
      const task = tail.then(async () => {
        try {
          await fenced(g);
          const value = await work();
          await fenced(g);
          return value;
        } catch (error) {
          const code =
            error instanceof NativeScheduleOnceError
              ? error.code
              : 'auxiliary_write_unknown';
          quarantine(g, code);
          throw error instanceof NativeScheduleOnceError
            ? error
            : new NativeScheduleOnceError('auxiliary_write_unknown');
        }
      });
      tail = task.catch(() => undefined);
      pending.add(task);
      const tracked = task.then(() => undefined);
      g.writes.add(tracked);
      void task.finally(() => pending.delete(task)).catch(() => undefined);
      void tracked
        .finally(() => g.writes.delete(tracked))
        .catch(() => undefined);
      return task;
    };
    const context = async () => ({
      schemas: (await options.source.loadModules()).workspace,
      known: new Set([...g.controls.values()].map((c) => c.controlSessionId)),
      stateRoot: options.source.reference.stateRoot,
    });
    const load = async () => {
      const c = await context();
      const value = workspaceSnapshot(
        await options.store.loadWorkspaceUnit(writer),
        c.schemas,
        c.stateRoot,
        c.known,
      );
      if (cached && digest(cached) !== digest(value)) workspaceInvalid();
      cached = value;
      return structuredClone(value);
    };
    const write = (
      make: (
        c: Awaited<ReturnType<typeof context>>,
      ) => NativeScheduleWorkspaceMutation,
    ) =>
      operation(async () => {
        if (!cached) await load();
        const c = await context(),
          before = cached!;
        if (before.revision >= Number.MAX_SAFE_INTEGER) workspaceInvalid();
        const mutation = make(c);
        const after = structuredClone(before);
        if (mutation.kind === 'put_record')
          after.tables.workspaces[mutation.key] = mutation.value;
        else if (mutation.kind === 'delete_record')
          delete after.tables.workspaces[mutation.key];
        else after.global = mutation.value;
        after.revision++;
        workspaceSnapshot(after, c.schemas, c.stateRoot, c.known);
        const envelope = {
          entryKind: 'workspace',
          unitVersion: 2,
          expectedRevision: before.revision,
          mutation,
        };
        workspaceJson(envelope, WORKSPACE_WRITE_BYTES, 20, 80_000);
        const submitted: NativeScheduleWorkspaceWrite = {
          writeId: randomUUID(),
          digest: digest(envelope),
          expectedRevision: before.revision,
          mutation,
        };
        // Submit exactly once. SQL owns COMMIT ACK/exact proof; a thrown or
        // malformed outcome quarantines, never reloads/rekeys/replays this write.
        const result = await options.store.commitWorkspaceWrite(
          writer,
          submitted,
        );
        try {
          const ack = workspaceKeys(result, ['revision']);
          if (ack.revision !== after.revision) workspaceInvalid();
        } catch {
          throw new NativeScheduleOnceError('auxiliary_write_unknown');
        }
        cached = after;
      });
    return {
      kv: {
        async open(descriptor) {
          try {
            workspaceJson(descriptor, 1024, 4, 20);
            workspaceKeys(
              descriptor,
              ['name', 'version', 'tables', 'hasGlobal'],
              ['layout'],
            );
            if (
              closed ||
              opened ||
              descriptor.name !== 'workspace' ||
              descriptor.version !== 2 ||
              descriptor.hasGlobal !== true ||
              !Array.isArray(descriptor.tables) ||
              descriptor.tables.length !== 1 ||
              descriptor.tables[0] !== 'workspaces' ||
              (descriptor.layout !== undefined &&
                descriptor.layout !== 'single')
            )
              workspaceInvalid();
            opened = true;
          } catch (error) {
            quarantine(g, 'auxiliary_invalid');
            throw error;
          }
          const unit: KvUnit = {
            loadAll: () =>
              operation(async () => {
                const snapshot = await load();
                return { tables: snapshot.tables, global: snapshot.global };
              }),
            putRecord: (table, key, value) =>
              write((c) => {
                if (table !== 'workspaces') workspaceInvalid();
                workspaceString(key, 64);
                if (['__proto__', 'constructor', 'prototype'].includes(key))
                  workspaceInvalid();
                return {
                  kind: 'put_record',
                  table,
                  key,
                  value: workspaceRecord(
                    value,
                    c.schemas,
                    c.stateRoot,
                    c.known,
                  ),
                };
              }),
            deleteRecord: (table, key) =>
              write(() => {
                if (table !== 'workspaces') workspaceInvalid();
                workspaceString(key, 64);
                if (['__proto__', 'constructor', 'prototype'].includes(key))
                  workspaceInvalid();
                return { kind: 'delete_record', table, key };
              }),
            setGlobal: (value) =>
              write((c) => ({
                kind: 'set_global',
                value: workspaceGlobal(value, c.schemas, c.known),
              })),
            async close() {
              unitClosed = true;
              await Promise.allSettled([...pending]);
            },
          };
          return unit;
        },
      },
      close() {
        closed = true;
        closing ??= (async () => {
          await Promise.allSettled([...pending]);
        })();
        return closing;
      },
    };
  }

  function closeGeneration(g: Generation) {
    g.admitting = false;
    if (g.timer) clearTimeout(g.timer);
    g.closing ??= Promise.resolve().then(async () => {
      try {
        const host = g.host ?? (await g.opening?.catch(() => undefined));
        await host?.close();
        await g.backend.close();
        await g.auxiliaryBackend.close();
        // Non-KV session/command CAS may still be in flight during public shutdown.
        await Promise.allSettled([...g.writes]);
        await options.store.releaseClosedWriter(g.writer);
        g.closed = true;
      } catch {
        terminal = true;
        g.fault = 'shutdown_failed';
        lastFault = 'shutdown_failed';
        await Promise.allSettled([
          g.backend.close(),
          g.auxiliaryBackend.close(),
        ]);
        failure('shutdown_failed');
      }
    });
    return g.closing;
  }
  async function prepare(g: Generation, c: NativeScheduleAnyControl) {
    await fenced(g, true);
    if (c.sessionState === 'reserved') {
      await mutate(g, { kind: 'session_initializing', controlId: c.controlId });
      update(g, c, { sessionState: 'initializing' });
      await g.host!.initializeSession(c.controlSessionId);
    } else {
      try {
        await g.host!.resumeSession(c.controlSessionId);
      } catch {
        failure('history_missing');
      } // no fresh Session fallback, even half-initialized
    }
    await fenced(g, true);
    if (c.sessionState !== 'ready') {
      await mutate(g, { kind: 'session_ready', controlId: c.controlId });
      update(g, g.controls.get(c.controlId)!, { sessionState: 'ready' });
    }
  }
  async function start() {
    const sentAt = now(),
      grant = await options.store.acquireWriter();
    if (!grant) return;
    const g: Generation = {
      writer: Object.freeze(structuredClone(grant.writer)),
      controls: new Map(),
      deadline: 0,
      backend: { async close() {} },
      auxiliaryBackend: { async close() {} },
      admitting: true,
      closed: false,
      ready: false,
      writes: new Set(),
    };
    current = g;
    try {
      g.controls = controlsMap(grant.controls);
      if (digest(grant.reference) !== digest(options.source.reference))
        failure('binding_invalid');
      deadline(g, sentAt, grant.remainingMs);
      g.backend = backend(g);
      g.auxiliaryBackend = auxiliaryBackend(g);
      await fenced(g, true);
      g.opening = Promise.resolve().then(() =>
        (options.hostFactory ?? openPublicNativeScheduleOnceHost)({
          source: options.source,
          backend: g.backend,
          auxiliaryBackend: g.auxiliaryBackend,
          stats,
        }),
      );
      g.host = await g.opening;
      await fenced(g, true);
      await g.host.boot();
      for (const c of [...g.controls.values()]) await prepare(g, c);
      await fenced(g, true);
      await g.host.mountSchedule(); // every SDK Session is already owned/restored
      locallyLive(g, true);
      g.ready = true;
    } catch (error) {
      quarantine(
        g,
        error instanceof NativeScheduleOnceError ? error.code : 'host_failed',
      );
      await closeGeneration(g);
      throw error;
    }
  }
  async function refresh(g: Generation) {
    await fenced(g, true);
    const sentAt = now(),
      renewed = await options.store.renewWriter(g.writer);
    if (!renewed || identity(renewed.writer) !== identity(g.writer))
      return failure('lease_lost');
    locallyLive(g, true);
    deadline(g, sentAt, renewed.remainingMs);
    const fresh = controlsMap(await options.store.loadControls(g.writer));
    const keys = (rows: Map<string, NativeScheduleAnyControl>) =>
      digest(
        [...rows.values()]
          .map(controlIdentity)
          .sort((a, b) => a.controlId.localeCompare(b.controlId)),
      );
    if (keys(fresh) !== keys(g.controls)) {
      await closeGeneration(g);
      current = undefined;
      return false;
    }
    for (const [id, c] of fresh) {
      const previous = g.controls.get(id)!;
      if (
        previous.nativeTaskId !== null &&
        previous.nativeTaskId !== c.nativeTaskId
      )
        failure('binding_invalid');
    }
    g.controls = fresh;
    return true;
  }
  async function commands(g: Generation) {
    for (const c of [...g.controls.values()]) {
      if (c.command.status !== 'pending') continue;
      await fenced(g, true);
      const catalog = await g.host!.catalog();
      let id = c.nativeTaskId;
      if (c.command.kind === 'create') {
        if (id === null) {
          try {
            await fenced(g, true);
            if (c.kind === 'recurring') {
              const createRecurring = g.host!.createRecurring;
              if (!createRecurring) return failure('binding_invalid');
              id = (
                await createRecurring.call(g.host, c.controlSessionId, c.rule)
              ).id;
            } else id = (await g.host!.createOnce(c.controlSessionId, c.at)).id;
          } catch (error) {
            if (
              c.kind === 'recurring' ||
              !(
                error instanceof NativeScheduleOnceError &&
                error.code === 'target_not_future'
              )
            )
              throw error;
            await fenced(g, true);
            const observedCatalog = await g.host!.catalog();
            if (!Array.isArray(observedCatalog)) failure('task_invalid');
            for (const task of observedCatalog)
              if (
                !task ||
                typeof task.id !== 'string' ||
                !task.id ||
                typeof task.sessionId !== 'string' ||
                !task.sessionId ||
                (task.status !== 'active' && task.status !== 'inactive') ||
                task.sessionId === c.controlSessionId
              )
                failure('task_invalid');
            await fenced(g, true);
            await mutate(g, {
              kind: 'reject_command',
              controlId: c.controlId,
              commandId: c.command.id,
              reason: 'target_not_future',
              absence: {
                controlSessionId: c.controlSessionId,
                catalogDigest: digest(observedCatalog),
                observedAt: new Date(Date.now()).toISOString(),
                taskCount: 0,
              },
            });
            update(g, g.controls.get(c.controlId)!, {
              command: { ...c.command, status: 'blocked' },
            });
            continue;
          }
          if (g.controls.get(c.controlId)?.nativeTaskId !== id)
            failure('binding_invalid');
        } else {
          const saved = catalog.find((task) => task.id === id);
          if (
            !saved ||
            saved.sessionId !== c.controlSessionId ||
            (c.kind === 'recurring'
              ? !recurringRecordMatches(saved, c.rule)
              : saved.kind !== 'at' || saved.scheduledAt !== c.at) ||
            saved.title !== TITLE ||
            saved.prompt !== PROMPT
          )
            failure('task_invalid');
        }
      } else if (c.command.kind === 'update' && c.kind === 'recurring') {
        const saved = catalog.find((task) => task.id === id);
        if (
          !saved ||
          saved.sessionId !== c.controlSessionId ||
          saved.status !== 'active' ||
          saved.title !== TITLE ||
          saved.prompt !== PROMPT ||
          id === null ||
          c.taskDeleted ||
          !g.host!.updateRecurring
        )
          return failure('task_invalid');
        const expected: ScheduleRecord & {
          -readonly [
            K in 'sessionId' | 'status' | 'lastDelivery'
          ]?: ScheduleCatalogEntry[K];
        } = { ...saved };
        delete expected.sessionId;
        delete expected.status;
        delete expected.lastDelivery;
        await fenced(g, true);
        const changed = await g.host!.updateRecurring(
          c.controlSessionId,
          id,
          expected,
          c.rule,
        );
        // Only the SDK's explicit non-mutating conflict can defer to a fresh tick.
        if (changed === null) continue;
        if (
          changed.id !== id ||
          changed.title !== TITLE ||
          changed.prompt !== PROMPT ||
          !recurringRecordMatches(changed, c.rule) ||
          g.controls.get(c.controlId)?.nativeTaskId !== id
        )
          failure('task_invalid');
      } else if (id !== null && !c.taskDeleted) {
        if (
          !catalog.some(
            (task) => task.id === id && task.sessionId === c.controlSessionId,
          )
        )
          failure('task_invalid');
        await fenced(g, true);
        await g.host!.deleteOnce(c.controlSessionId, id);
        if (!g.controls.get(c.controlId)?.taskDeleted)
          failure('binding_invalid');
      }
      await mutate(g, {
        kind: 'confirm_command',
        controlId: c.controlId,
        commandId: c.command.id,
        nativeTaskId: id,
      });
      update(g, g.controls.get(c.controlId)!, {
        command: { ...c.command, status: 'confirmed' },
        ...(c.kind === 'recurring' && c.command.kind !== 'delete'
          ? {
              appliedRevision: c.revision,
              appliedRule: structuredClone(c.rule),
            }
          : {}),
      });
    }
  }
  async function runTick() {
    if (options.enabled !== true || stopped || terminal) return;
    try {
      if (current?.closing) {
        await current.closing;
        current = undefined;
      }
      if (!current) await start();
      else if (!(await refresh(current))) return;
      if (current) {
        locallyLive(current, true);
        await commands(current);
      }
    } catch (error) {
      const g = current;
      if (g) {
        quarantine(
          g,
          error instanceof NativeScheduleOnceError ? error.code : 'host_failed',
        );
        await closeGeneration(g);
      }
      throw error;
    }
  }
  return {
    tick() {
      const pending = queue.then(runTick);
      queue = pending.catch(() => undefined);
      return pending;
    },
    async stop() {
      stopped = true;
      const g = current;
      if (g) await closeGeneration(g);
      await queue;
    },
    status() {
      return {
        state:
          options.enabled !== true
            ? 'disabled'
            : terminal
              ? 'blocked'
              : stopped
                ? 'closed'
                : current?.fault
                  ? 'quarantined'
                  : current?.closed || !current
                    ? 'cold'
                    : current.ready
                      ? 'active'
                      : 'starting',
        fault: lastFault,
        stats: { ...stats },
      };
    },
  };
}
