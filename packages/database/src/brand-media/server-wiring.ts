import {
  AddEmployeeModuleInputSchema,
  BrandMediaArticleSubmissionSchema,
  BrandMediaGenerateInputSchema,
  BrandMediaInvocationSchema,
  EmployeeExecutionSnapshotSchema,
  brandMediaTools,
  brandMediaIntentReferences,
  allRiceToolManifest,
  withPlatformImageTools,
  brandMediaUsage,
  brandMediaSkillId,
  type BrandMediaInvocation,
  type BrandMediaGenerateInput,
  type EmployeeModuleBinding,
  type SkillCapability,
  type EmployeeExecutionSnapshot,
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
import { DataAccessError } from '../data.ts';
import { workbenchOriginFileAccess } from '../workbench-file-access.ts';
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
  readBrandMediaWritingSource,
  submitBrandMediaArticleRecord,
  type BrandMediaScope,
} from './repository.ts';
import { BrandMediaError, brandMediaFail as fail } from './errors.ts';
import type postgres from 'postgres';
import type { BrandContentIdentity } from '../brand-content/types.ts';
import { getEmployeeInstance } from '../employees/employee-instances.ts';
import {
  assertEmployeeChatToolExecution,
  assertEmployeeChatHumanSource,
  employeeChatIdentity,
  employeeChatUuid,
  type EmployeeChatCall,
} from '../employees/employee-chat-authority.ts';
import {
  skillBundleChecksum,
  skillBytesChecksum,
  validateFrozenSkill,
  readFrozenSkillResource,
} from '../skill-bundles.ts';
import {
  createChatSession,
  sendChatMessage,
  linkFileToSession,
} from '../workspace/service.ts';
import { getRun } from '../execution/queue.ts';
import {
  ArtifactReviewError,
  readArtifact,
  readArtifactBytes,
} from '../artifact-review.ts';
import type { StoragePort } from '@allrice/contracts';

export { BrandMediaError } from './errors.ts';
type Tx = postgres.TransactionSql;
type Db = ReturnType<typeof getDatabase>;

