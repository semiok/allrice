import { randomUUID, createHash } from 'node:crypto';
import {
  assertReferenceSelections,
  retrieveReferenceKnowledgeInTransaction,
  ReferenceRuntimeError,
} from '../reference-runtime.ts';
import {
  EmployeeContentManifestSchema,
  EmployeeRuntimeContentSchema,
  EmployeeSceneReadSchema,
  EmployeeSceneStateSchema,
  ReferenceReadSchema,
  ReferenceReadsSchema,
  type ReferenceRead,
  type KnowledgeRetrievalResult,
  type EmployeeRuntimeContent,
  type EmployeeResolvedContent,
  type EmployeeInstanceSnapshot,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { ZodError } from 'zod';
import {
  getContentAccess,
  readContentPrincipal,
  type ContentIdentity,
} from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  getEmployeeInstance,
  readEmployeeVersionPublication,
} from './employee-instances.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';
import {
  contentOwnership,
  type ContentSetRow,
  type ContentSql,
  type ContentTx,
} from './employee-content-model.ts';
import { freezeEmployeeRuntimeContent } from './employee-content.ts';
import { employeeRuntimeScenes } from './employee-runtime-scenes.ts';

export class EmployeeRuntimeContentError extends Error {
  readonly code = 'EMPLOYEE_CONTENT_UNAVAILABLE';
  constructor() {
    super('工作要求或其引用资料已失效，请确认当前版本后重新发起任务。');
  }
}
const unavailable = () => {
  throw new EmployeeRuntimeContentError();
};
export const employeeContentReferenceKey = (
  ref: EmployeeRuntimeContent['layers'][number]['common'][number],
) => `${ref.sourceKind}:${ref.contentId}:${ref.revisionId}:${ref.digest}`;

/** Prepare the current binding separately from historical snapshot readers. */
export async function prepareEmployeeRuntimeContent(
  context: ContentIdentity,
  input: {
    instance: EmployeeInstanceSnapshot;
    employeeId: string;
    employeeVersionId: string;
  },
) {
  const content = await freezeEmployeeRuntimeContent(context, {
    instanceId: input.instance.id,
    employeeId: input.employeeId,
    employeeVersionId: input.employeeVersionId,
  });
  await readEmployeeRuntimeContent(context, content);
  return content;
}

/** No mutable assignment pointer, draft or stored DTO body is a runtime source.
 * Current authority is checked independently of the immutable version pin. */
