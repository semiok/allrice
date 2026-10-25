import type postgres from 'postgres';
import { z } from 'zod';
import { posix } from 'node:path';
import { getDatabase } from '../core/client.ts';
import {
  NativeRootOriginSchema,
  nativeRootDigest,
  assertNativeRootOrigin,
} from './native-root-origin.ts';
import {
  classifyDshRuntimeCloseObservations,
  readDshRuntimeCloseCoverage,
} from '../providers/dsh-runtime-close-observations.ts';

import {
  readCurrentPlatformTestExecutionRecord,
  type PlatformTestExecutionRecord,
} from './platform-test-execution-record.ts';

type Tx = postgres.TransactionSql;
const uuid = z
  .string()
  .uuid()
  .transform((s) => s.toLowerCase());
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime();
const json: z.ZodType<postgres.JSONValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
export const NativeTerminalTestScopeSchema = z
  .object({
    contextKind: z.enum([
      'platform_employee_test',
      'experience_consolidation',
      'platform_technical',
    ]),
    contextId: uuid,
    organizationId: uuid,
    workspaceId: uuid,
    ownerId: uuid,
  })
  .strict()
  .refine(
    (s) => s.contextId !== '68e76b6b-2e75-45b7-b628-951945b12044',
    'NATIVE_TERMINAL_PROTECTED_CONTEXT',
  );
export type NativeTerminalTestScope = z.infer<
  typeof NativeTerminalTestScopeSchema
>;
const factsSchema = z
  .object({
    scope: NativeTerminalTestScopeSchema,
    source: z.record(z.string(), json),
    origin: NativeRootOriginSchema.nullable(),
    bindings: z.array(z.record(z.string(), json)),
    runIds: z.array(uuid),
    missingRunIds: z.array(uuid),
    missingJobIds: z.array(uuid),
    runs: z.array(z.record(z.string(), json)),
    jobs: z.array(z.record(z.string(), json)),
    closeRows: z.array(json),
    consumers: z.array(z.record(z.string(), json)),
    occurrence: json,
    preserved: z.record(z.string(), json),
  })
  .strict();
export const NativeTerminalTestPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('development-terminal-test-retirement'),
    requestId: uuid,
    authorizationEvidenceDigest: digest,
    snapshots: z.array(factsSchema).min(1).max(10),
    digest,
  })
  .strict();
export type NativeTerminalTestPlan = z.infer<
  typeof NativeTerminalTestPlanSchema
>;
const chatScope = z
  .object({
    contextKind: z.literal('chat'),
    contextId: uuid,
    organizationId: uuid,
    workspaceId: uuid,
    ownerId: uuid,
  })
  .strict()
  .refine(
    (s) => s.contextId !== '68e76b6b-2e75-45b7-b628-951945b12044',
    'NATIVE_TERMINAL_PROTECTED_CONTEXT',
  );
const legacyExecutor = z
  .object({
    scope: chatScope,
    artifactId: digest,
    storageNamespace: z
      .string()
      .refine((p) => posix.isAbsolute(p) && posix.normalize(p) === p),
  })
  .strict()
  .refine(
    (e) =>
      e.storageNamespace.endsWith(
        `/${e.scope.organizationId}/${e.scope.workspaceId}/${e.scope.ownerId}/${e.scope.contextId}/sessions`,
      ),
    'NATIVE_CHAT_CUTOFF_NAMESPACE_SCOPE',
  );
const chatFactsSchema = factsSchema.extend({ scope: chatScope });
export const NativeChatTerminalCutoffPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('development-test-chat-terminal-cutoff'),
    requestId: uuid,
    authorizationEvidenceDigest: digest,
    snapshots: z.array(chatFactsSchema).min(1).max(7),
    legacyExecutors: z.array(legacyExecutor).min(1).max(7),
    digest,
  })
  .strict();
