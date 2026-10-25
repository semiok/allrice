import type postgres from 'postgres';
import { z } from 'zod';
import { getDatabase } from '../core/client.ts';
import {
  readDshRuntimeCloseCoverage,
  assertDshContextPhysicallyClosed,
} from '../providers/dsh-runtime-close-observations.ts';
import {
  NativeRootOriginSchema,
  nativeRootDigest,
  type NativeRootOrigin,
} from './native-root-origin.ts';
import {
  previewNativeChatTerminalCutoff,
  previewNativeChatAbandonedDescendantCutoff,
  applyNativeTerminalTestRetirement,
  readNativeTerminalTestRetirement,
  verifyNativeChatTerminalCutoffRow,
  verifyNativeChatAbandonedDescendantCutoffRow,
} from './native-terminal-test-retirement.ts';

type Tx = postgres.TransactionSql;
type Reader = postgres.Sql | Tx;
type ContextKind = NativeRootOrigin['contextKind'];
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// PostgreSQL UUID identity is case-insensitive; use that same canonical form
// for request locks, plan digests and receipt comparisons.
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const jsonValue: z.ZodType<postgres.JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const scopeSchema = z
  .object({
    contextKind: z.literal('chat'),
    contextId: uuid,
    organizationId: uuid,
    workspaceId: uuid,
    ownerId: uuid,
  })
  .strict();
export type NativeTestChatRetirementScope = z.infer<typeof scopeSchema>;
const fingerprint = z
  .object({
    count: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
const snapshotSchema = z
  .object({
    scope: scopeSchema,
    origin: NativeRootOriginSchema.nullable(),
    bindings: z.array(z.record(z.string(), jsonValue)),
    archived: z.boolean(),
    preservation: z.record(z.string(), fingerprint),
  })
  .strict();
const requestSchema = z
  .object({
    requestId: uuid,
    authorizationEvidenceDigest: digest,
    scopes: z.array(scopeSchema).min(1).max(50),
  })
  .strict();
const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('development-test-chat-retirement'),
    requestId: uuid,
    authorizationEvidenceDigest: digest,
    snapshots: z.array(snapshotSchema).min(1).max(50),
    digest,
  })
  .strict();
export type NativeTestChatRetirementPlan = z.infer<typeof planSchema>;
const same = (a: unknown, b: unknown) =>
  nativeRootDigest(a) === nativeRootDigest(b);
function fail(code: string): never {
  throw new Error(code);
}
const terminalChatCutoff = (raw: unknown) =>
  raw !== null &&
  typeof raw === 'object' &&
  'schemaVersion' in raw &&
  (raw.schemaVersion === 2 || raw.schemaVersion === 3);

/** Before any clock, lease or SDK work. Older isolated checkpoints do not have
 * a v2 cutoff table/function and retain their original execution semantics. */
export async function assertNativeRunExecutionAvailable(
  tx: Reader,
  runId: string,
) {
  const [schema] =
    await tx`select to_regprocedure(format('%I.allrice_terminal_native_chat_run_available(uuid)',current_schema())) is not null available`;
  if (schema?.available)
    await tx`select allrice_terminal_native_chat_run_available(${runId}::uuid)`;
}

/** Terminal execution cutoff; read-only history and artifact reads stay legal.
 * Never return null as a legacy fallback when a context was explicitly retired. */
export async function nativeContextExecutionRetired(
  tx: Reader,
  contextKind: ContextKind,
  contextId: string,
) {
  const [row] = await tx`select 1 from allrice_native_context_retirements
    where context_kind=${contextKind} and context_id=${contextId}`;
  return !!row;
}
export async function assertNativeContextExecutionAvailable(
  tx: Reader,
  contextKind: ContextKind,
  contextId: string,
) {
  if (await nativeContextExecutionRetired(tx, contextKind, contextId))
    fail('NATIVE_CONTEXT_EXECUTION_RETIRED');
}

async function bindings(tx: Tx, scope: NativeTestChatRetirementScope) {
  const rows = await tx<{ value: Record<string, postgres.JSONValue> }[]>`
    select (to_jsonb(b)-'bound_at') || jsonb_build_object('bound_at_micros',
      (extract(epoch from b.bound_at)*1000000)::bigint::text) value
    from allrice_native_session_bindings b where context_kind='chat'
      and context_id=${scope.contextId} order by native_session_id`;
  const values = rows.map((r) => r.value);
  if (
    values.some(
      (b) =>
        b.organization_id !== scope.organizationId ||
        b.workspace_id !== scope.workspaceId ||
        b.owner_id !== scope.ownerId,
    )
  )
    fail('NATIVE_RETIREMENT_BINDING_SCOPE_CONFLICT');
  return values;
}