export async function readEmployeeRuntimeContent(
  context: ContentIdentity,
  raw: unknown,
  sql: ContentSql = getDatabase(),
  instanceOwnerId?: string,
  lock = false,
  selectedSceneIds: readonly string[] = [],
) {
  const parsed = EmployeeRuntimeContentSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  const snapshot = parsed.data;
  const { checksum, ...index } = snapshot;
  if (runtimePolicyDigest(index) !== checksum) return unavailable();
  let scenes;
  try {
    scenes = employeeRuntimeScenes(snapshot);
  } catch {
    return unavailable();
  }
  if (selectedSceneIds.some((id) => !scenes.some((s) => s.id === id)))
    return unavailable();
  try {
    const instance = await getEmployeeInstance(
      instanceOwnerId
        ? {
            actor: { type: 'user', id: instanceOwnerId },
            organizationId: context.organizationId,
            workspaceId: context.workspaceId,
          }
        : context,
      snapshot.instanceId,
      sql,
    );
    const [version] = await sql<
      { config_checksum: string }[]
    >`select v.config_checksum
      from allrice_employee_assignments a join allrice_employee_versions v on v.employee_id=a.employee_id
      where a.id=${instance.assignmentId} and a.employee_id=${snapshot.employeeId}
        and v.id=${snapshot.employeeVersionId} and v.organization_id=${context.organizationId} and v.workspace_id=${context.workspaceId}`;
    if (!version) return unavailable();
    const publication = await readEmployeeVersionPublication(
      {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId!,
        employeeId: snapshot.employeeId,
        versionId: snapshot.employeeVersionId,
      },
      sql,
    );
    if (
      snapshot.platform.revisionId
        ? publication?.revision_id !== snapshot.platform.revisionId ||
          publication.checksum !== snapshot.platform.digest
        : !!publication || version.config_checksum !== snapshot.platform.digest
    )
      return unavailable();
    const sources = new Map<string, EmployeeResolvedContent>();
    const identities = new Map<string, string>();
    const layerIds = new Set<string>();
    for (const layer of snapshot.layers) {
      if (layerIds.has(layer.setId)) return unavailable();
      layerIds.add(layer.setId);
      const [row] = await sql<
        (ContentSetRow & { manifest: unknown; digest: string })[]
      >`
        select s.*,r.manifest,r.digest from allrice_employee_content_sets s
        join allrice_employee_content_revisions r on r.set_id=s.id and r.id=${layer.revisionId}
        join allrice_employee_content_publications p on p.set_id=s.id and p.revision_id=r.id and p.invalidated_at is null
        where s.id=${layer.setId} and s.organization_id=${context.organizationId} and s.workspace_id=${context.workspaceId}
          and s.employee_id=${snapshot.employeeId}
          and (s.instance_id is null or s.instance_id=${snapshot.instanceId}) ${lock ? sql`for share of s,p` : sql``}`;
      if (
        !row ||
        row.digest !== layer.digest ||
        runtimePolicyDigest(contentOwnership(row)) !==
          runtimePolicyDigest(layer.ownership) ||
        !(await getContentAccess(context, contentOwnership(row), sql, lock))
          .canRead
      )
        return unavailable();
      const manifest = EmployeeContentManifestSchema.parse(row.manifest);
      const selected = [
        ...layer.common,
        ...(layer.scenes ?? [])
          .filter((s) => selectedSceneIds.includes(s.id))
          .flatMap((s) => s.references),
      ];
      if (
        runtimePolicyDigest(manifest) !== row.digest ||
        runtimePolicyDigest(manifest.common) !==
          runtimePolicyDigest(layer.common) ||
        (layer.scenes !== undefined &&
          runtimePolicyDigest(manifest.scenes) !==
            runtimePolicyDigest(layer.scenes)) ||
        manifest.declaredConflicts.some((c) =>
          c.contentIds.some((id) => selected.some((r) => r.contentId === id)),
        )
      )
        return unavailable();
      for (const ref of selected) {
        const key = employeeContentReferenceKey(ref),
          identity = `${ref.sourceKind}:${ref.contentId}`;
        if (identities.has(identity) && identities.get(identity) !== key)
          return unavailable();
        identities.set(identity, key);
        // Check each layer even for a repeated source; readability by a private
        // owner must not authorize a wider company reference.
        const source = await resolveEmployeeContentSource({
          context,
          employeeId: snapshot.employeeId,
          ownership: layer.ownership,
          ref,
          sql,
          lock,
          allowDraft: false,
          frozenPublication: true,
        });
        if (!source.dto.available || source.issue) return unavailable();
        sources.set(key, source.dto);
      }
    }
    if (
      sources.size > 128 ||
      [...sources.values()].reduce(
        (n, s) => n + Buffer.byteLength(s.body ?? ''),
        0,
      ) > 32_000
    )
      return unavailable();
    return { snapshot, scenes, sources: [...sources.values()] };
  } catch (error) {
    if (error instanceof EmployeeRuntimeContentError) throw error;
    if (error instanceof DataAccessError || error instanceof ZodError)
      return unavailable();
    // A transient database error stops dispatch, but is not evidence that
    // previously authorized context has been revoked.
    throw error;
  }
}

export async function assertEmployeeContentAdmission(
  sql: ContentSql,
  context: ContentIdentity,
  raw: EmployeeRuntimeContent,
) {
  // Queue already holds the final principal lock. This precedes assignment
  // and Session locks, matching content publication's established order.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${context.organizationId}`},0))`;
  const current = await freezeEmployeeRuntimeContent(
    context,
    {
      instanceId: raw.instanceId,
      employeeId: raw.employeeId,
      employeeVersionId: raw.employeeVersionId,
    },
    sql,
  );
  if (current.checksum !== raw.checksum) return unavailable();
  await readEmployeeRuntimeContent(context, raw, sql);
}

type RunScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  sessionId: string;
  runId: string;
};
type ContentContextRow = {
  generation_id: string;
  history_from_message_id: string | null;
  invalidated_at: Date | null;
};
type RunRow = {
  content: unknown;
  content_scene_state: unknown;
  content_generation_id: string | null;
  user_message_id: string;
  reference_selections: unknown;
  reference_reads: unknown;
  user_request: string;
  session_references:
    { sessionId: string; messages: { id: string }[] }[] | null;
};
function identity(scope: RunScope): ContentIdentity {
  return {
    actor: { type: 'user', id: scope.ownerId },
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
  };
}
async function ownedRun(scope: RunScope, sql: ContentSql) {
  const [row] = await sql<
    RunRow[]
  >`select er.execution_snapshot->'content' as content,
      er.content_generation_id,er.content_scene_state,er.reference_reads,er.prompt_snapshot->>'userRequest' as user_request,er.user_message_id,er.prompt_snapshot->'sessionReferences' as session_references,er.prompt_snapshot->'referenceSelections' as reference_selections
    from allrice_employee_runs er join allrice_chat_sessions s on s.id=er.session_id
    where er.run_id=${scope.runId} and er.session_id=${scope.sessionId}
      and er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId} and er.owner_id=${scope.ownerId}
      and s.owner_id=er.owner_id and s.organization_id=er.organization_id and s.workspace_id=er.workspace_id and s.archived_at is null`;
  if (!row) return unavailable();
  return row;
}