// This is the only brand module adapter to the current core. MET-252/253 can
// replace named port imports here without moving business rules or duplicating
// bindings, requests, audit, permissions or native execution lifecycle.
async function holdFileAuthority(
  tx: Tx,
  context: BrandContentIdentity,
  scope: BrandMediaScope,
  file: Parameters<typeof assertBrandContentFile>[3],
  lock: boolean,
) {
  if (!lock) return;
  // Use the core identity -> policy -> storage order before the existing
  // readers take their storage/version locks. Hold current ACL through COMMIT.
  const access = await workbenchOriginFileAccess(
    { ...context, workspaceId: scope.workspaceId },
    file.objectId,
    tx,
    true,
  );
  if (!access.canRead) {
    // Preserve the existing source/error checks and denial audit, then fail
    // closed even if a narrower reader ever admits this denied origin.
    await assertBrandContentFile(tx, context, scope, file, false, lock);
    throw new DataAccessError('authorization_denied');
  }
}
async function assertImages(
  tx: Tx,
  context: BrandContentIdentity,
  scope: BrandMediaScope,
  images: BrandMediaArticle['images'],
  lock = true,
) {
  for (const image of images) {
    await holdFileAuthority(tx, context, scope, image.file, lock);
    if ('origin' in image)
      await assertUpload(tx, scope, image.file, lock, true);
  }
  // Media types, exact versions and generated-operation receipts remain core.
  await assertBrandContentImages(
    tx,
    context,
    scope,
    images.map((image, index) => ({
      file: image.file,
      sourceKind: image.source,
      operationId: 'operationId' in image ? image.operationId : undefined,
      slotKey: String(index),
      caption: '',
    })),
    lock,
  );
}
async function assertUpload(
  tx: Tx,
  scope: BrandMediaScope,
  file: { objectId: string; checksum: string },
  lock: boolean,
  image = false,
) {
  const [uploaded] =
    await tx`select id from allrice_storage_objects where id=${file.objectId}
    and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
    and category='uploads' and immutable and state='ready' and deleted_at is null and checksum=${file.checksum}
    and (${!image} or media_type in ('image/png','image/jpeg')) ${lock ? tx`for share` : tx``}`;
  if (!uploaded) fail('source_reference_invalid');
}
async function assertReferences(
  tx: Tx,
  context: BrandContentIdentity,
  scope: BrandMediaScope,
  references: BrandMediaTopic['references'],
  lock = true,
) {
  for (const pin of references) {
    if (pin.origin === 'file' || pin.origin === 'upload') {
      await holdFileAuthority(tx, context, scope, pin.file, lock);
      await assertBrandContentFile(tx, context, scope, pin.file, false, lock);
      if (pin.origin === 'upload')
        await assertUpload(tx, scope, pin.file, lock);
    } else {
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
  context: BrandContentIdentity,
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
  context: BrandContentIdentity,
  scope: BrandMediaScope,
  article: BrandMediaArticle,
  lock = true,
) {
  await assertReferences(tx, context, scope, article.references, lock);
  if (article.body) {
    await holdFileAuthority(tx, context, scope, article.body, lock);
    await assertBrandContentFile(tx, context, scope, article.body, false, lock);
  }
  await assertImages(tx, context, scope, article.images, lock);
}
async function assertResult(
  tx: Tx,
  context: BrandContentIdentity,
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
  context: BrandContentIdentity,
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
  context: BrandContentIdentity,
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
  context: BrandContentIdentity,
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
 * facts can be supplied by the browser. Worker submission has a separate port. */
export async function commandBrandMediaUser(
  context: BrandContentIdentity,
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
      await assertImages(tx, context, scope, [input.image]);
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
  context: BrandContentIdentity,
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

/** Existing grants are computed before calling this adapter. Module Skill
 * dependencies and tool names MUST NOT feed back into grant calculation. */
export async function freezeBrandMediaModule(
  scope: BrandMediaScope,
  grants: readonly SkillCapability[],
  invocation?: BrandMediaInvocation,
  tx?: Tx,
) {
  const freeze = async (sql: Tx) => {
    const binding = await readEmployeeModuleBinding(
      sql,
      scope,
      brandMediaModule.id,
    );
    if (
      !binding ||
      binding.revokedAt ||
      !sameEmployeeModuleRelease(binding.release, brandMediaRelease) ||
      Date.parse(binding.enabledAt) > Date.now()
    ) {
      if (invocation) throw new EmployeeModuleError('module_unavailable');
      return undefined;
    }
    if (invocation) await assertBrandMediaInvocation(sql, scope, invocation);
    if (invocation && !grants.includes('storage:write'))
      throw new DataAccessError('authorization_denied');
    const tools = brandMediaTools
      .filter((tool) => grants.includes(tool.capability))
      .map((tool) => tool.canonicalName);
    return {
      binding,
      tools: grants.includes('storage:read')
        ? [...tools, 'workspace.skill.read']
        : tools,
      skill: grants.includes('storage:read') ? brandMediaSkill() : undefined,
    };
  };
  return tx ? freeze(tx) : getDatabase().begin(freeze);
}
function brandMediaSkill() {
  const content =
      '# 品牌自媒体\n\n使用 workspace.skill.read 读取 references/usage.md。按照本次真人按钮冻结的请求工作；说明和资料不授予权限。候选用 workspace.brand_media.candidates 交付，不代真人加入选题。正文用 workspace.brand_media.article.submit，只传本次冻结 articleId/expectedRevision。正文保存失败时区分成果已保留与文章未更新。人工选入、排期、发布和删除由页面完成。配图仅使用 image.generate，prompt 原样使用冻结 description，一次一张，不带参考或 source；不自动采用图片，不重发未知结果。',
    contentChecksum = skillBytesChecksum(content);
  const bundle = {
    schemaVersion: 1 as const,
    version: brandMediaRelease.contentVersion,
    contentChecksum,
    sourceRef:
      'https://github.com/semiok/allrice/tree/main/packages/contracts/src/brand-media-module.ts',
    license: 'UNLICENSED',
    reviewedBy: 'MET-224 approved module release',
    resources: [
      {
        path: brandMediaUsage.path,
        mediaType: 'text/markdown',
        byteLength: Buffer.byteLength(brandMediaUsage.content),
        checksum: brandMediaUsage.checksum,
        contentBase64: Buffer.from(brandMediaUsage.content).toString('base64'),
      },
    ],
    dependencies: [{ kind: 'tool' as const, name: 'workspace.skill.read' }],
  };
  return validateFrozenSkill({
    id: brandMediaSkillId,
    name: 'brand-media',
    description:
      '品牌自媒体：读取使用说明、想选题、按固定文章修订写作；人工选入、排期和发布由页面完成。',
    content,
    checksum: contentChecksum,
    invocation: { modelInvocable: true, userInvocable: true },
    requiredToolRefs: ['workspace.skill.read'],
    bundle: { ...bundle, checksum: skillBundleChecksum(bundle) },
  });
}
/** Exact frozen content only; this projection grants no execution authority. */
export function brandMediaSnapshotSkill(snapshot: EmployeeExecutionSnapshot) {
  if (
    snapshot.schemaVersion !== 2 ||
    !snapshot.modules?.some(
      (binding) =>
        sameEmployeeModuleRelease(binding.release, brandMediaRelease) &&
        !binding.revokedAt &&
        Date.parse(binding.enabledAt) <= Date.parse(snapshot.createdAt) &&
        binding.instanceId === snapshot.instance?.id &&
        binding.organizationId === snapshot.tenantContext.organizationId &&
        binding.workspaceId === snapshot.tenantContext.workspaceId &&
        binding.ownerId === snapshot.tenantContext.actorId,
    )
  )
    return undefined;
  return snapshot.capabilitySnapshot.grantedCapabilities.includes(
    'storage:read',
  )
    ? brandMediaSkill()
    : undefined;
}
async function assertBrandMediaInvocation(
  tx: Tx,
  scope: BrandMediaScope,
  raw: BrandMediaInvocation,
  checkTarget = true,
) {
  const invocation = BrandMediaInvocationSchema.parse(raw),
    { module, intent } = invocation;
  if (
    module.organizationId !== scope.organizationId ||
    module.ownerId !== scope.ownerId ||
    module.workspaceId !== scope.workspaceId ||
    module.instanceId !== scope.instanceId ||
    intent.workspaceId !== scope.workspaceId ||
    intent.instanceId !== scope.instanceId
  )
    throw new DataAccessError('authorization_denied');
  await requireEmployeeModuleBinding(
    tx,
    scope,
    brandMediaRelease,
    module.revision,
  );
  if (!sameEmployeeModuleRelease(module.release, brandMediaRelease))
    throw new EmployeeModuleError('module_version_conflict');
  if (checkTarget && intent.operation !== 'candidates') {
    const record = await readBrandMediaRecords(tx, scope, {
      workspaceId: scope.workspaceId,
      instanceId: scope.instanceId,
      view: 'article',
      articleId: intent.articleId,
    });
    if (record.view !== 'article') fail('not_found');
    if (record.article.revision !== intent.expectedRevision)
      fail('version_conflict');
    if (record.article.publication.state === 'published') fail('invalid_state');
    if (
      intent.operation === 'article' &&
      brandContentDigest(record.article.references) !==
        brandContentDigest(intent.references)
    )
      fail('source_reference_invalid');
  }
  return invocation;
}
/** Rechecked inside the original enqueue transaction and before every tool
 * read/write. No new Run table, dispatcher, queue or authorization ledger. */
export async function assertFrozenBrandMediaModule(
  tx: Tx,
  snapshot: EmployeeExecutionSnapshot,
  scope: Omit<BrandMediaScope, 'instanceId'>,
  checkTarget = true,
) {
  if (snapshot.schemaVersion !== 2) return;
  // Model-use callers also carry Run/Session identity. Only module authority
  // belongs in the strict binding DTO; those execution fields stay at its gate.
  const ownerScope = {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
  };
  for (const module of snapshot.modules ?? []) {
    if (module.release.moduleId !== brandMediaModule.id) continue;
    if (
      module.organizationId !== scope.organizationId ||
      module.workspaceId !== scope.workspaceId ||
      module.ownerId !== scope.ownerId ||
      module.instanceId !== snapshot.instance?.id
    )
      throw new DataAccessError('authorization_denied');
    await requireEmployeeModuleBinding(
      tx,
      { ...ownerScope, instanceId: module.instanceId },
      module.release,
      module.revision,
    );
  }
  if (snapshot.moduleInvocation) {
    if (
      snapshot.moduleInvocation.intent.operation === 'image' &&
      !withPlatformImageTools(
        snapshot.capabilitySnapshot.bindings.toolNames,
        snapshot.capabilitySnapshot.grantedCapabilities,
        snapshot.modelSnapshot,
      ).includes('image.generate')
    )
      throw new DataAccessError('authorization_denied');
    if (
      !snapshot.modules?.some(
        (module) =>
          brandContentDigest(module) ===
          brandContentDigest(snapshot.moduleInvocation!.module),
      )
    )
      throw new DataAccessError('authorization_denied');
    await assertBrandMediaInvocation(
      tx,
      { ...ownerScope, instanceId: snapshot.instance!.id },
      snapshot.moduleInvocation,
      checkTarget,
    );
    const identity: BrandContentIdentity = {
      actor: { type: 'user', id: scope.ownerId },
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      requestId: snapshot.moduleInvocation.intent.requestId,
      memberships: [],
      authenticatedAt: snapshot.createdAt,
    };
    const currentScope = await requireBrandContentScope(
      tx,
      identity,
      { ...ownerScope, instanceId: snapshot.instance!.id },
      true,
      'workflow',
    );
    await assertReferences(
      tx,
      identity,
      currentScope,
      brandMediaIntentReferences(snapshot.moduleInvocation.intent),
    );
  }
}
/** Authenticated browser endpoint. A missing chat uses a server-fixed Session
 * with the ordinary account capability freeze; the host selection is untouched. */
export async function generateBrandMedia(
  context: RequestContext,
  raw: unknown,
) {
  let intent = BrandMediaGenerateInputSchema.parse(raw);
  const module = await transaction(getDatabase(), async (tx) => {
    const scope = await requireBrandContentScope(tx, context, intent, true);
    if (intent.operation === 'image' && intent.retryOfRunId)
      intent = await resolveImageRetry(tx, scope, intent);
    await assertReferences(
      tx,
      context,
      scope,
      brandMediaIntentReferences(intent),
    );
    if (intent.sessionId)
      await assertBrandContentSession(
        tx,
        context,
        scope,
        intent.sessionId,
        true,
      );
    return requireEmployeeModuleBinding(tx, scope, brandMediaRelease);
  });
  const sessionId =
    intent.sessionId ??
    employeeChatUuid(
      'brand-media-session',
      context.organizationId,
      intent.workspaceId,
      context.actor.id,
      intent.instanceId,
      intent.requestId,
    );
  if (!intent.sessionId)
    await createChatSession(
      context,
      {
        workspaceId: intent.workspaceId,
        employeeInstanceId: intent.instanceId,
        title: '品牌自媒体',
      },
      { sessionId, freezeAccountCapabilities: true },
    );
  const { uploadIds, writingSource } = await transaction(
    getDatabase(),
    async (tx) => {
      const scope = await requireBrandContentScope(tx, context, intent, true);
      await requireEmployeeModuleBinding(
        tx,
        scope,
        brandMediaRelease,
        module.revision,
      );
      await assertReferences(
        tx,
        context,
        scope,
        brandMediaIntentReferences(intent),
      );
      const ids = [];
      for (const pin of brandMediaIntentReferences(intent))
        if (pin.origin === 'upload') {
          const [file] =
            await tx`select file_name from allrice_workbench_file_policies where object_id=${pin.file.objectId}
        and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} for share`;
          if (!file) fail('source_unavailable');
          await linkFileToSession({
            context,
            workspaceId: scope.workspaceId,
            sessionId,
            objectId: pin.file.objectId,
            fileName: file.file_name,
            database: tx,
          });
          ids.push(pin.file.objectId);
        }
      const writingSource =
        intent.operation === 'article'
          ? await readBrandMediaWritingSource(tx, scope, intent.articleId)
          : null;
      return { uploadIds: ids, writingSource };
    },
  );
  const invocation = BrandMediaInvocationSchema.parse({ module, intent });
  const receipt = await sendChatMessage(
    context,
    intent.workspaceId,
    sessionId,
    {
      clientMessageId: intent.requestId,
      deliveryMode: 'follow_up',
      attachmentIds: uploadIds,
      text:
        '品牌自媒体页面请求。请先读取 brand-media 使用说明，再完成本次固定请求。候选只交付，不加入选题；正文只提交固定 articleId/revision；配图仅用 image.generate，prompt 原样使用冻结 description，一次一张，不修改或自动加入文章。\n' +
        JSON.stringify(intent) +
        (writingSource
          ? '\n服务端固定选题与写作要求：\n' + JSON.stringify(writingSource)
          : ''),
      referenceRevisionIds: brandMediaIntentReferences(intent).flatMap((pin) =>
        pin.origin === 'reference' ? [pin.revisionId] : [],
      ),
    },
    { moduleInvocation: invocation },
  );
  return { ...receipt, invocation };
}
async function resolveImageRetry(
  tx: Tx,
  scope: BrandMediaScope,
  intent: Extract<BrandMediaGenerateInput, { operation: 'image' }>,
) {
  const [prior] = await tx<
    { execution_snapshot: unknown; session_id: string; state: string }[]
  >`
    select e.execution_snapshot,e.session_id,r.state from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id and r.owner_id=e.owner_id
    where e.run_id=${intent.retryOfRunId!} and e.organization_id=${scope.organizationId}
      and e.workspace_id=${scope.workspaceId} and e.owner_id=${scope.ownerId} for share of e,r`;
  const frozen = EmployeeExecutionSnapshotSchema.safeParse(
    prior?.execution_snapshot,
  );
  const invocation =
    frozen.success && frozen.data.schemaVersion === 2
      ? frozen.data.moduleInvocation
      : undefined;
  if (
    !prior ||
    !['failed', 'succeeded'].includes(prior.state) ||
    invocation?.intent.operation !== 'image' ||
    invocation.module.instanceId !== scope.instanceId ||
    !sameEmployeeModuleRelease(invocation.module.release, brandMediaRelease)
  )
    fail('source_unavailable');
  const operations = await tx<
    { status: string }[]
  >`select status from allrice_image_operations
    where run_id=${intent.retryOfRunId!} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} for share`;
  const artifacts =
    await tx`select a.version_id from allrice_workbench_artifacts a
    join allrice_deliverable_versions v on v.id=a.version_id
    where a.run_id=${intent.retryOfRunId!} and a.organization_id=${scope.organizationId}
      and a.workspace_id=${scope.workspaceId} and a.owner_id=${scope.ownerId} and v.format='png'`;
  if (
    artifacts.length ||
    operations.some((operation) => operation.status !== 'failed') ||
    (prior.state === 'succeeded' && operations.length !== 1)
  )
    fail('invalid_state');
  const expected = {
    ...invocation.intent,
    requestId: employeeChatUuid(
      'brand-media-retry',
      scope.organizationId,
      scope.workspaceId,
      scope.ownerId,
      scope.instanceId,
      intent.retryOfRunId!,
    ),
    sessionId: prior.session_id,
    retryOfRunId: intent.retryOfRunId,
  };
  if (
    brandContentDigest({
      ...intent,
      sessionId: intent.sessionId ?? prior.session_id,
    }) !== brandContentDigest(expected)
  )
    fail('request_conflict');
  return expected;
}
export async function readBrandMediaUsage(
  context: RequestContext,
  raw: unknown,
) {
  const input = EmployeeModuleScopeSchema.parse(raw);
  return transaction(
    getDatabase(),
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
      return brandMediaUsage;
    },
    true,
  );
}
/** Private Worker admission. Current scope/instance and lease share the exact
 * core implementation used by intrinsic tools; no tool-name impersonation. */
export async function authorizeBrandMediaTool(
  call: EmployeeChatCall,
  name: string,
) {
  const tool = brandMediaTools.find((entry) => entry.canonicalName === name);
  const imageTool =
    name === 'image.generate'
      ? allRiceToolManifest.find((entry) => entry.canonicalName === name)
      : undefined;
  const readingSkill = name === 'workspace.skill.read';
  if (!tool && !readingSkill && !imageTool)
    throw new DataAccessError('authorization_denied');
  const capability =
    tool?.capability ?? imageTool?.capability ?? 'storage:read';
  if (capability !== 'storage:read' && capability !== 'storage:write')
    throw new DataAccessError('authorization_denied');
  const { ctx, scope: identity } = employeeChatIdentity(call);
  const [row] = await getDatabase()<{ execution_snapshot: unknown }[]>`
    select execution_snapshot from allrice_employee_runs where run_id=${ctx.runId} and organization_id=${ctx.organizationId}
      and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId}
      and session_id=${call.sessionId} and user_message_id=${call.userMessageId}`;
  const snapshot = EmployeeExecutionSnapshotSchema.parse(
    row?.execution_snapshot,
  );
  if (
    snapshot.schemaVersion !== 2 ||
    !snapshot.instance ||
    !snapshot.modules?.some((module) =>
      sameEmployeeModuleRelease(module.release, brandMediaRelease),
    )
  )
    throw new DataAccessError('authorization_denied');
  const scope = {
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId!,
    ownerId: ctx.policySnapshot.subjectId,
    instanceId: snapshot.instance.id,
  };
  const context: BrandContentIdentity = {
    ...identity,
    memberships: ctx.policySnapshot.memberships,
    authenticatedAt: ctx.startedAt,
  };
  const beforeCommit = async (tx: Tx, checkTarget = false) => {
    await requireBrandContentScope(
      tx,
      context,
      scope,
      capability === 'storage:write',
      'workflow',
    );
    const instance = await getEmployeeInstance(identity, scope.instanceId, tx);
    const live = await assertEmployeeChatToolExecution(tx, call, instance, {
      name,
      capability,
    });
    await assertEmployeeChatHumanSource(call, tx);
    await assertFrozenBrandMediaModule(
      tx,
      live.snapshot,
      scope,
      checkTarget &&
        (name === 'workspace.brand_media.article.submit' || !!imageTool),
    );
    if (tool?.risk === 'managed_write' || imageTool) {
      const invocation = live.snapshot.moduleInvocation;
      if (
        !invocation ||
        (imageTool
          ? invocation.intent.operation !== 'image'
          : tool?.handlerRef === 'candidates'
            ? invocation.intent.operation !== 'candidates'
            : invocation.intent.operation !== 'article')
      )
        throw new DataAccessError('authorization_denied');
      await assertReferences(
        tx,
        context,
        scope,
        brandMediaIntentReferences(invocation.intent),
      );
    }
  };
  await transaction(getDatabase(), (tx) => beforeCommit(tx));
  return {
    context,
    scope,
    invocation: snapshot.moduleInvocation,
    beforeCommit,
  };
}
/** Only a real frozen module invocation activates the additional gate. Ordinary
 * image generation/editing keeps the original native authority and semantics. */
export async function authorizeBrandMediaImage(
  call: EmployeeChatCall,
  name: string,
) {
  const { context } = call;
  const [row] = await getDatabase()<{ invocation: unknown }[]>`
    select execution_snapshot->'moduleInvocation' invocation from allrice_employee_runs
    where run_id=${context.runId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId!} and owner_id=${context.policySnapshot.subjectId}`;
  if (!row?.invocation) return undefined;
  if (
    !call.userMessageId ||
    !Number.isSafeInteger(call.worker.attempt) ||
    call.worker.attempt < 0
  )
    throw new DataAccessError('authorization_denied');
  const { intent } = BrandMediaInvocationSchema.parse(row.invocation);
  const args = call.arguments as { prompt?: unknown; source?: unknown };
  if (
    intent.operation !== 'image' ||
    name !== 'image.generate' ||
    args.prompt !== intent.description ||
    args.source !== undefined
  )
    throw new DataAccessError('authorization_denied');
  return authorizeBrandMediaTool(call, name);
}
export async function readBrandMediaTool(
  call: EmployeeChatCall,
  args: Record<string, unknown>,
) {
  const authority = await authorizeBrandMediaTool(
    call,
    'workspace.brand_media.read',
  );
  return transaction(getDatabase(), async (tx) => {
    await authority.beforeCommit(tx);
    const input = BrandMediaReadInputSchema.parse({
      ...args,
      workspaceId: authority.scope.workspaceId,
      instanceId: authority.scope.instanceId,
    });
    const result = await readBrandMediaRecords(tx, authority.scope, input);
    if (result.view === 'article')
      await assertArticle(
        tx,
        authority.context,
        authority.scope,
        result.article,
      );
    else
      for (const item of result.items)
        await assertResult(
          tx,
          authority.context,
          authority.scope,
          result.view === 'topics'
            ? { kind: 'topic', topic: item as BrandMediaTopic }
            : { kind: 'article', article: item as BrandMediaArticle },
        );
    return result;
  });
}
/** A one-way audit of the existing immutable delivery, committed with it. */
export async function recordBrandMediaDelivery(
  tx: Tx,
  call: EmployeeChatCall,
  name: string,
  artifactId: string,
) {
  const { ctx } = employeeChatIdentity(call);
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
    values(${ctx.organizationId},${ctx.workspaceId!},${ctx.policySnapshot.subjectId},'brand.media.delivery','deliverable_version',${artifactId},
      'recorded','immutable_module_delivery',${tx.json({ runId: ctx.runId, tool: name, callId: call.callId, module: brandMediaRelease })})`;
}
export async function submitBrandMediaArticle(
  call: EmployeeChatCall,
  raw: unknown,
) {
  const input = BrandMediaArticleSubmissionSchema.parse(raw);
  const authority = await authorizeBrandMediaTool(
    call,
    'workspace.brand_media.article.submit',
  );
  const intent = authority.invocation?.intent;
  if (
    !intent ||
    intent.operation !== 'article' ||
    input.articleId !== intent.articleId ||
    input.expectedRevision !== intent.expectedRevision ||
    input.requestId !== authority.invocation!.intent.requestId ||
    input.workspaceId !== authority.scope.workspaceId ||
    input.instanceId !== authority.scope.instanceId
  )
    throw new DataAccessError('authorization_denied');
  return transaction(getDatabase(), async (tx) => {
    // Replay can read the completed revision, but still checks current authority.
    await authority.beforeCommit(tx, false);
    return requestOnce(
      tx,
      authority.context,
      authority.scope,
      input.requestId,
      { submission: input, runId: call.context.runId },
      'article.submit',
      async (result) => {
        const article = BrandMediaMutationResultSchema.parse(result);
        await assertResult(tx, authority.context, authority.scope, article);
        return article;
      },
      async () => {
        await authority.beforeCommit(tx, true);
        await holdFileAuthority(
          tx,
          authority.context,
          authority.scope,
          input.body,
          true,
        );
        await assertBrandContentFile(
          tx,
          authority.context,
          authority.scope,
          input.body,
        );
        const [delivery] =
          await tx`select a.version_id from allrice_workbench_artifacts a
        join allrice_audit_events e on e.resource_id=a.version_id and e.action='brand.media.delivery'
        where a.version_id=${input.body.versionId} and a.run_id=${call.context.runId} and a.organization_id=${authority.scope.organizationId}
          and a.workspace_id=${authority.scope.workspaceId} and a.owner_id=${authority.scope.ownerId}
          and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id and e.actor_id=a.owner_id
          and e.metadata->>'tool'='workspace.brand_media.article.submit' and e.metadata->>'callId'=${call.callId} for share of a`;
        if (!delivery) fail('source_reference_invalid');
        const article = await submitBrandMediaArticleRecord(
          tx,
          authority.scope,
          input,
        );
        await assertArticle(tx, authority.context, authority.scope, article);
        return { kind: 'article' as const, article };
      },
    );
  });
}
export async function readBrandMediaSkill(
  call: EmployeeChatCall,
  skills: Parameters<typeof readFrozenSkillResource>[0],
  path: string,
) {
  const authority = await authorizeBrandMediaTool(call, 'workspace.skill.read');
  return transaction(getDatabase(), async (tx) => {
    await authority.beforeCommit(tx);
    const result = readFrozenSkillResource(skills, 'brand-media', path);
    if (
      result.checksum !== brandMediaUsage.checksum ||
      result.bundleChecksum !== brandMediaSkill().bundle!.checksum
    )
      throw new DataAccessError('authorization_denied');
    return result;
  });
}
/** Cold recovery projects existing Run/artifact facts, including failed/cancelled
 * Runs whose immutable delivery survived a business CAS conflict. */
async function readBrandMediaImage(
  tx: Tx,
  context: BrandContentIdentity,
  scope: BrandMediaScope,
  row: { run_id: string; session_id: string },
  runStatus: Awaited<ReturnType<typeof getRun>>['status'],
) {
  const [operation] = await tx<
    {
      id: string;
      operation_count: number;
      status: 'running' | 'succeeded' | 'failed' | 'unknown';
      result: { modelContent?: string } | null;
    }[]
  >`
    select i.id,i.result,(count(*) over())::integer operation_count,case when i.status='running' and not exists(select 1 from allrice_jobs j
      where j.run_id=i.run_id and j.status='running' and j.cancel_requested_at is null
        and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()) then 'unknown' else i.status end status
    from allrice_image_operations i where i.run_id=${row.run_id} and i.session_id=${row.session_id}
      and i.organization_id=${scope.organizationId} and i.workspace_id=${scope.workspaceId} and i.owner_id=${scope.ownerId}
    order by i.created_at,i.id limit 1`;
  const [output] = operation
    ? await tx<{ version_id: string }[]>`
    select version_id from allrice_workbench_artifacts where run_id=${row.run_id}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
      and request_id=${'image:' + operation.id}`
    : [];
  let file: BrandMediaArticle['body'] = null,
    fileName: string | null = null,
    adoptable = false;
  if (output) {
    const artifact = await readArtifact(
      tx,
      context,
      row.session_id,
      output.version_id,
    );
    file = {
      objectId: artifact.object.id,
      versionId: artifact.id,
      checksum: artifact.object.checksum,
    };
    await assertBrandContentFile(tx, context, scope, file, true, false);
    if (
      artifact.version.format !== 'png' ||
      artifact.provenance.kind !== 'tool_result' ||
      artifact.provenance.runId !== row.run_id
    )
      fail('source_reference_invalid');
    fileName = artifact.version.fileName;
    let receipt: {
      objectId?: string;
      artifactId?: string;
      checksum?: string;
    } | null = null;
    try {
      receipt = JSON.parse(operation?.result?.modelContent ?? 'null');
    } catch {
      /* Incomplete receipt is not a grant. */
    }
    if (
      operation?.status === 'succeeded' &&
      receipt?.objectId === file.objectId &&
      receipt.artifactId === file.versionId &&
      receipt.checksum === file.checksum
    ) {
      await assertImages(
        tx,
        context,
        scope,
        [{ source: 'generated', operationId: operation.id, file }],
        false,
      );
      adoptable = true;
    }
  }
  return {
    operationId: operation?.id ?? null,
    status: operation?.status ?? null,
    file,
    fileName,
    adoptable,
    retryable:
      !output &&
      (runStatus === 'failed'
        ? !operation || operation.status === 'failed'
        : runStatus === 'succeeded' &&
          operation?.status === 'failed' &&
          operation.operation_count === 1),
  };
}
export async function readBrandMediaRuns(
  context: RequestContext,
  raw: unknown,
  storage: StoragePort,
) {
  const input = EmployeeModuleScopeSchema.parse(raw);
  return transaction(
    getDatabase(),
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
      const rows = await tx<
        { run_id: string; session_id: string; execution_snapshot: unknown }[]
      >`
      select distinct on (er.execution_snapshot->'moduleInvocation'->'intent'->>'operation', er.execution_snapshot->'moduleInvocation'->'intent'->>'articleId')
        er.run_id,er.session_id,er.execution_snapshot from allrice_employee_runs er
      where er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId} and er.owner_id=${scope.ownerId}
        and er.execution_snapshot->'instance'->>'id'=${scope.instanceId}
        and er.execution_snapshot->'moduleInvocation'->'module'->'release'=${tx.json(brandMediaRelease)}
      order by er.execution_snapshot->'moduleInvocation'->'intent'->>'operation', er.execution_snapshot->'moduleInvocation'->'intent'->>'articleId', er.created_at desc,er.run_id desc`;
      const results = [];
      for (const row of rows) {
        const snapshot = EmployeeExecutionSnapshotSchema.parse(
          row.execution_snapshot,
        );
        if (snapshot.schemaVersion !== 2 || !snapshot.moduleInvocation)
          throw new DataAccessError('authorization_denied');
        const native = {
          run: await getRun(context, scope.workspaceId, row.run_id),
          sessionId: row.session_id,
          invocation: snapshot.moduleInvocation,
        };
        try {
          const intent = snapshot.moduleInvocation.intent;
          if (intent.operation !== 'candidates')
            await readBrandMediaRecords(tx, scope, {
              ...input,
              view: 'article',
              articleId: intent.articleId,
            });
          await assertReferences(
            tx,
            context,
            scope,
            brandMediaIntentReferences(intent),
            false,
          );
          const image =
            intent.operation === 'image'
              ? await readBrandMediaImage(
                  tx,
                  context,
                  scope,
                  row,
                  native.run.status,
                )
              : null;
          const outputs =
            intent.operation === 'image'
              ? []
              : await tx<
                  { version_id: string }[]
                >`select a.version_id from allrice_workbench_artifacts a
        join allrice_audit_events e on e.resource_id=a.version_id and e.action='brand.media.delivery'
        where a.run_id=${row.run_id} and a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId} and a.owner_id=${scope.ownerId}
          and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id and e.actor_id=a.owner_id
          and e.metadata->'module'=${tx.json(brandMediaRelease)} order by e.occurred_at,a.version_id`;
          const deliveries = [];
          for (const output of outputs) {
            const artifact = await readArtifact(
              tx,
              context,
              row.session_id,
              output.version_id,
            );
            await holdFileAuthority(
              tx,
              context,
              scope,
              {
                objectId: artifact.object.id,
                versionId: artifact.id,
                checksum: artifact.object.checksum,
              },
              false,
            );
            await assertBrandContentFile(
              tx,
              context,
              scope,
              {
                objectId: artifact.object.id,
                versionId: artifact.id,
                checksum: artifact.object.checksum,
              },
              false,
              false,
            );
            const bytes = await readArtifactBytes(storage, artifact.object);
            deliveries.push({
              file: {
                objectId: artifact.object.id,
                versionId: artifact.id,
                checksum: artifact.object.checksum,
              },
              content: new TextDecoder().decode(bytes),
              format: artifact.version.format,
            });
          }
          let submission: {
            articleUpdated: boolean;
            revision: number | null;
          } | null = null;
          if (intent.operation === 'article' && deliveries.length) {
            const [receipt] = await tx<
              { response: unknown }[]
            >`select response from allrice_brand_content_requests
            where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
              and instance_id=${scope.instanceId} and request_id=${'brand-media:' + intent.requestId}`;
            const parsed = BrandMediaMutationResultSchema.safeParse(
              receipt?.response,
            );
            const submitted =
              parsed.success &&
              parsed.data.kind === 'article' &&
              parsed.data.article.id === intent.articleId &&
              deliveries.some(
                (delivery) =>
                  delivery.file.versionId ===
                  (
                    parsed.data as {
                      kind: 'article';
                      article: BrandMediaArticle;
                    }
                  ).article.body?.versionId,
              );
            submission = {
              articleUpdated: submitted,
              revision:
                submitted && parsed.success && parsed.data.kind === 'article'
                  ? parsed.data.article.revision
                  : null,
            };
          }
          const selections = await tx<{ response: unknown }[]>`
          select response from allrice_brand_content_requests
          where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
            and instance_id=${scope.instanceId} and response->>'kind'='topic'
            and response->'topic'->>'sourceRunId'=${row.run_id}`;
          const addedCandidates = selections.flatMap(({ response }) => {
            const parsed = BrandMediaMutationResultSchema.safeParse(response);
            return parsed.success && parsed.data.kind === 'topic'
              ? [parsed.data.topic.candidate]
              : [];
          });
          results.push({
            ...native,
            image,
            submission,
            deliveries,
            addedCandidates,
            unavailable: false,
          });
        } catch (error) {
          if (!(
            error instanceof ReferenceRuntimeError ||
            error instanceof BrandContentError ||
            error instanceof BrandMediaError ||
            error instanceof ArtifactReviewError ||
            (error instanceof DataAccessError &&
              ['not_found', 'authorization_denied'].includes(error.code))
          ))
            throw error;
          results.push({
            ...native,
            image: null,
            submission: null,
            deliveries: [],
            addedCandidates: [],
            unavailable: true,
          });
        }
      }
      return { runs: results };
    },
    true,
  );
}