async function preservation(tx: Tx, sessionId: string) {
  const [messages] = await tx`select count(*)::int count,
    md5(coalesce(string_agg(to_jsonb(m)::text,',' order by id),'')) digest
    from allrice_messages m where session_id=${sessionId}`;
  const [versions] = await tx`select count(*)::int count,
    md5(coalesce(string_agg(to_jsonb(v)::text,',' order by id),'')) digest
    from allrice_deliverable_versions v where session_id=${sessionId}`;
  const [files] = await tx`select count(*)::int count,
    md5(coalesce(string_agg(to_jsonb(f)::text,',' order by object_id),'')) digest
    from allrice_file_references f where session_id=${sessionId}`;
  const [artifacts] = await tx`select count(*)::int count,
    md5(coalesce(string_agg(to_jsonb(a)::text,',' order by version_id),'')) digest
    from allrice_workbench_artifacts a where version_id in
      (select id from allrice_deliverable_versions where session_id=${sessionId})`;
  // An existing file can become a company reference or an article without
  // adding a message/version. Such a new relationship invalidates approval too.
  const [businessReferences] = await tx`with roots as (
      select run_id from allrice_employee_runs where session_id=${sessionId}
    ), articles as (select * from allrice_brand_content_articles where session_id=${sessionId}),
    refs as (
      select 'article' kind,to_jsonb(a) value from articles a
      union all select 'bundle',to_jsonb(b) from allrice_brand_content_bundles b where article_id in (select id from articles)
      union all select 'review',to_jsonb(r) from allrice_brand_content_reviews r where article_id in (select id from articles)
      union all select 'plan',to_jsonb(p) from allrice_brand_content_plans p where article_id in (select id from articles)
      union all select 'reminder',to_jsonb(r) from allrice_brand_content_reminders r where session_id=${sessionId}
      union all select 'workflow_start',to_jsonb(s) from allrice_brand_content_workflow_starts s where session_id=${sessionId}
      union all select 'content_context',to_jsonb(c) from allrice_employee_content_contexts c where session_id=${sessionId}
      union all select 'method_test',to_jsonb(t) from allrice_employee_method_tests t where source_session_id=${sessionId}
      union all select 'method_activation',to_jsonb(a) from allrice_employee_method_activations a where session_id=${sessionId}
      union all select 'skill_import',to_jsonb(i) from allrice_personal_skill_imports i where session_id=${sessionId}
      union all select 'skill_operation',to_jsonb(o) from allrice_personal_skill_version_operations o where session_id=${sessionId}
      union all select 'company_input',to_jsonb(a) from allrice_company_run_assets a where run_id in (select run_id from roots)
      union all select 'company_derivation',to_jsonb(d) from allrice_company_asset_derivations d
        where run_id in (select run_id from roots) or deliverable_version_id in
          (select id from allrice_deliverable_versions where session_id=${sessionId})
      union all select 'knowledge',to_jsonb(k) from allrice_knowledge_revisions k where file_object_id in
        (select object_id from allrice_deliverable_versions where session_id=${sessionId}
         union select object_id from allrice_file_references where session_id=${sessionId})
    ) select count(*)::int count,
      md5(coalesce(string_agg(kind||':'||value::text,',' order by kind,value::text),'')) digest from refs`;
  const [objects] = await tx`select count(*)::int count,
    md5(coalesce(string_agg(to_jsonb(o)::text,',' order by id),'')) digest
    from allrice_storage_objects o where id in (
      select object_id from allrice_deliverable_versions where session_id=${sessionId}
      union select object_id from allrice_file_references where session_id=${sessionId})`;
  return {
    messages,
    versions,
    files,
    artifacts,
    businessReferences,
    objects,
  };
}