/** Discover immutable dependencies before acquiring locks. Never acquire a new
 * owner's principal or an out-of-order context lock during recursive reading. */
async function contentGraph(scope: RunScope, sql: ContentSql) {
  const run = await ownedRun(scope, sql);
  const [root] = run.content_generation_id
    ? await sql`select generation_id from allrice_employee_content_contexts where generation_id=${run.content_generation_id}`
    : await sql`select generation_id from allrice_employee_content_contexts where session_id=${scope.sessionId} and invalidated_at is null`;
  const pending = new Set<string>(root ? [root.generation_id] : []);
  const owners = new Set([scope.ownerId]),
    instances = new Set<string>(),
    sessions = new Set([scope.sessionId]),
    messages = new Set<string>();
  const nodes = new Map<string, unknown>();
  const add = async (row: Pick<RunRow, 'content' | 'session_references'>) => {
    if (row.content) {
      const parsed = EmployeeRuntimeContentSchema.safeParse(row.content);
      if (!parsed.success) return unavailable();
      instances.add(parsed.data.instanceId);
    }
    for (const ref of row.session_references ?? []) {
      sessions.add(ref.sessionId);
      const ids = ref.messages.map((m) => m.id);
      for (const id of ids) messages.add(id);
      if (!ids.length) continue;
      const refs = await sql<{ content_generation_id: string | null }[]>`
        select distinct er.content_generation_id from allrice_messages m
        join allrice_employee_runs er on er.session_id=m.session_id and (er.user_message_id=m.id or er.assistant_message_id=m.id)
        where m.session_id=${ref.sessionId} and m.id in ${sql(ids)} and er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId}`;
      for (const ref of refs)
        if (ref.content_generation_id) pending.add(ref.content_generation_id);
    }
  };
  await add(run);
  for (const id of pending) {
    if (nodes.size >= 128) return unavailable();
    const [context] =
      await sql`select generation_id,owner_id,session_id from allrice_employee_content_contexts
      where generation_id=${id} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}`;
    if (!context) return unavailable();
    owners.add(context.owner_id);
    sessions.add(context.session_id);
    const rows = await sql<
      Pick<
        RunRow,
        | 'content'
        | 'content_scene_state'
        | 'session_references'
        | 'reference_selections'
        | 'reference_reads'
      >[]
    >`
      select distinct execution_snapshot->'content' as content,content_scene_state,reference_reads,prompt_snapshot->'sessionReferences' as session_references,prompt_snapshot->'referenceSelections' as reference_selections
      from allrice_employee_runs where content_generation_id=${id} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and error_code is distinct from 'STEER_CONSUMED' limit 129`;
    if (rows.length > 128) return unavailable();
    nodes.set(id, {
      context,
      references: rows.map(runtimePolicyDigest).sort(),
    });
    for (const row of rows) await add(row);
  }
  const assignments = instances.size
    ? await sql<{ id: string; assignment_id: string; owner_id: string }[]>`
    select id,assignment_id,owner_id from allrice_employee_instances where id in ${sql([...instances])}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} order by id`
    : [];
  for (const instance of assignments) owners.add(instance.owner_id);
  // Legacy imports have no content generation but still carry live Session
  // and message visibility. Discover their owners before principal locking.
  const sessionOwners = await sql<{ id: string; owner_id: string }[]>`
    select id,owner_id from allrice_chat_sessions where id in ${sql([...sessions])}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} order by id`;
  for (const session of sessionOwners) owners.add(session.owner_id);
  return {
    owners: [...owners].sort(),
    instances: [...instances].sort(),
    assignments: [...new Set(assignments.map((i) => i.assignment_id))].sort(),
    sessions: [...sessions].sort(),
    messages: [...messages].sort(),
    generations: [...nodes.keys()].sort(),
    checksum: runtimePolicyDigest({
      run,
      root: root?.generation_id ?? null,
      nodes: [...nodes].sort(([a], [b]) => a.localeCompare(b)),
      assignments,
      sessionOwners,
      messages: [...messages].sort(),
    }),
  };
}

