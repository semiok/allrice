import {
  AddEmployeeModuleInputSchema,
  BrandMediaMutationResultSchema,
  BrandMediaReadInputSchema,
  BrandMediaReadResultSchema,
  BrandMediaUserCommandSchema,
  EmployeeModuleScopeSchema,
  brandMediaModule,
  brandMediaRelease,
  type BrandMediaArticle,
  type BrandMediaMutationResult,
  type BrandMediaTopic,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';
import {
  addEmployeeModuleBinding,
  EmployeeModuleError,
  readEmployeeModuleBinding,
  requireEmployeeModuleBinding,
  sameEmployeeModuleRelease,
} from '../employees/employee-module-bindings.ts';
import {
  assertBrandContentFile,
  assertBrandContentImages,
  assertBrandContentSession,
  requireBrandContentScope,
} from '../brand-content/authority.ts';
import {
  BrandContentError,
  brandContentDigest,
} from '../brand-content/rules.ts';
import {
  ReferenceRuntimeError,
  readReferenceSelection,
} from '../reference-runtime.ts';
import {
  applyBrandMediaUserCommand,
  readBrandMediaRecords,
  type BrandMediaScope,
} from './repository.ts';
import { brandMediaFail as fail } from './errors.ts';
import type postgres from 'postgres';

export { BrandMediaError } from './errors.ts';
type Tx = postgres.TransactionSql;
type Db = ReturnType<typeof getDatabase>;

// This is the only brand module adapter to the current core. MET-252/253 can
// replace named port imports here without moving business rules or duplicating
// bindings, requests, audit, permissions or native execution lifecycle.
async function assertReferences(
  tx: Tx,
  context: RequestContext,
  scope: BrandMediaScope,
  references: BrandMediaTopic['references'],
  lock = true,
) {
  for (const pin of references) {
    if (pin.origin === 'file')
      await assertBrandContentFile(tx, context, scope, pin.file, false, lock);
    else {
      const selected = await readReferenceSelection(
        { ...context, workspaceId: scope.workspaceId },
        pin.revisionId,
        tx,
        lock,
      );
      if (selected.selection.sourceId !== pin.sourceId)
        fail('source_reference_invalid');
    }
  }
}
async function assertSourceRun(
  tx: Tx,
  context: RequestContext,
  scope: BrandMediaScope,
  runId: string,
  lock = true,
) {
  const [row] = await tx<{ session_id: string }[]>`
    select er.session_id from allrice_employee_runs er
    join allrice_runs r on r.id=er.run_id and r.organization_id=er.organization_id
      and r.workspace_id=er.workspace_id and r.owner_id=er.owner_id
    join allrice_chat_sessions s on s.id=er.session_id and s.organization_id=er.organization_id
      and s.workspace_id=er.workspace_id and s.owner_id=er.owner_id
    where er.run_id=${runId} and er.organization_id=${scope.organizationId}
      and er.workspace_id=${scope.workspaceId} and er.owner_id=${scope.ownerId}
      and coalesce(s.employee_instance_id,s.employee_assignment_id)=${scope.instanceId}
      ${lock ? tx`for share of er,r` : tx``}`;
  if (!row) fail('source_unavailable');
  await assertBrandContentSession(
    tx,
    context,
    scope,
    row.session_id,
    false,
    lock,
  );
}
async function assertArticle(
  tx: Tx,
  context: RequestContext,
  scope: BrandMediaScope,
  article: BrandMediaArticle,
  lock = true,
) {
  await assertReferences(tx, context, scope, article.references, lock);
  if (article.body)
    await assertBrandContentFile(tx, context, scope, article.body, false, lock);
  await assertBrandContentImages(
    tx,
    context,
    scope,
    article.images.map((image, index) => ({
      file: image.file,
      sourceKind: image.source,
      operationId: image.operationId,
      slotKey: String(index),
      caption: '',
    })),
    lock,
  );
}
async function assertResult(
  tx: Tx,
  context: RequestContext,
  scope: BrandMediaScope,
  result: BrandMediaMutationResult,
  lock = true,
) {
  if (result.kind === 'article')
    await assertArticle(tx, context, scope, result.article, lock);
  if (result.kind === 'topic') {
    await assertReferences(tx, context, scope, result.topic.references, lock);
    await assertSourceRun(tx, context, scope, result.topic.sourceRunId, lock);
  }
}
async function transaction<T>(
  db: Db,
  run: (tx: Tx) => Promise<T>,
  snapshot = false,
) {
  try {
    return await employeeAccessTransaction(
      db,
      run,
      snapshot ? { mode: 'isolation level repeatable read' } : {},
    );
  } catch (error) {
    // Translate only known core source failures. Database/programming errors
    // keep their original identity and surface as 500, never a false conflict.
    if (error instanceof ReferenceRuntimeError) fail('source_unavailable');
    if (
      error instanceof BrandContentError &&
      [
        'source_unavailable',
        'source_changed',
        'source_reference_invalid',
      ].includes(error.code)
    )
      fail(
        error.code as
          'source_unavailable' | 'source_changed' | 'source_reference_invalid',
      );
    throw error;
  }
}
/** Reuse the existing immutable request ledger and its canonical digest. The
 * namespace is shared by add and business commands, so request reuse cannot
 * accidentally execute another operation. Authority is fixed by this entry. */
async function requestOnce<T>(
  tx: Tx,
  context: RequestContext,
  scope: BrandMediaScope,
  requestId: string,
  input: unknown,
  action: string,
  replay: (raw: unknown) => Promise<T>,
  apply: () => Promise<T>,
) {
  const key = `brand-media:${requestId}`,
    digest = brandContentDigest(input);
  const lock = brandContentDigest({ ...scope, requestId: key });
  await tx`select pg_advisory_xact_lock(hashtextextended(${lock},0))`;
  const [old] = await tx<{ input_digest: string; response: unknown }[]>`
    select input_digest,response from allrice_brand_content_requests
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and instance_id=${scope.instanceId} and request_id=${key}`;
  if (old) {
    if (old.input_digest !== digest) fail('request_conflict');
    return { result: await replay(old.response), replayed: true };
  }
  const result = await apply();
  await tx`insert into allrice_brand_content_requests
    (organization_id,workspace_id,owner_id,instance_id,request_id,input_digest,authority,response)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},
      ${key},${digest},'user',${tx.json(JSON.parse(JSON.stringify(result)))})`;
  await tx`insert into allrice_audit_events
    (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${`brand.media.${action}`},
      'employee_instance',${scope.instanceId},'recorded','human_business_action',${context.requestId},
      ${tx.json({ instanceId: scope.instanceId, module: brandMediaRelease, inputDigest: digest, requestId })})`;
  return { result, replayed: false };
}
export async function listEmployeeInstanceModules(
  context: RequestContext,
  raw: unknown,
  db: Db = getDatabase(),
) {
  const input = EmployeeModuleScopeSchema.parse(raw);
  return transaction(
    db,
    async (tx) => {
      const scope = await requireBrandContentScope(
        tx,
        context,
        input,
        false,
        'user',
        false,
      );
      const binding = await readEmployeeModuleBinding(
        tx,
        scope,
        brandMediaModule.id,
        false,
      );
      // Static assembly, no second registration or mutable catalog authority.
      return {
        modules: [
          {
            descriptor: brandMediaModule,
            binding,
            available: !binding,
            enabled:
              !!binding &&
              !binding.revokedAt &&
              Date.parse(binding.enabledAt) <= Date.now() &&
              sameEmployeeModuleRelease(binding.release, brandMediaRelease),
          },
        ],
      };
    },
    true,
  );
}
export async function addEmployeeInstanceModule(
  context: RequestContext,
  raw: unknown,
  db: Db = getDatabase(),
) {
  const input = AddEmployeeModuleInputSchema.parse(raw);
  return transaction(db, async (tx) => {
    const scope = await requireBrandContentScope(tx, context, input, true);
    if (!sameEmployeeModuleRelease(input.release, brandMediaRelease))
      throw new EmployeeModuleError('module_version_conflict');
    const response = await requestOnce(
      tx,
      context,
      scope,
      input.requestId,
      input,
      'module.add',
      async () => requireEmployeeModuleBinding(tx, scope, brandMediaRelease),
      () => addEmployeeModuleBinding(tx, scope, brandMediaRelease),
    );
    return { binding: response.result, replayed: response.replayed };
  });
}
/** Human-only input: no body submission, execution authority or enablement
 * facts can be supplied by the browser. No Worker tool is implemented in P2. */
export async function commandBrandMediaUser(
  context: RequestContext,
  raw: unknown,
  db: Db = getDatabase(),
) {
  const input = BrandMediaUserCommandSchema.parse(raw);
  return transaction(db, async (tx) => {
    const scope = await requireBrandContentScope(tx, context, input, true);
    await requireEmployeeModuleBinding(tx, scope, brandMediaRelease);
    if ('references' in input)
      await assertReferences(tx, context, scope, input.references);
    if (input.operation === 'topic.add')
      await assertSourceRun(tx, context, scope, input.sourceRunId);
    if (input.operation === 'article.image.add')
      await assertBrandContentImages(tx, context, scope, [
        {
          file: input.image.file,
          sourceKind: input.image.source,
          operationId: input.image.operationId,
          slotKey: '0',
          caption: '',
        },
      ]);
    return requestOnce(
      tx,
      context,
      scope,
      input.requestId,
      { command: input, module: brandMediaRelease },
      input.operation,
      async (rawResult) => {
        const result = BrandMediaMutationResultSchema.parse(rawResult);
        await assertResult(tx, context, scope, result);
        return result;
      },
      async () => {
        const result = await applyBrandMediaUserCommand(tx, scope, input);
        await assertResult(tx, context, scope, result);
        return result;
      },
    );
  });
}
export async function readBrandMedia(
  context: RequestContext,
  raw: unknown,
  db: Db = getDatabase(),
) {
  const input = BrandMediaReadInputSchema.parse(raw);
  return transaction(
    db,
    async (tx) => {
      const scope = await requireBrandContentScope(
        tx,
        context,
        input,
        false,
        'user',
        false,
      );
      await requireEmployeeModuleBinding(
        tx,
        scope,
        brandMediaRelease,
        undefined,
        false,
      );
      const result = BrandMediaReadResultSchema.parse(
        await readBrandMediaRecords(tx, scope, input),
      );
      if (result.view === 'article')
        await assertArticle(tx, context, scope, result.article, false);
      else if (result.view === 'topics') {
        for (const topic of result.items)
          await assertResult(
            tx,
            context,
            scope,
            { kind: 'topic', topic },
            false,
          );
      } else
        for (const article of result.items)
          await assertArticle(tx, context, scope, article, false);
      return result;
    },
    true,
  );
}