async function assertIdle(tx: Tx, scope: NativeTestChatRetirementScope) {
  const [busy] = await tx`with roots as (
    select run_id from allrice_employee_runs where session_id=${scope.contextId}
    union select first_run_id from allrice_native_session_bindings
      where context_kind='chat' and context_id=${scope.contextId}
  ), subjects as (
    select run_id from roots union select run_id from allrice_runtime_run_links
      where root_run_id in (select run_id from roots)
  ), busy as (
    select 1 from allrice_runs where id in (select run_id from subjects)
      and state not in ('succeeded','failed','canceled')
    union all select 1 from allrice_jobs where run_id in (select run_id from subjects)
      and status not in ('succeeded','failed','dead_letter','canceled')
    union all select 1 from allrice_runtime_operations where root_run_id in (select run_id from subjects)
      and (coalesce(snapshot->>'status','') not in ('succeeded','failed','canceled','partial')
        or lease_expires_at>clock_timestamp())
    union all select 1 from allrice_conversation_runtimes where session_id=${scope.contextId}
      and (state='running' or active_run_id is not null)
    union all select 1 from allrice_assistant_model_admissions where root_run_id in (select run_id from subjects)
      and finished_at is null
    union all select 1 from allrice_assistant_instances where root_run_id in (select run_id from roots)
      and (status not in ('completed','partial','failed','canceled') or stopped_at is null)
    union all select 1 from allrice_assistant_messages where root_run_id in (select run_id from roots)
      and status not in ('adopted','canceled')
    union all select 1 from allrice_native_question_waits where run_id in (select run_id from subjects) and state<>'continued'
    union all select 1 from allrice_native_task_dispatches where run_id in (select run_id from subjects) and state<>'completed'
    union all select 1 from allrice_assistant_usage where root_run_id in (select run_id from roots)
      and metric='tool_calls' and amount>0 and settled_amount is null
    union all select 1 from allrice_task_calls where run_id in (select run_id from subjects) and finished_at is null
    union all select 1 from allrice_task_resource_waits where run_id in (select run_id from subjects)
      and (state not in ('completed','failed','canceled') or finished_at is null)
    union all select 1 from allrice_cloud_execution_attempts a
      join allrice_runtime_operations o on o.id=a.operation_id
      where o.root_run_id in (select run_id from subjects) and a.cleanup_confirmed_at is null
    union all select 1 from allrice_automations where session_id=${scope.contextId}
      and status='enabled' and deleted_at is null
  ) select 1 from busy limit 1`;
  if (busy) fail('NATIVE_RETIREMENT_CONTEXT_BUSY');
  assertDshContextPhysicallyClosed(
    await readDshRuntimeCloseCoverage(tx, { context: scope }),
    scope,
  );
}

async function snapshot(
  tx: Tx,
  scope: NativeTestChatRetirementScope,
  lock: boolean,
) {
  // Same identity -> Session lock order as ordinary workbench admission.
  if (lock) {
    await tx`select id from allrice_organizations where id=${scope.organizationId} for share`;
    await tx`select id from allrice_workspaces where organization_id=${scope.organizationId} and id=${scope.workspaceId} for share`;
    await tx`select id from allrice_users where id=${scope.ownerId} for share`;
  }
  const [row] = lock
    ? await tx`select native_root_origin,archived_at from allrice_chat_sessions
      where id=${scope.contextId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} for update`
    : await tx`select native_root_origin,archived_at from allrice_chat_sessions
      where id=${scope.contextId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}`;
  if (!row) fail('NATIVE_RETIREMENT_SCOPE_NOT_FOUND');
  await assertIdle(tx, scope);
  return snapshotSchema.parse({
    scope,
    origin: row.native_root_origin,
    bindings: await bindings(tx, scope),
    archived: !!row.archived_at,
    preservation: await preservation(tx, scope.contextId),
  });
}

/** No mutation. The caller must fix its exact reviewed scope and release/fence
 * separately; this maintenance function is not exposed as an employee tool. */