async function withContentLocks<T>(
  scope: RunScope,
  operation: (tx: ContentTx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await getDatabase().begin(async (tx) => {
      const before = await contentGraph(scope, tx);
      for (const ownerId of before.owners)
        await readContentPrincipal(
          { ...identity(scope), actor: { type: 'user', id: ownerId } },
          tx,
          true,
        );
      await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
      if (before.assignments.length)
        await tx`select id from allrice_employee_assignments where id in ${tx(before.assignments)} order by id for share`;
      if (before.instances.length)
        await tx`select id from allrice_employee_instances where id in ${tx(before.instances)} order by id for share`;
      // Visibility writers lock the Session before its messages. Hold the
      // same order while later source reads may wait, including legacy imports.
      await tx`select id from allrice_chat_sessions where id in ${tx(before.sessions)} order by id for share`;
      if (before.messages.length)
        await tx`select id from allrice_messages where id in ${tx(before.messages)} order by id for share`;
      // A stable order also handles A→B and B→A imports without lock inversion.
      if (before.generations.length)
        await tx`select generation_id from allrice_employee_content_contexts where generation_id in ${tx(before.generations)} order by generation_id for update`;
      await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content-context:${scope.sessionId}`},0))`;
      if ((await contentGraph(scope, tx)).checksum !== before.checksum)
        return { retry: true as const };
      return { value: await operation(tx) };
    });
    if ('value' in result) return result.value as T;
  }
  return unavailable();
}
async function generationIsReadable(
  scope: RunScope,
  generationId: string,
  sql: ContentSql,
  reader: ContentIdentity = identity(scope),
  visited = new Set<string>(),
  locked = false,
) {
  if (visited.has(generationId)) return true;
  if (visited.size >= 128) return false;
  visited.add(generationId);
  const [generation] =
    await sql`select generation_id from allrice_employee_content_contexts
    where generation_id=${generationId} and session_id=${scope.sessionId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and invalidated_at is null`;
  if (!generation) return false;
  const rows = await sql<
    {
      content: unknown;
      content_scene_state: unknown;
      reference_selections: unknown;
      reference_reads: unknown;
      session_references:
        { sessionId: string; messages: { id: string }[] }[] | null;
    }[]
  >`
    select distinct execution_snapshot->'content' as content,content_scene_state,reference_reads,prompt_snapshot->'sessionReferences' as session_references,prompt_snapshot->'referenceSelections' as reference_selections
    from allrice_employee_runs where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and session_id=${scope.sessionId} and owner_id=${scope.ownerId} and content_generation_id=${generationId}
      and error_code is distinct from 'STEER_CONSUMED' limit 129`;
  // Bounded provenance; rotate before losing old dependencies. Never silently
  // truncate them while reusing a native summary derived from those sources.
  if (rows.length > 128) return false;
  for (const row of rows) {
    try {
      await assertReferenceSelections(
        reader,
        row.reference_selections,
        sql,
        locked,
      );
      const reads = ReferenceReadsSchema.parse(row.reference_reads ?? []);
      for (const read of reads)
        await assertReferenceSelections(
          reader,
          [read.citation.reference],
          sql,
          locked,
        );
      if (row.content) {
        const state = parseSceneState(row.content_scene_state);
        const scenes = employeeRuntimeScenes(
          EmployeeRuntimeContentSchema.parse(row.content),
        );
        if (
          state.reads.some(
            (r) =>
              !scenes.some(
                (s) => s.id === r.sceneId && s.digest === r.sceneDigest,
              ),
          )
        )
          return false;
        await readEmployeeRuntimeContent(
          reader,
          row.content,
          sql,
          scope.ownerId,
          locked,
          state.reads.map((r) => r.sceneId),
        );
      }
      for (const ref of row.session_references ?? [])
        await assertEmployeeContentReferenceMessages(
          reader,
          ref.sessionId,
          ref.messages.map((m) => m.id),
          sql,
          visited,
          locked,
        );
    } catch (error) {
      if (
        error instanceof EmployeeRuntimeContentError ||
        error instanceof ZodError ||
        error instanceof ReferenceRuntimeError
      )
        return false;
      throw error;
    }
  }
  return true;
}

/** Session imports retain a reference to their source's provenance instead of
 * laundering an old answer into untracked plaintext in a new generation. */