type ChatPlan = z.infer<typeof NativeChatTerminalCutoffPlanSchema>;
type TerminalPlan = NativeTerminalTestPlan | ChatPlan;
type TerminalScope = NativeTerminalTestScope | z.infer<typeof chatScope>;
const physicalSchema = z
  .object({
    kind: z.literal('terminal-native-physical-absence-v1'),
    requestId: uuid,
    planDigest: digest,
    scopeDigest: digest,
    workerBootId: uuid,
    workerBootStartedAt: time,
    observedAt: time,
    expiresAt: time,
    processInventoryDigest: digest,
    writerInventoryDigest: digest,
    nativeProcesses: z.array(z.never()).length(0),
    writers: z.array(z.never()).length(0),
    artifactRoots: z
      .array(
        z
          .object({
            artifactId: digest,
            root: z.string().startsWith('/'),
            manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(8),
    storageNamespaces: z.array(z.string().startsWith('/')).max(50),
    writerScopes: z
      .array(
        z
          .object({ artifactId: digest, root: z.string().startsWith('/') })
          .strict(),
      )
      .max(50),
    evidencePath: z.string().startsWith('/'),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTree: z.string().regex(/^[a-f0-9]{40}$/),
    operatorSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const fail = (code: string): never => {
  throw Error(code);
};
const same = (a: unknown, b: unknown) =>
  nativeRootDigest(a) === nativeRootDigest(b);
const key = (s: TerminalScope) => s.contextKind + ':' + s.contextId;
function plan(raw: unknown) {
  const p = z
      .union([NativeTerminalTestPlanSchema, NativeChatTerminalCutoffPlanSchema])
      .parse(raw),
    { digest: expected, ...body } = p;
  if (nativeRootDigest(body) !== expected) fail('NATIVE_TERMINAL_PLAN_CHANGED');
  const keys = p.snapshots.map((s) => key(s.scope));
  if (new Set(keys).size !== keys.length || !same(keys, [...keys].sort()))
    fail('NATIVE_TERMINAL_PLAN_ORDER');
  if (
    p.schemaVersion === 2 &&
    (!same(
      p.legacyExecutors.map((e) => key(e.scope)),
      keys,
    ) ||
      p.legacyExecutors.some((e, i) => !same(e.scope, p.snapshots[i]!.scope)))
  )
    fail('NATIVE_CHAT_CUTOFF_EXACT_EXECUTORS_REQUIRED');
  return p;
}

/** Process scope is all bindings and their original writers, not one selected
 * PID or one owner used to cover multiple histories. Old unknown stays unknown. */
export function nativeTerminalTestPhysicalScope(raw: unknown) {
  const p = plan(raw);
  const artifactIds = new Set<string>(),
    namespaces = new Set<string>();
  for (const snapshot of p.snapshots) {
    if (snapshot.origin) artifactIds.add(snapshot.origin.artifactId);
    for (const pin of snapshot.bindings) {
      artifactIds.add(digest.parse(pin.artifact_id));
      namespaces.add(z.string().startsWith('/').parse(pin.storage_namespace));
    }
    for (const item of classifyDshRuntimeCloseObservations(snapshot.closeRows))
      artifactIds.add(item.owner.artifactId);
  }
  if (p.schemaVersion === 2)
    for (const e of p.legacyExecutors) {
      artifactIds.add(e.artifactId);
      namespaces.add(e.storageNamespace);
    }
  const value = {
    scopes: p.snapshots.map((s) => s.scope),
    artifactIds: [...artifactIds].sort(),
    storageNamespaces: [...namespaces].sort(),
  };
  return { ...value, digest: nativeRootDigest(value) };
}
function proofFor(p: TerminalPlan, raw: unknown) {
  const proof = physicalSchema.parse(raw),
    scope = nativeTerminalTestPhysicalScope(p),
    now = Date.now();
  if (
    proof.requestId !== p.requestId ||
    proof.planDigest !== p.digest ||
    proof.scopeDigest !== scope.digest ||
    Date.parse(proof.observedAt) > now ||
    Date.parse(proof.expiresAt) <= now ||
    Date.parse(proof.expiresAt) - Date.parse(proof.observedAt) > 120_000 ||
    !same(proof.storageNamespaces, scope.storageNamespaces) ||
    !same(
      proof.artifactRoots.map((r) => r.artifactId).sort(),
      scope.artifactIds,
    ) ||
    !same(
      [...new Set(proof.writerScopes.map((r) => r.artifactId))].sort(),
      scope.artifactIds,
    ) ||
    !p.snapshots.every((s) =>
      s.bindings.every((b) =>
        proof.writerScopes.some(
          (r) =>
            r.artifactId === b.artifact_id &&
            typeof b.storage_namespace === 'string' &&
            (b.storage_namespace === r.root ||
              b.storage_namespace.startsWith(r.root + '/')),
        ),
      ),
    ) ||
    (p.schemaVersion === 2 &&
      !p.legacyExecutors.every((e) =>
        proof.writerScopes.some(
          (r) =>
            r.artifactId === e.artifactId &&
            e.storageNamespace.startsWith(r.root + '/'),
        ),
      )) ||
    new Set(proof.artifactRoots.map((r) => r.artifactId)).size !==
      proof.artifactRoots.length
  )
    fail('NATIVE_TERMINAL_PHYSICAL_PROOF_CHANGED');
  if (Date.parse(proof.workerBootStartedAt) > Date.parse(proof.observedAt))
    fail('NATIVE_TERMINAL_WORKER_BIRTH_INVALID');
  const bootMicros = BigInt(Date.parse(proof.workerBootStartedAt)) * 1000n;
  if (
    p.snapshots.some(
      (s) =>
        typeof s.source.created_at !== 'string' ||
        Date.parse(s.source.created_at) >=
          Date.parse(proof.workerBootStartedAt) ||
        s.bindings.some(
          (b) =>
            typeof b.bound_at_micros !== 'string' ||
            BigInt(b.bound_at_micros) >= bootMicros,
        ),
    )
  )
    fail('NATIVE_TERMINAL_CURRENT_BOOT_CONTEXT_NOT_DISCARDABLE');
  return proof;
}
async function facts(tx: Tx, scope: TerminalScope) {
  if (scope.contextKind === 'chat') {
    const [row] =
      await tx`select allrice_terminal_native_chat_facts(${scope.contextId},${scope.organizationId},${scope.workspaceId},${scope.ownerId}) facts`;
    const value = chatFactsSchema.parse(row?.facts);
    assertClosedOwners(value.closeRows, scope);
    return value;
  }
  const [row] =
    await tx`select allrice_terminal_native_test_facts(${scope.contextKind},${scope.contextId},${scope.organizationId},${scope.workspaceId},${scope.ownerId}) facts`;
  const value = factsSchema.parse(row?.facts);
  if (value.origin) {
    if (
      scope.contextKind === 'platform_employee_test' &&
      value.origin.schemaVersion === 2
    )
      readCurrentPlatformTestExecutionRecord(
        value.source as unknown as PlatformTestExecutionRecord,
        {
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          ownerId: scope.ownerId,
        },
      );
    else {
      const recipe: Record<string, postgres.JSONValue> =
        scope.contextKind === 'platform_technical'
          ? {
              ...(value.source.frozen_configuration as Record<
                string,
                postgres.JSONValue
              >),
            }
          : {
              recipe: 'allrice-experience-consolidation/v1',
              occurrence: value.source.experience_occurrence ?? null,
            };
      if (scope.contextKind === 'platform_technical') delete recipe.question;
      assertNativeRootOrigin(
        value.origin,
        scope.contextKind,
        scope.contextId,
        scope.contextKind === 'platform_employee_test'
          ? {
              kind: 'employee_package',
              checksum: digest.parse(value.source.frozen_package_checksum),
            }
          : { kind: 'internal_recipe', checksum: nativeRootDigest(recipe) },
      );
    }
  }
  assertClosedOwners(value.closeRows, scope);
  return value;
}
function assertClosedOwners(
  closeRows: postgres.JSONValue[],
  scope: TerminalScope,
) {
  const coverage = classifyDshRuntimeCloseObservations(closeRows);
  if (
    coverage.some(
      (c) =>
        c.owner.context.kind !== 'context' ||
        !same(
          {
            contextKind: c.owner.context.contextKind,
            contextId: c.owner.context.contextId,
            organizationId: c.owner.context.organizationId,
            workspaceId: c.owner.context.workspaceId,
            ownerId: c.owner.context.ownerId,
          },
          scope,
        ) ||
        (c.physical !== 'never_spawned' && c.publicClose !== 'confirmed'),
    )
  )
    fail('NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED');
}
async function registeredIdle(tx: Tx, p: TerminalPlan) {
  const [legacy] =
    await tx`select count(*)::int n from allrice_dsh_runtime_instances where status='live'`;
  if (legacy?.n !== 0) fail('NATIVE_TERMINAL_REGISTERED_RUNTIME_LIVE');
  const ids = new Set(nativeTerminalTestPhysicalScope(p).artifactIds);
  const all = await readDshRuntimeCloseCoverage(tx);
  if (
    all.some(
      (c) =>
        ids.has(c.owner.artifactId) &&
        c.physical !== 'never_spawned' &&
        c.publicClose !== 'confirmed',
    )
  )
    fail('NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED');
}
export async function previewNativeTerminalTestRetirement(raw: unknown) {
  const request = z
    .object({
      requestId: uuid,
      authorizationEvidenceDigest: digest,
      scopes: z.array(NativeTerminalTestScopeSchema).min(1).max(10),
    })
    .strict()
    .parse(raw);
  const scopes = [...request.scopes].sort((a, b) =>
    key(a).localeCompare(key(b)),
  );
  if (new Set(scopes.map(key)).size !== scopes.length)
    fail('NATIVE_TERMINAL_DUPLICATE_CONTEXT');
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local timezone='UTC'`;
      const snapshots = [];
      for (const scope of scopes) snapshots.push(await facts(tx, scope));
      const body = {
        schemaVersion: 1 as const,
        kind: 'development-terminal-test-retirement' as const,
        requestId: request.requestId,
        authorizationEvidenceDigest: request.authorizationEvidenceDigest,
        snapshots,
      };
      return NativeTerminalTestPlanSchema.parse({
        ...body,
        digest: nativeRootDigest(body),
      });
    },
  );
}
/** Explicit terminal test cutoff, not completion of any historical callback. */
export async function previewNativeChatTerminalCutoff(raw: unknown) {
  const request = z
    .object({
      schemaVersion: z.literal(2),
      kind: z.literal('development-test-chat-terminal-cutoff'),
      requestId: uuid,
      authorizationEvidenceDigest: digest,
      scopes: z.array(chatScope).min(1).max(7),
      legacyExecutors: z.array(legacyExecutor).min(1).max(7),
    })
    .strict()
    .parse(raw);
  const scopes = [...request.scopes].sort((a, b) =>
    key(a).localeCompare(key(b)),
  );
  if (new Set(scopes.map(key)).size !== scopes.length)
    fail('NATIVE_TERMINAL_DUPLICATE_CONTEXT');
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local timezone='UTC'`;
      const snapshots = [];
      for (const scope of scopes) snapshots.push(await facts(tx, scope));
      const body = {
        schemaVersion: 2 as const,
        kind: request.kind,
        requestId: request.requestId,
        authorizationEvidenceDigest: request.authorizationEvidenceDigest,
        snapshots,
        legacyExecutors: [...request.legacyExecutors].sort((a, b) =>
          key(a.scope).localeCompare(key(b.scope)),
        ),
      };
      return plan({ ...body, digest: nativeRootDigest(body) }) as ChatPlan;
    },
  );
}
async function receipt(tx: Tx, p: TerminalPlan) {
  const rows =
    await tx`select * from allrice_native_context_retirements where request_id=${p.requestId} order by context_kind,context_id`;
  if (!rows.length) return null;
  if (
    !same(
      rows.map((r) => r.context_kind + ':' + r.context_id),
      p.snapshots.map((s) => key(s.scope)),
    ) ||
    rows.some(
      (r) =>
        r.plan_digest !== p.digest ||
        r.authorization_evidence_digest !== p.authorizationEvidenceDigest,
    )
  )
    fail('NATIVE_TERMINAL_REQUEST_CONFLICT');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      expected = p.snapshots[i]!;
    if (
      !same(row.preservation_snapshot?.facts, expected) ||
      !same(await facts(tx, expected.scope), expected) ||
      !same(row.origin_snapshot, expected.origin) ||
      !same(row.binding_snapshot, expected.bindings)
    )
      fail('NATIVE_TERMINAL_PRESERVED_FACTS_CHANGED');
  }
  return rows.map((r) => ({
    contextKind: r.context_kind,
    contextId: r.context_id,
    retiredAt: r.retired_at,
    planDigest: r.plan_digest,
    reason: r.reason,
    physicalProof: r.preservation_snapshot.physicalProof,
  }));
}

/** Append only. The physical proof comes from the reviewed source operator's
 * actual full inventory; this private SQL API cannot attest an OS by itself. */
export async function applyNativeTerminalTestRetirement(raw: unknown) {
  const input = z
      .object({ plan: z.unknown(), physicalProof: z.unknown() })
      .strict()
      .parse(raw),
    p = plan(input.plan);
  return getDatabase().begin(async (tx) => {
    await tx`set local statement_timeout='5000'`;
    await tx`set local lock_timeout='1000'`;
    await tx`set local timezone='UTC'`;
    await tx`select pg_advisory_xact_lock(hashtext('allrice-native-retirement'),hashtext(${p.requestId}))`;
    const previous = await receipt(tx, p);
    if (previous)
      return {
        requestId: p.requestId,
        planDigest: p.digest,
        alreadyApplied: true,
        contexts: previous,
        historicalClosure: 'not_reclassified' as const,
      };
    const proof = proofFor(p, input.physicalProof);
    await registeredIdle(tx, p);
    for (const { scope: s } of p.snapshots) {
      const [lock] =
        await tx`select pg_try_advisory_xact_lock(hashtextextended(${`native-terminal-context:${s.contextKind}:${s.contextId}`},0)) locked`;
      if (lock?.locked !== true) fail('NATIVE_TERMINAL_CUTOFF_BUSY');
    }
    const runIds = [...new Set(p.snapshots.flatMap((s) => s.runIds))].sort();
    await tx`select id from allrice_runs where id=any(${tx.array(runIds)}::uuid[]) order by id for no key update nowait`;
    await tx`select id from allrice_jobs where run_id=any(${tx.array(runIds)}::uuid[]) order by id for update nowait`;
    for (const id of nativeTerminalTestPhysicalScope(p).artifactIds) {
      const [lock] =
        await tx`select pg_try_advisory_xact_lock(hashtextextended(${`native-terminal-artifact:${id}`},0)) locked`;
      if (lock?.locked !== true) fail('NATIVE_TERMINAL_CUTOFF_BUSY');
    }
    for (const expected of p.snapshots) {
      const s = expected.scope;
      await tx`select allrice_terminal_native_test_lock(${s.contextKind},${s.contextId})`;
      if (!same(await facts(tx, s), expected))
        fail('NATIVE_TERMINAL_PLAN_STALE');
    }
    await registeredIdle(tx, p);
    for (const expected of p.snapshots) {
      const s = expected.scope;
      if (s.contextKind === 'chat')
        await tx`update allrice_chat_sessions set archived_at=coalesce(archived_at,clock_timestamp())
        where id=${s.contextId} and organization_id=${s.organizationId} and workspace_id=${s.workspaceId} and owner_id=${s.ownerId}`;
      await tx`insert into allrice_native_context_retirements
        (context_kind,context_id,organization_id,workspace_id,owner_id,request_id,plan_digest,reason,
          origin_snapshot,binding_snapshot,preservation_snapshot,authorization_evidence_digest)
        values(${s.contextKind},${s.contextId},${s.organizationId},${s.workspaceId},${s.ownerId},${p.requestId},${p.digest},'development_test_discarded',
          ${expected.origin ? tx.json(JSON.parse(JSON.stringify(expected.origin))) : null},${tx.json(expected.bindings)},
          ${tx.json(
            JSON.parse(
              JSON.stringify({
                kind:
                  p.schemaVersion === 2
                    ? 'development-test-chat-terminal-cutoff-v2'
                    : 'development-terminal-test-retirement-v1',
                facts: expected,
                physicalProof: proof,
                ...(p.schemaVersion === 2
                  ? {
                      legacyExecutor: p.legacyExecutors.find(
                        (e) => key(e.scope) === key(s),
                      ),
                    }
                  : {}),
              }),
            ),
          )},${p.authorizationEvidenceDigest})`;
    }
    return {
      requestId: p.requestId,
      planDigest: p.digest,
      alreadyApplied: false,
      contexts: await receipt(tx, p),
      historicalClosure: 'not_reclassified' as const,
    };
  });
}
/** Independent unknown-COMMIT recovery. No write, replay, replacement UUID,
 * physical probes or expiry extension are permitted by this entrypoint. */
export async function readNativeTerminalTestRetirement(raw: unknown) {
  const p = plan(raw);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      await tx`set local timezone='UTC'`;
      const previous = await receipt(tx, p);
      return {
        requestId: p.requestId,
        planDigest: p.digest,
        status: previous ? ('completed' as const) : ('not-found' as const),
        contexts: previous,
        historicalClosure: 'not_reclassified' as const,
      };
    },
  );
}
/** The original chat reader calls this in its existing scanner snapshot. */
export async function verifyNativeChatTerminalCutoffRow(
  tx: Tx,
  row: Record<string, postgres.JSONValue>,
) {
  const saved = z
      .object({
        kind: z.literal('development-test-chat-terminal-cutoff-v2'),
        facts: chatFactsSchema,
        physicalProof: physicalSchema,
        legacyExecutor,
      })
      .strict()
      .parse(row.preservation_snapshot),
    s = saved.facts.scope;
  if (
    row.context_kind !== 'chat' ||
    row.context_id !== s.contextId ||
    row.organization_id !== s.organizationId ||
    row.workspace_id !== s.workspaceId ||
    row.owner_id !== s.ownerId ||
    row.reason !== 'development_test_discarded' ||
    !same(saved.facts, await facts(tx, s)) ||
    !same(saved.legacyExecutor.scope, s) ||
    !same(row.origin_snapshot, saved.facts.origin) ||
    !same(row.binding_snapshot, saved.facts.bindings)
  )
    fail('NATIVE_TERMINAL_PRESERVED_FACTS_CHANGED');
  return s;
}
/** Called in the startup reference scanner's same read-only snapshot. */
export async function readVerifiedNativeTerminalTestRetirements(tx: Tx) {
  const rows =
    await tx`select * from allrice_native_context_retirements where context_kind<>'chat' order by context_kind,context_id`;
  const scopes: NativeTerminalTestScope[] = [];
  for (const row of rows) {
    const scope = NativeTerminalTestScopeSchema.parse({
      contextKind: row.context_kind,
      contextId: row.context_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
    });
    if (
      row.preservation_snapshot?.kind !==
        'development-terminal-test-retirement-v1' ||
      !same(row.preservation_snapshot.facts, await facts(tx, scope)) ||
      !same(row.origin_snapshot, row.preservation_snapshot.facts.origin) ||
      !same(row.binding_snapshot, row.preservation_snapshot.facts.bindings) ||
      row.reason !== 'development_test_discarded'
    )
      fail('NATIVE_TERMINAL_PRESERVED_FACTS_CHANGED');
    scopes.push(scope);
  }
  return scopes;
}