export async function previewNativeTestChatRetirement(input: unknown) {
  if (terminalChatCutoff(input))
    return (input as { schemaVersion: number }).schemaVersion === 3
      ? previewNativeChatAbandonedDescendantCutoff(input)
      : previewNativeChatTerminalCutoff(input);
  const request = requestSchema.parse(input);
  const scopes = [...request.scopes].sort((a, b) =>
    a.contextId.localeCompare(b.contextId),
  );
  if (new Set(scopes.map((s) => s.contextId)).size !== scopes.length)
    fail('NATIVE_RETIREMENT_DUPLICATE_CONTEXT');
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local timezone='UTC'`;
      const snapshots = [];
      for (const scope of scopes)
        snapshots.push(await snapshot(tx, scope, false));
      const body = {
        schemaVersion: 1 as const,
        kind: 'development-test-chat-retirement' as const,
        requestId: request.requestId,
        authorizationEvidenceDigest: request.authorizationEvidenceDigest,
        snapshots,
      };
      return planSchema.parse({ ...body, digest: nativeRootDigest(body) });
    },
  );
}

/** Caller holds the reviewed maintenance window. No transaction retry: an
 * unknown commit must be read back using this same request/plan, never reissued. */
export async function applyNativeTestChatRetirement(input: unknown) {
  if (
    input !== null &&
    typeof input === 'object' &&
    'plan' in input &&
    terminalChatCutoff(input.plan)
  )
    return applyNativeTerminalTestRetirement(input);
  const plan = planSchema.parse(input);
  const { digest: expected, ...body } = plan;
  if (nativeRootDigest(body) !== expected)
    fail('NATIVE_RETIREMENT_PLAN_DIGEST_CHANGED');
  const ids = plan.snapshots.map((s) => s.scope.contextId);
  if (new Set(ids).size !== ids.length || !same(ids, [...ids].sort()))
    fail('NATIVE_RETIREMENT_PLAN_ORDER_INVALID');
  return getDatabase().begin(async (tx) => {
    await tx`set local statement_timeout='5000'`;
    await tx`set local lock_timeout='1000'`;
    await tx`set local timezone='UTC'`;
    await tx`select pg_advisory_xact_lock(hashtext('allrice-native-retirement'),hashtext(${plan.requestId}))`;
    const existing =
      await tx`select context_id,plan_digest from allrice_native_context_retirements
      where request_id=${plan.requestId} order by context_id`;
    if (existing.length) {
      if (
        !same(
          existing.map((r) => r.context_id),
          ids,
        ) ||
        existing.some((r) => r.plan_digest !== expected)
      )
        fail('NATIVE_RETIREMENT_REQUEST_CONFLICT');
      await readVerifiedNativeChatRetirements(tx);
      for (const wanted of plan.snapshots)
        if (
          !same(
            await preservation(tx, wanted.scope.contextId),
            wanted.preservation,
          )
        )
          fail('NATIVE_RETIREMENT_PRESERVED_DATA_CHANGED');
      return {
        requestId: plan.requestId,
        planDigest: expected,
        contexts: ids,
        alreadyApplied: true,
      };
    }
    for (const wanted of plan.snapshots) {
      const actual = await snapshot(tx, wanted.scope, true);
      if (!same(actual, wanted)) fail('NATIVE_RETIREMENT_PLAN_STALE');
      await assertNativeContextExecutionAvailable(
        tx,
        'chat',
        wanted.scope.contextId,
      );
      await tx`update allrice_chat_sessions set archived_at=coalesce(archived_at,clock_timestamp())
        where id=${wanted.scope.contextId} and organization_id=${wanted.scope.organizationId}
          and workspace_id=${wanted.scope.workspaceId} and owner_id=${wanted.scope.ownerId}`;
      await tx`insert into allrice_native_context_retirements
        (context_kind,context_id,organization_id,workspace_id,owner_id,request_id,plan_digest,reason,
          origin_snapshot,binding_snapshot,preservation_snapshot,authorization_evidence_digest)
        values ('chat',${wanted.scope.contextId},${wanted.scope.organizationId},${wanted.scope.workspaceId},
          ${wanted.scope.ownerId},${plan.requestId},${expected},'development_test_discarded',
          ${wanted.origin === null ? null : tx.json(wanted.origin)},${tx.json(wanted.bindings)},
          ${tx.json(wanted.preservation)},${plan.authorizationEvidenceDigest})`;
      if (
        !same(
          await preservation(tx, wanted.scope.contextId),
          wanted.preservation,
        )
      )
        fail('NATIVE_RETIREMENT_PRESERVED_DATA_CHANGED');
    }
    await readVerifiedNativeChatRetirements(tx);
    return {
      requestId: plan.requestId,
      planDigest: expected,
      contexts: ids,
      alreadyApplied: false,
    };
  });
}

/** Unknown commit recovery is a read, not a second apply or a new request ID. */
export async function readNativeTestChatRetirement(input: unknown) {
  if (terminalChatCutoff(input)) return readNativeTerminalTestRetirement(input);
  const plan = planSchema.parse(input);
  const { digest: expected, ...body } = plan;
  if (nativeRootDigest(body) !== expected)
    fail('NATIVE_RETIREMENT_PLAN_DIGEST_CHANGED');
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local timezone='UTC'`;
      const rows =
        await tx`select context_id,plan_digest from allrice_native_context_retirements
      where request_id=${plan.requestId} order by context_id`;
      if (!rows.length)
        return { requestId: plan.requestId, status: 'not-found' as const };
      if (
        !same(
          rows.map((r) => r.context_id),
          plan.snapshots.map((s) => s.scope.contextId),
        ) ||
        rows.some((r) => r.plan_digest !== expected)
      )
        fail('NATIVE_RETIREMENT_REQUEST_CONFLICT');
      await readVerifiedNativeChatRetirements(tx);
      for (const wanted of plan.snapshots)
        if (
          !same(
            await preservation(tx, wanted.scope.contextId),
            wanted.preservation,
          )
        )
          fail('NATIVE_RETIREMENT_PRESERVED_DATA_CHANGED');
      return {
        requestId: plan.requestId,
        planDigest: expected,
        status: 'completed' as const,
        contexts: rows.map((r) => r.context_id),
      };
    },
  );
}