export async function assertEmployeeContentReferenceMessages(
  reader: ContentIdentity,
  sessionId: string,
  messageIds: string[],
  sql: ContentSql = getDatabase(),
  visited = new Set<string>(),
  locked = false,
) {
  if (!messageIds.length) return;
  const [session] = await sql<
    { owner_id: string }[]
  >`select owner_id from allrice_chat_sessions
    where id=${sessionId} and organization_id=${reader.organizationId} and workspace_id=${reader.workspaceId}
      and archived_at is null and (owner_id=${reader.actor.id} or visibility<>'private')`;
  if (!session) return unavailable();
  const messages = await sql<
    { id: string; content_generation_id: string | null }[]
  >`select m.id,er.content_generation_id
    from allrice_messages m left join allrice_employee_runs er on er.session_id=m.session_id
      and (er.user_message_id=m.id or er.assistant_message_id=m.id)
    where m.session_id=${sessionId} and m.id in ${sql(messageIds)}
      and m.organization_id=${reader.organizationId} and m.workspace_id=${reader.workspaceId}
      and (m.owner_id=${reader.actor.id} or m.visibility<>'private')`;
  if (new Set(messages.map((m) => m.id)).size !== new Set(messageIds).size)
    return unavailable();
  for (const generationId of new Set(
    messages.flatMap((m) =>
      m.content_generation_id ? [m.content_generation_id] : [],
    ),
  )) {
    const scope = {
      organizationId: reader.organizationId,
      workspaceId: reader.workspaceId!,
      ownerId: session.owner_id,
      sessionId,
      runId: '',
    };
    if (
      !(await generationIsReadable(
        scope,
        generationId,
        sql,
        reader,
        visited,
        locked,
      ))
    )
      return unavailable();
  }
}

/** Bind once per Run. A content generation outlives native process/config
 * changes. Its exact Run references cover text derived through compaction. */
export async function prepareEmployeeContentContext(scope: RunScope) {
  const result = await withContentLocks(scope, async (tx) => {
    const run = await ownedRun(scope, tx);
    if (!run.content) {
      if (
        Array.isArray(run.reference_selections) &&
        run.reference_selections.length
      )
        return unavailable();
      return null; // unchanged historical snapshots
    }
    try {
      await assertReferenceSelections(
        identity(scope),
        run.reference_selections,
        tx,
        true,
      );
    } catch (error) {
      if (error instanceof ReferenceRuntimeError || error instanceof ZodError)
        return unavailable();
      throw error;
    }
    const current = await readEmployeeRuntimeContent(
      identity(scope),
      run.content,
      tx,
      undefined,
      true,
    );
    // A short per-session provenance gate serializes two starts without taking
    // content-writer locks in the opposite order. It is never held over a model call.
    const [boundRun] = await tx<
      RunRow[]
    >`select content_generation_id from allrice_employee_runs where run_id=${scope.runId}`;
    run.content_generation_id = boundRun!.content_generation_id;
    let [context] = run.content_generation_id
      ? await tx<
          ContentContextRow[]
        >`select * from allrice_employee_content_contexts where generation_id=${run.content_generation_id} for update`
      : await tx<
          ContentContextRow[]
        >`select * from allrice_employee_content_contexts where session_id=${scope.sessionId} and invalidated_at is null for update`;
    if (run.content_generation_id && (!context || context.invalidated_at))
      return { rejected: true as const };
    let discardHistory = false;
    if (
      context &&
      !(await generationIsReadable(
        scope,
        context.generation_id,
        tx,
        identity(scope),
        new Set(),
        true,
      ))
    ) {
      await tx`update allrice_employee_content_contexts set invalidated_at=clock_timestamp(),updated_at=clock_timestamp() where generation_id=${context.generation_id}`;
      if (run.content_generation_id) return { rejected: true as const };
      context = undefined;
      discardHistory = true;
    }
    if (!context) {
      const [previous] =
        await tx`select generation_id from allrice_employee_content_contexts where session_id=${scope.sessionId} limit 1`;
      discardHistory ||= !!previous;
      [context] = await tx<
        ContentContextRow[]
      >`insert into allrice_employee_content_contexts
        (generation_id,organization_id,workspace_id,owner_id,session_id,history_from_message_id)
        values(${randomUUID()},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.sessionId},${discardHistory ? run.user_message_id : null}) returning *`;
    }
    await tx`update allrice_employee_runs set content_generation_id=${context!.generation_id}
      where run_id=${scope.runId} and content_generation_id is null`;
    const allowedMessages = context!.history_from_message_id
      ? await tx<{ id: string }[]>`select m.id from allrice_messages m
          join allrice_messages boundary on boundary.id=${context!.history_from_message_id} and boundary.session_id=m.session_id
          where m.session_id=${scope.sessionId} and m.organization_id=${scope.organizationId} and m.workspace_id=${scope.workspaceId}
            and m.created_at>=boundary.created_at
            and (m.id=${run.user_message_id} or exists(select 1 from allrice_employee_runs er
              where er.session_id=m.session_id and er.content_generation_id=${context!.generation_id}
                and (er.user_message_id=m.id or er.assistant_message_id=m.id))
              )`
      : null;
    // A new task must not inherit previous scene tool results or native
    // summaries. Ordinary visible messages retain their provenance above.
    const [priorScene] =
      await tx`select run_id from allrice_employee_runs where content_generation_id=${context!.generation_id} and (content_scene_state is not null or reference_reads is not null or jsonb_array_length(coalesce(prompt_snapshot->'referenceSelections','[]'::jsonb))>0) limit 1`;
    return {
      ...current,
      generationId: context!.generation_id,
      nativeContextKey:
        current.scenes.length ||
        current.sources.some((s) => s.referenceFile) ||
        priorScene
          ? `${context!.generation_id}-${scope.runId}`
          : context!.generation_id,
      historyFromMessageId: context!.history_from_message_id,
      allowedMessageIds: allowedMessages?.map((m) => m.id) ?? null,
    };
  });
  // Commit a failed generation before surfacing the error. Throwing within
  // the transaction would erase invalidation and permit an unsafe recovery.
  if (result && 'rejected' in result) return unavailable();
  return result;
}

type ContentWorker = { workerId: string; jobId: string; leaseToken: string };
function parseSceneState(raw: unknown) {
  const parsed = EmployeeSceneStateSchema.safeParse(raw ?? { reads: [] });
  if (
    !parsed.success ||
    new Set(parsed.data.reads.map((r) => r.sceneId)).size !==
      parsed.data.reads.length
  )
    return unavailable();
  if (
    parsed.data.adopted &&
    !parsed.data.reads.some(
      (r) =>
        r.receiptId === parsed.data.adopted!.receiptId &&
        r.sceneId === parsed.data.adopted!.sceneId &&
        r.sceneDigest === parsed.data.adopted!.sceneDigest,
    )
  )
    return unavailable();
  return parsed.data;
}
async function validContentLease(
  scope: RunScope,
  worker: ContentWorker | undefined,
  tx: ContentSql,
) {
  if (!worker) return true;
  const [lease] =
    await tx`select j.id from allrice_jobs j join allrice_runs r on r.id=j.run_id
        join allrice_conversation_runtimes cr on cr.session_id=${scope.sessionId} and cr.active_run_id=r.id and cr.worker_id=j.worker_id and cr.state='running'
        where j.id=${worker.jobId} and j.run_id=${scope.runId} and j.worker_id=${worker.workerId} and j.lease_token=${worker.leaseToken}
          and j.status='running' and j.lease_expires_at>clock_timestamp() and j.cancel_requested_at is null
          and r.organization_id=${scope.organizationId} and r.workspace_id=${scope.workspaceId} and r.owner_id=${scope.ownerId}`;
  return !!lease;
}

/** Store proof before excerpts leave this transaction. Stable identities use the
 * retained file, locator and actual text digest, never a rebuildable chunk ID. */
async function recordReferenceReads(
  tx: ContentSql,
  scope: RunScope,
  run: RunRow,
  generationId: string,
  worker: ContentWorker,
  groups: {
    origin: ReferenceRead['origin'];
    results: KnowledgeRetrievalResult[];
  }[],
) {
  const reads = ReferenceReadsSchema.parse(run.reference_reads ?? []);
  if (
    reads.some(
      (r) => r.runId !== scope.runId || r.generationId !== generationId,
    )
  )
    return unavailable();
  const before = reads.length;
  const results: KnowledgeRetrievalResult[] = [];
  for (const group of groups)
    for (const result of group.results) {
      if (!result.citation.reference) return unavailable();
      const checksum =
        'sha256:' + createHash('sha256').update(result.content).digest('hex');
      let receipt = reads.find(
        (r) =>
          r.citation.reference.digest === result.citation.reference!.digest &&
          r.citation.reference.revisionId ===
            result.citation.reference!.revisionId &&
          r.citation.reference.checksum ===
            result.citation.reference!.checksum &&
          runtimePolicyDigest(r.citation.locator) ===
            runtimePolicyDigest(result.citation.locator) &&
          r.contentChecksum === checksum,
      );
      if (!receipt) {
        if (reads.length >= 64) return unavailable();
        const id = randomUUID();
        receipt = ReferenceReadSchema.parse({
          receiptId: id,
          origin: group.origin,
          citation: {
            ...result.citation,
            id,
            referenceLabel: `R${reads.length + 1}`,
          },
          contentChecksum: checksum,
          runId: scope.runId,
          generationId,
          jobId: worker.jobId,
          workerId: worker.workerId,
          readAt: new Date().toISOString(),
        });
        reads.push(receipt);
      }
      if (!results.some((r) => r.citation.id === receipt!.receiptId))
        results.push({ content: result.content, citation: receipt.citation });
    }
  if (reads.length !== before)
    await tx`update allrice_employee_runs set reference_reads=${tx.json(reads)} where run_id=${scope.runId}`;
  return results;
}

/** Initial common and explicitly selected references share the existing content
 * authority, exact execution lease and native generation. No other scene is read. */