/** Verify lifecycle facts before excluding any historical origin/pin from the
 * executable coverage set. Archived alone never qualifies for this list. */
export async function readVerifiedNativeChatRetirements(tx: Tx) {
  const rows =
    await tx`select * from allrice_native_context_retirements where context_kind='chat' order by context_kind,context_id`;
  const result: NativeTestChatRetirementScope[] = [];
  // Keep the caller's transaction/snapshot and the complete row fingerprints.
  // Bound each lookup instead of issuing two statements for every retirement.
  for (let offset = 0; offset < rows.length; offset += 50) {
    const batch = rows.slice(offset, offset + 50);
    const scopes = batch.map((r) => {
      // Other business kinds need their own reviewed lifecycle implementation.
      if (r.context_kind !== 'chat') fail('NATIVE_RETIREMENT_KIND_UNSUPPORTED');
      return scopeSchema.parse({
        contextKind: r.context_kind,
        contextId: r.context_id,
        organizationId: r.organization_id,
        workspaceId: r.workspace_id,
        ownerId: r.owner_id,
      });
    });
    const ids = scopes.map((scope) => scope.contextId);
    const contexts = new Map(
      (
        await tx<
          {
            id: string;
            organization_id: string;
            workspace_id: string;
            owner_id: string;
            native_root_origin: postgres.JSONValue;
            archived: boolean;
          }[]
        >`select id,organization_id,workspace_id,owner_id,native_root_origin,
          archived_at is not null archived
        from allrice_chat_sessions where id in ${tx(ids)}`
      ).map((context) => [context.id, context]),
    );
    const bindingRows = await tx<
      { context_id: string; value: Record<string, postgres.JSONValue> }[]
    >`select context_id,(to_jsonb(b)-'bound_at') || jsonb_build_object('bound_at_micros',
        (extract(epoch from b.bound_at)*1000000)::bigint::text) value
      from allrice_native_session_bindings b where context_kind='chat'
        and context_id in ${tx(ids)} order by context_id,native_session_id`;
    const bindingValues = new Map<
      string,
      Record<string, postgres.JSONValue>[]
    >();
    for (const binding of bindingRows) {
      const values = bindingValues.get(binding.context_id) ?? [];
      values.push(binding.value);
      bindingValues.set(binding.context_id, values);
    }
    for (let index = 0; index < batch.length; index++) {
      const r = batch[index]!;
      const scope = scopes[index]!;
      const context = contexts.get(scope.contextId);
      if (
        !context?.archived ||
        context.organization_id !== scope.organizationId ||
        context.workspace_id !== scope.workspaceId ||
        context.owner_id !== scope.ownerId ||
        !same(context.native_root_origin, r.origin_snapshot)
      )
        fail('NATIVE_RETIREMENT_REFERENCE_SNAPSHOT_CHANGED');
      // Do not filter foreign binding rows out of the query: their presence
      // invalidates retirement even if the reviewed rows would still match.
      const values = bindingValues.get(scope.contextId) ?? [];
      if (
        values.some(
          (b) =>
            b.organization_id !== scope.organizationId ||
            b.workspace_id !== scope.workspaceId ||
            b.owner_id !== scope.ownerId,
        )
      )
        fail('NATIVE_RETIREMENT_BINDING_SCOPE_CONFLICT');
      if (!same(values, r.binding_snapshot))
        fail('NATIVE_RETIREMENT_REFERENCE_SNAPSHOT_CHANGED');
      if (
        r.preservation_snapshot?.kind ===
        'development-test-chat-terminal-cutoff-v2'
      )
        await verifyNativeChatTerminalCutoffRow(tx, r);
      else if (
        r.preservation_snapshot?.kind ===
        'development-test-chat-abandoned-descendant-cutoff-v1'
      )
        await verifyNativeChatAbandonedDescendantCutoffRow(tx, r);
      else if (r.preservation_snapshot?.kind !== undefined)
        fail('NATIVE_RETIREMENT_PRESERVATION_KIND_UNSUPPORTED');
      result.push(scope);
    }
  }
  return result;
}