export async function loadEmployeeRuntimeReferences(
  scope: RunScope,
  generationId: string,
  worker: ContentWorker,
) {
  const result = await withContentLocks(scope, async (tx) => {
    const run = await ownedRun(scope, tx);
    if (
      run.content_generation_id !== generationId ||
      !(await validContentLease(scope, worker, tx))
    )
      return unavailable();
    if (
      !(await generationIsReadable(
        scope,
        generationId,
        tx,
        identity(scope),
        new Set(),
        true,
      ))
    ) {
      await tx`update allrice_employee_content_contexts set invalidated_at=clock_timestamp() where generation_id=${generationId}`;
      return { rejected: true as const };
    }
    const current = await readEmployeeRuntimeContent(
      identity(scope),
      run.content,
      tx,
      undefined,
      true,
    );
    const selections = await assertReferenceSelections(
      identity(scope),
      run.reference_selections,
      tx,
      true,
    );
    const explicit = await retrieveReferenceKnowledgeInTransaction(
      {
        context: identity(scope),
        selections,
        query: run.user_request,
        mode: 'explicit',
      },
      tx,
    );
    const common = await retrieveReferenceKnowledgeInTransaction(
      {
        context: identity(scope),
        selections: current.sources.flatMap((s) =>
          s.referenceFile &&
          !selections.some((p) => p.revisionId === s.referenceFile!.revisionId)
            ? [s.referenceFile]
            : [],
        ),
        query: run.user_request,
        mode: 'automatic',
      },
      tx,
    );
    const knowledge = await recordReferenceReads(
      tx,
      scope,
      run,
      generationId,
      worker,
      [
        { origin: { kind: 'explicit' }, results: explicit },
        { origin: { kind: 'common' }, results: common },
      ],
    );
    if (!(await validContentLease(scope, worker, tx))) return unavailable();
    return { knowledge };
  });
  if ('rejected' in result) return unavailable();
  return result.knowledge;
}

/** Worker completion reads committed receipts, including earlier attempts and
 * native scene loads. This is not a general-purpose reference lookup endpoint. */
export async function readEmployeeReferenceCitations(scope: RunScope) {
  const run = await ownedRun(scope, getDatabase());
  const reads = ReferenceReadsSchema.parse(run.reference_reads ?? []);
  if (
    reads.some(
      (r) =>
        r.runId !== scope.runId || r.generationId !== run.content_generation_id,
    )
  )
    return unavailable();
  return reads.map((r) => r.citation);
}

/** Every real model dispatch, including native compaction, uses this same gate.
 * Ordinary method publication does not invalidate a valid frozen revision. */
export async function assertEmployeeContentContext(
  scope: RunScope,
  generationId: string,
  worker?: { workerId: string; jobId: string; leaseToken: string },
) {
  const accepted = await withContentLocks(scope, async (tx) => {
    if (!(await validContentLease(scope, worker, tx))) return false;
    const run = await ownedRun(scope, tx);
    const [context] = await tx<
      ContentContextRow[]
    >`select * from allrice_employee_content_contexts where session_id=${scope.sessionId} and generation_id=${generationId} for update`;
    if (
      !context ||
      context.generation_id !== generationId ||
      run.content_generation_id !== generationId ||
      context.invalidated_at
    )
      return false;
    const readable = await generationIsReadable(
      scope,
      generationId,
      tx,
      identity(scope),
      new Set(),
      true,
    );
    // Row/source locks may have waited; a lease read before that wait is stale.
    if (!(await validContentLease(scope, worker, tx))) return false;
    if (readable) return true;
    await tx`update allrice_employee_content_contexts set invalidated_at=clock_timestamp(),updated_at=clock_timestamp() where generation_id=${generationId}`;
    return false;
  });
  if (!accepted) return unavailable();
}

/** Conservative read receipt is committed before a byte is returned to DSH.
 * Provider probes are reads, not adoption; retries recheck authority first. */
export async function loadEmployeeRuntimeScene(
  scope: RunScope,
  generationId: string,
  selection: { sceneId: string; sceneDigest: string },
  worker: ContentWorker,
) {
  const result = await withContentLocks(scope, async (tx) => {
    const run = await ownedRun(scope, tx);
    if (
      run.content_generation_id !== generationId ||
      !(await validContentLease(scope, worker, tx))
    )
      return unavailable();
    if (
      !(await generationIsReadable(
        scope,
        generationId,
        tx,
        identity(scope),
        new Set(),
        true,
      ))
    ) {
      await tx`update allrice_employee_content_contexts set invalidated_at=clock_timestamp() where generation_id=${generationId}`;
      return { rejected: true as const };
    }
    const snapshot = EmployeeRuntimeContentSchema.parse(run.content);
    const scene = employeeRuntimeScenes(snapshot).find(
      (s) => s.id === selection.sceneId && s.digest === selection.sceneDigest,
    );
    if (!scene) return unavailable();
    const state = parseSceneState(run.content_scene_state);
    if (state.adopted && state.adopted.sceneId !== scene.id)
      return unavailable();
    // Include every actual read for conflict and total-body limits. A failed
    // additional read never erases dependencies already exposed to the model.
    const selected = [
      ...new Set([...state.reads.map((r) => r.sceneId), scene.id]),
    ];
    const current = await readEmployeeRuntimeContent(
      identity(scope),
      snapshot,
      tx,
      undefined,
      true,
      selected,
    );
    if (!(await validContentLease(scope, worker, tx))) return unavailable();
    let receipt = state.reads.find((r) => r.sceneId === scene.id);
    if (!receipt) {
      receipt = EmployeeSceneReadSchema.parse({
        sceneId: scene.id,
        sceneDigest: scene.digest,
        receiptId: randomUUID(),
      });
      state.reads.push(receipt);
      await tx`update allrice_employee_runs set content_scene_state=${tx.json(state)} where run_id=${scope.runId}`;
    }
    const common = new Set(
      snapshot.layers.flatMap((l) => l.common).map(employeeContentReferenceKey),
    );
    const refs = new Set(
      snapshot.layers
        .flatMap((l) =>
          (l.scenes ?? [])
            .filter((s) => s.id === scene.id)
            .flatMap((s) => s.references),
        )
        .map(employeeContentReferenceKey),
    );
    const candidates = current.sources.filter((s) =>
      refs.has(employeeContentReferenceKey(s.reference)),
    );
    const results = await retrieveReferenceKnowledgeInTransaction(
      {
        context: identity(scope),
        selections: candidates.flatMap((s) =>
          s.referenceFile ? [s.referenceFile] : [],
        ),
        query: run.user_request,
        mode: 'automatic',
      },
      tx,
    );
    const knowledge = await recordReferenceReads(
      tx,
      scope,
      run,
      generationId,
      worker,
      [
        {
          origin: {
            kind: 'scene',
            sceneId: scene.id,
            sceneDigest: scene.digest,
          },
          results,
        },
      ],
    );
    // Index/source reads can wait as well; no data or receipt survives an expired lease.
    if (!(await validContentLease(scope, worker, tx))) return unavailable();
    return {
      scene,
      receipt,
      knowledge,
      sources: current.sources
        .filter(
          (s) =>
            refs.has(employeeContentReferenceKey(s.reference)) &&
            !common.has(employeeContentReferenceKey(s.reference)),
        )
        .sort((a, b) =>
          employeeContentReferenceKey(a.reference).localeCompare(
            employeeContentReferenceKey(b.reference),
          ),
        ),
    };
  });
  if ('rejected' in result) return unavailable();
  return result;
}

/** Called only after a matched successful native Skill tool result, before
 * another model dispatch. Different simultaneous adoptions poison that Run's
 * context; rollback must not accidentally permit its polluted native history. */
export async function adoptEmployeeRuntimeScene(
  scope: RunScope,
  generationId: string,
  evidence: {
    sceneId: string;
    sceneDigest: string;
    receiptId: string;
    nativeSessionId: string;
    callId: string;
  },
  worker: ContentWorker,
) {
  const adopted = EmployeeSceneStateSchema.shape.adopted
    .unwrap()
    .parse(evidence);
  const result = await withContentLocks(scope, async (tx) => {
    const run = await ownedRun(scope, tx);
    if (
      run.content_generation_id !== generationId ||
      !(await validContentLease(scope, worker, tx))
    )
      return unavailable();
    const state = parseSceneState(run.content_scene_state);
    if (
      !state.reads.some(
        (r) =>
          r.sceneId === adopted.sceneId &&
          r.sceneDigest === adopted.sceneDigest &&
          r.receiptId === adopted.receiptId,
      )
    )
      return unavailable();
    const readable = await generationIsReadable(
      scope,
      generationId,
      tx,
      identity(scope),
      new Set(),
      true,
    );
    if (!(await validContentLease(scope, worker, tx))) return unavailable();
    if (
      !readable ||
      (state.adopted && state.adopted.sceneId !== adopted.sceneId)
    ) {
      await tx`update allrice_employee_content_contexts set invalidated_at=clock_timestamp() where generation_id=${generationId}`;
      return { rejected: true as const };
    }
    if (!state.adopted) {
      state.adopted = adopted;
      await tx`update allrice_employee_runs set content_scene_state=${tx.json(state)} where run_id=${scope.runId}`;
    }
    return { adopted: state.adopted };
  });
  if ('rejected' in result) return unavailable();
  return result.adopted;
}
