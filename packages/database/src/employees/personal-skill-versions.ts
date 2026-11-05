import { randomUUID } from 'node:crypto';
import {
  PersonalSkillVersionInputSchema,
  PersonalSkillVersionPreviewSchema,
  PersonalSkillVersionSchema,
  PersonalSkillDefinitionSchema,
  PersonalSkillPackageSchema,
  PersonalSkillSourceSchema,
  PersonalSkillInstallInputSchema,
  StorageObjectSchema,
  personalSkillLimits,
  type PersonalSkillDefinition,
  type PersonalSkillPackage,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  readContentPrincipal,
  type ContentIdentity,
} from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { enterMethodChat } from './employee-method-chat.ts';
import {
  employeeChatIdentity,
  employeeChatUuid,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';
import type { ContentSql, ContentTx } from './employee-content-model.ts';
import {
  PersonalSkillError,
  owner,
  unavailable,
  personalSkillItems,
  packageVersionChecksum,
} from './personal-skill-model.ts';
import {
  explicitPersonalSkillUpdateIntent,
  explicitPersonalSkillRollbackIntent,
  explicitPersonalSkillVersionConfirmation,
  explicitPersonalSkillVersionCancel,
  explicitPersonalSkillBind,
  skillVersionConfirmation,
} from './personal-skill-version-intent.ts';

export type PersonalSkillImportCall = EmployeeChatCall & {
  /** Server-only context, derived from the validated version tool arguments. */
  versionUpdate?: { installationId: string; expectedRevision: number };
};
export const personalSkillImportTool = (input: PersonalSkillImportCall) =>
  input.versionUpdate
    ? 'workspace.personal_skill.version'
    : 'workspace.personal_skill.install';

export function personalSkillVersionIntent(input: PersonalSkillImportCall) {
  const request = {
    arguments: input.versionUpdate
      ? PersonalSkillInstallInputSchema.parse(input.arguments)
      : PersonalSkillVersionInputSchema.parse(input.arguments),
    update: input.versionUpdate ?? null,
    userMessageId: input.userMessageId,
    sessionId: input.sessionId,
  };
  return {
    id: employeeChatUuid(
      'personal-skill-version',
      input.context.organizationId,
      input.context.policySnapshot.subjectId,
      runtimePolicyDigest(request),
    ),
    request,
  };
}
export async function priorPersonalSkillVersion(
  tx: ContentTx,
  input: PersonalSkillImportCall,
) {
  const { scope } = employeeChatIdentity(input);
  const intent = personalSkillVersionIntent(input);
  const [row] =
    await tx`select * from allrice_personal_skill_version_operations where id=${intent.id}
    and organization_id=${scope.organizationId} and owner_id=${owner(scope)} for update`;
  if (!row) return null;
  if (
    runtimePolicyDigest(row.request_input) !==
    runtimePolicyDigest(intent.request)
  )
    throw new PersonalSkillError('conflict');
  if (row.state === 'pending' && row.expires_at <= new Date())
    throw new PersonalSkillError('conflict');
  // Immutable result of this operation, not whatever version is current now.
  return PersonalSkillVersionPreviewSchema.parse(row.preview);
}
async function installation(
  sql: ContentSql,
  scope: ContentIdentity,
  id: string,
  lock = false,
) {
  const [row] =
    await sql`select i.*,v.version,v.source,v.definition_checksum,v.package_checksum
    from allrice_personal_skill_installations i join allrice_personal_skill_versions v on v.id=i.current_version_id
    where i.id=${id} and i.organization_id=${scope.organizationId} and i.owner_id=${owner(scope)} ${lock ? sql`for update of i` : sql``}`;
  if (!row) return unavailable();
  return row;
}
export async function authorizePersonalSkillUpdate(
  tx: ContentTx,
  input: PersonalSkillImportCall,
  text: string,
  source: string,
  github = false,
) {
  if (!input.versionUpdate) throw new PersonalSkillError('source_invalid');
  const { scope } = employeeChatIdentity(input);
  const row = await installation(
    tx,
    scope,
    input.versionUpdate.installationId,
    true,
  );
  if (
    row.state !== 'installed' ||
    row.revision !== input.versionUpdate.expectedRevision
  )
    throw new PersonalSkillError('conflict');
  if (!explicitPersonalSkillUpdateIntent(text, row.name, source, github))
    throw new PersonalSkillError('intent_required');
  return row;
}
/** Every binding is part of the version change, including disabled and other
 * workspaces. Fail the whole preview if any scope is no longer authorized. */
async function impact(tx: ContentTx, scope: ContentIdentity, id: string) {
  const rows =
    await tx`select b.*,w.name workspace_label,coalesce(e.profile->>'name',emp.name) label
    from allrice_personal_skill_bindings b join allrice_workspaces w on w.id=b.workspace_id
    join allrice_employee_instances e on e.id=b.instance_id
    join allrice_employee_assignments a on a.id=e.assignment_id join allrice_employees emp on emp.id=a.employee_id
    where b.installation_id=${id} and b.organization_id=${scope.organizationId} and b.owner_id=${owner(scope)} order by b.id
    for share of b,e,a,w nowait`;
  if (!rows.length || rows.length > 128) throw new PersonalSkillError('limit');
  for (const row of rows) {
    const context = { ...scope, workspaceId: row.workspace_id as string };
    // The outer admission already holds organization/user/session/person locks.
    // Additional workspace membership rows must stay valid through publication;
    // NOWAIT lets the existing whole-transaction retry preserve lock order.
    await tx`select id from allrice_memberships where organization_id=${scope.organizationId} and user_id=${owner(scope)}
      and active and (workspace_id is null or workspace_id=${context.workspaceId}) order by id for share nowait`;
    if (!(await readContentPrincipal(context, tx))?.writable)
      throw new DataAccessError('authorization_denied');
    await getEmployeeInstance(context, row.instance_id, tx);
  }
  return rows.map((r) => ({
    id: r.id as string,
    instanceId: r.instance_id as string,
    workspaceId: r.workspace_id as string,
    workspaceLabel: r.workspace_label as string,
    label: r.label as string,
    enabled: r.enabled as boolean,
    epoch: r.epoch as number,
  }));
}
function sourceIdentity(raw: unknown) {
  const source = PersonalSkillSourceSchema.parse(raw);
  return source.kind === 'attachment'
    ? {
        kind: source.kind,
        checksum: source.originalChecksum,
        fileName: source.fileName,
        candidatePath: source.candidatePath,
      }
    : {
        kind: source.kind,
        owner: source.owner,
        repository: source.repository,
        commit: source.commitSha,
        path: source.sourcePath,
        candidatePath: source.candidatePath,
        checksum: source.originalChecksum,
      };
}
type Candidate = {
  source: ReturnType<typeof PersonalSkillSourceSchema.parse>;
  definition: PersonalSkillDefinition;
  originalText: string;
  resourceManifest?: PersonalSkillPackage;
  importId?: string;
  targetVersionId?: string;
};
async function stage(
  tx: ContentTx,
  input: PersonalSkillImportCall,
  id: string,
  expectedRevision: number,
  operation: 'update' | 'rollback',
  candidate: Candidate,
  targetVersion?: number,
) {
  const { scope } = employeeChatIdentity(input);
  const row = await installation(tx, scope, id, true);
  if (row.state !== 'installed' || row.revision !== expectedRevision)
    throw new PersonalSkillError('conflict');
  if (candidate.definition.name !== row.name)
    throw new PersonalSkillError('name_conflict');
  const bindings = await impact(tx, scope, id);
  const source = PersonalSkillSourceSchema.parse(candidate.source);
  const definition = PersonalSkillDefinitionSchema.parse(candidate.definition);
  const digest = runtimePolicyDigest(definition);
  const packageDigest = candidate.resourceManifest
    ? packageVersionChecksum(digest, candidate.resourceManifest)
    : null;
  const same =
    operation === 'rollback'
      ? candidate.targetVersionId === row.current_version_id
      : row.definition_checksum === digest &&
        row.package_checksum === packageDigest &&
        runtimePolicyDigest(sourceIdentity(source)) ===
          runtimePolicyDigest(sourceIdentity(row.source));
  const [count] =
    await tx`select count(*)::int n,coalesce(max(version),0)::int latest from allrice_personal_skill_versions where installation_id=${id}`;
  if (
    !same &&
    operation === 'update' &&
    count!.n >= personalSkillLimits.retainedVersions
  )
    throw new PersonalSkillError('limit');
  const [pending] =
    await tx`select count(*)::int n from allrice_personal_skill_version_operations where organization_id=${scope.organizationId}
    and owner_id=${owner(scope)} and state='pending' and expires_at>clock_timestamp()
    and not (installation_id=${id} and session_id=${input.sessionId})`;
  if (pending!.n >= 16) throw new PersonalSkillError('limit');
  const [newer] =
    await tx`select 1 from allrice_personal_skill_version_operations op
    join allrice_messages m on m.id=op.user_message_id
    where op.organization_id=${scope.organizationId} and op.owner_id=${owner(scope)} and op.installation_id=${id} and op.session_id=${input.sessionId}
      and m.created_at>(select created_at from allrice_messages where id=${input.userMessageId}) limit 1`;
  if (newer) throw new PersonalSkillError('conflict');
  const intent = personalSkillVersionIntent(input);
  const version = same
    ? (row.version as number)
    : (targetVersion ?? count!.latest + 1);
  const payload = {
    installationId: id,
    name: row.name as string,
    fromVersion: row.version as number,
    targetVersion: version,
    expectedRevision,
    source,
    bindings,
    operation,
  };
  const preview = PersonalSkillVersionPreviewSchema.parse({
    ...payload,
    operationId: intent.id,
    status: same ? 'unchanged' : 'confirmation_required',
    digest: runtimePolicyDigest({ ...payload, candidate }),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    confirmationText: skillVersionConfirmation(row.name, operation, version),
    effectiveFrom: 'next_task',
    ...(same
      ? {
          appliedVersionId: row.current_version_id,
          appliedRevision: row.revision,
        }
      : {}),
  });
  await tx`insert into allrice_personal_skill_version_operations(id,organization_id,workspace_id,owner_id,installation_id,session_id,user_message_id,request_input,preview,candidate,state,expires_at)
    values(${intent.id},${scope.organizationId},${scope.workspaceId},${owner(scope)},${id},${input.sessionId},${input.userMessageId},
    ${tx.json(intent.request)},${tx.json(preview)},${tx.json(candidate)},${same ? 'unchanged' : 'pending'},${preview.expiresAt})`;
  // "The version just shown" has one meaning in a session. A newer source
  // supersedes older previews atomically; late older messages cannot replace it.
  await tx`update allrice_personal_skill_version_operations set state='canceled',preview=jsonb_set(preview,'{status}','"canceled"'::jsonb)
    where organization_id=${scope.organizationId} and owner_id=${owner(scope)} and installation_id=${id} and session_id=${input.sessionId}
      and id<>${intent.id} and state='pending'`;
  // Staging bytes remain protected by the pending operation; canceled or expired
  // candidates can use the existing unused-import cleanup path.
  if (candidate.importId)
    await tx`update allrice_personal_skill_imports set state='canceled' where id=${candidate.importId}`;
  return preview;
}
export async function stagePersonalSkillUpdate(
  tx: ContentTx,
  input: PersonalSkillImportCall,
  candidate: Candidate,
) {
  if (!input.versionUpdate) throw new PersonalSkillError('source_invalid');
  return stage(
    tx,
    input,
    input.versionUpdate.installationId,
    input.versionUpdate.expectedRevision,
    'update',
    candidate,
  );
}

export async function personalSkillHistory(
  context: ContentIdentity,
  id: string,
  sql: ContentSql = getDatabase(),
) {
  if (!(await readContentPrincipal(context, sql)))
    throw new DataAccessError('authorization_denied');
  const row = await installation(sql, context, id);
  const versions =
    await sql`select * from allrice_personal_skill_versions where installation_id=${id}
    and organization_id=${context.organizationId} and owner_id=${owner(context)} order by version desc limit ${personalSkillLimits.retainedVersions}`;
  const [skill] = await personalSkillItems(context, sql, id);
  return {
    skill,
    versions: versions.map((v) =>
      PersonalSkillVersionSchema.parse({
        id: v.id,
        version: v.version,
        source: v.source,
        definitionChecksum: v.definition_checksum,
        ...(v.package_checksum ? { packageChecksum: v.package_checksum } : {}),
        current: v.id === row.current_version_id,
        createdAt: v.created_at.toISOString(),
      }),
    ),
  };
}

/** Validate retained bytes outside database locks, then re-enter the final
 * transaction. A missing/corrupt archive must leave the old pointer intact. */
export async function personalSkillVersionConfirmationFiles(
  input: EmployeeChatCall,
) {
  const args = PersonalSkillVersionInputSchema.parse(input.arguments);
  if (args.operation !== 'confirm') return [];
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.version',
    false,
    async (tx, _instance, text) => {
      const [op] =
        await tx`select * from allrice_personal_skill_version_operations where id=${args.operationId}
      and organization_id=${scope.organizationId} and owner_id=${owner(scope)} and workspace_id=${scope.workspaceId} and session_id=${input.sessionId}`;
      if (!op) return unavailable();
      const preview = PersonalSkillVersionPreviewSchema.parse(op.preview);
      if (preview.digest !== args.digest)
        throw new PersonalSkillError('conflict');
      const [fresh] =
        await tx`select 1 from allrice_messages where id=${input.userMessageId} and created_at>${op.created_at}`;
      if (
        !fresh ||
        !explicitPersonalSkillVersionConfirmation(
          text,
          preview.confirmationText,
        )
      )
        throw new PersonalSkillError('intent_required');
      if (op.state !== 'pending') return [];
      if (op.expires_at <= new Date()) throw new PersonalSkillError('conflict');
      const manifest = op.candidate.resourceManifest
        ? PersonalSkillPackageSchema.parse(op.candidate.resourceManifest)
        : null;
      if (!manifest) return [];
      const [row] =
        await tx`select * from allrice_storage_objects where id=${manifest.archiveObjectId} and organization_id=${scope.organizationId}
      and owner_id=${owner(scope)} and state='ready' and deleted_at is null and visibility='private' and category='memory'`;
      if (
        !row ||
        row.checksum !== preview.source.originalChecksum ||
        Number(row.size_bytes) !== preview.source.byteLength
      )
        return unavailable();
      return [
        StorageObjectSchema.parse({
          id: row.id,
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          ownerId: row.owner_id,
          key: row.object_key,
          checksum: row.checksum,
          mediaType: row.media_type,
          sizeBytes: Number(row.size_bytes),
          immutable: row.immutable,
          retentionUntil: row.retention_until?.toISOString() ?? null,
          deletedAt: null,
        }),
      ];
    },
  );
}
export async function personalSkillVersionFromChat(input: EmployeeChatCall) {
  const args = PersonalSkillVersionInputSchema.parse(input.arguments);
  if (args.operation === 'update')
    throw new PersonalSkillError('source_invalid');
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.version',
    false,
    async (tx, instance, text) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        throw new DataAccessError('authorization_denied');
      if (args.operation === 'inspect') {
        if (!args.installationId)
          return { skills: await personalSkillItems(scope, tx) };
        const history = await personalSkillHistory(
          scope,
          args.installationId,
          tx,
        );
        const pending =
          await tx`select preview from allrice_personal_skill_version_operations where installation_id=${args.installationId}
        and organization_id=${scope.organizationId} and owner_id=${owner(scope)} and session_id=${input.sessionId}
        and state='pending' and expires_at>clock_timestamp() order by created_at desc limit 16`;
        return {
          ...history,
          pending: pending.map((r) =>
            PersonalSkillVersionPreviewSchema.parse(r.preview),
          ),
        };
      }
      if (args.operation === 'bind') {
        const row = await installation(tx, scope, args.installationId, true);
        if (!explicitPersonalSkillBind(text, row.name))
          throw new PersonalSkillError('intent_required');
        const request = personalSkillVersionIntent(input);
        const [prior] =
          await tx`select response from allrice_personal_skill_receipts where organization_id=${scope.organizationId} and owner_id=${owner(scope)} and request_id=${request.id}`;
        if (prior)
          return {
            status: 'bound' as const,
            appliedReceipt: prior.response,
            current: (await personalSkillItems(scope, tx, row.id))[0],
            note: '原操作回执；没有重复启用，当前版本与启停状态以 current 为准。',
          };
        if (
          row.state !== 'installed' ||
          row.revision !== args.expectedRevision ||
          row.current_version_id !== args.versionId
        )
          throw new PersonalSkillError('conflict');
        const [binding] =
          await tx`select * from allrice_personal_skill_bindings where installation_id=${row.id} and instance_id=${instance.id} for update`;
        const [run] =
          await tx`select native_skills from allrice_employee_runs where run_id=${input.context.runId}`;
        if (
          (
            run?.native_skills as
              { name: string; personal?: unknown }[] | undefined
          )?.some((s) => s.name === row.name && !s.personal)
        )
          throw new PersonalSkillError('name_conflict');
        const [stale] =
          await tx`select 1 from allrice_messages where id=${input.userMessageId}
          and created_at<=greatest(${row.revoked_at}::timestamptz,${binding?.revoked_at ?? null}::timestamptz)`;
        if (stale) throw new PersonalSkillError('conflict');
        const [count] =
          await tx`select count(*)::int n from allrice_personal_skill_bindings where instance_id=${instance.id} and enabled`;
        if (
          !binding?.enabled &&
          count!.n >= personalSkillLimits.enabledPerInstance
        )
          throw new PersonalSkillError('limit');
        await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
        values(${scope.organizationId},${scope.workspaceId},${owner(scope)},${instance.id},${row.id},true)
        on conflict(instance_id,installation_id) do update set enabled=true,epoch=allrice_personal_skill_bindings.epoch+case when allrice_personal_skill_bindings.enabled then 0 else 1 end,updated_at=clock_timestamp()`;
        if (!binding?.enabled)
          await tx`update allrice_personal_skill_installations set revision=revision+1,updated_at=clock_timestamp() where id=${row.id}`;
        const current = (await personalSkillItems(scope, tx, row.id))[0]!;
        await tx`insert into allrice_personal_skill_receipts(organization_id,owner_id,request_id,request_input,response) values(${scope.organizationId},${owner(scope)},${request.id},${tx.json(request.request)},${tx.json(current)})`;
        return {
          status: 'bound' as const,
          appliedReceipt: current,
          current,
          effectiveFrom: 'next_task',
        };
      }
      if (args.operation === 'rollback') {
        const prior = await priorPersonalSkillVersion(tx, input);
        if (prior) return prior;
        const row = await installation(tx, scope, args.installationId, true);
        if (!explicitPersonalSkillRollbackIntent(text, row.name, args.version))
          throw new PersonalSkillError('intent_required');
        const [version] =
          await tx`select * from allrice_personal_skill_versions where installation_id=${row.id} and version=${args.version}
        and organization_id=${scope.organizationId} and owner_id=${owner(scope)}`;
        if (!version) return unavailable();
        return stage(
          tx,
          input,
          row.id,
          args.expectedRevision,
          'rollback',
          {
            targetVersionId: version.id,
            source: version.source,
            definition: PersonalSkillDefinitionSchema.parse(version.definition),
            originalText: version.original_text,
            ...(version.resource_manifest
              ? {
                  resourceManifest: PersonalSkillPackageSchema.parse(
                    version.resource_manifest,
                  ),
                }
              : {}),
          },
          version.version,
        );
      }
      const [operation] =
        await tx`select * from allrice_personal_skill_version_operations where id=${args.operationId}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${owner(scope)}
      and session_id=${input.sessionId} for update`;
      if (!operation) return unavailable();
      const preview = PersonalSkillVersionPreviewSchema.parse(
        operation.preview,
      );
      if (preview.digest !== args.digest)
        throw new PersonalSkillError('conflict');
      const [fresh] =
        await tx`select 1 from allrice_messages where id=${input.userMessageId} and created_at>${operation.created_at}`;
      if (
        !fresh ||
        !(args.operation === 'cancel'
          ? explicitPersonalSkillVersionCancel(text, preview.name)
          : explicitPersonalSkillVersionConfirmation(
              text,
              preview.confirmationText,
            ))
      )
        throw new PersonalSkillError('intent_required');
      if (operation.state !== 'pending') return preview; // Original result, never a second write.
      if (operation.expires_at <= new Date())
        throw new PersonalSkillError('conflict');
      if (args.operation === 'cancel') {
        const canceled = PersonalSkillVersionPreviewSchema.parse({
          ...preview,
          status: 'canceled',
        });
        await tx`update allrice_personal_skill_version_operations set state='canceled',preview=${tx.json(canceled)} where id=${operation.id}`;
        return canceled;
      }
      const row = await installation(
        tx,
        scope,
        operation.installation_id,
        true,
      );
      if (
        row.state !== 'installed' ||
        row.revision !== preview.expectedRevision ||
        row.version !== preview.fromVersion ||
        runtimePolicyDigest(await impact(tx, scope, row.id)) !==
          runtimePolicyDigest(preview.bindings)
      )
        throw new PersonalSkillError('conflict');
      const candidate = operation.candidate as Candidate;
      if (candidate.resourceManifest) {
        const [stored] =
          await tx`select id from allrice_storage_objects where id=${candidate.resourceManifest.archiveObjectId}
        and organization_id=${scope.organizationId} and owner_id=${owner(scope)} and visibility='private' and category='memory'
        and state='ready' and deleted_at is null and checksum=${preview.source.originalChecksum} and size_bytes=${preview.source.byteLength} for update`;
        if (!stored) return unavailable();
      }
      let versionId = candidate.targetVersionId;
      if (preview.operation === 'update') {
        versionId = randomUUID();
        const digest = runtimePolicyDigest(candidate.definition);
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum,resource_manifest,package_checksum)
        values(${versionId},${scope.organizationId},${owner(scope)},${row.id},${preview.targetVersion},${tx.json(preview.source)},${candidate.originalText},${tx.json(candidate.definition)},${digest},
          ${candidate.resourceManifest ? tx.json(candidate.resourceManifest) : null},${candidate.resourceManifest ? packageVersionChecksum(digest, candidate.resourceManifest) : null})`;
        if (candidate.resourceManifest)
          await tx`update allrice_storage_objects set immutable=true where id=${candidate.resourceManifest.archiveObjectId}`;
      }
      if (!versionId) return unavailable();
      await tx`update allrice_personal_skill_installations set current_version_id=${versionId},revision=revision+1,updated_at=clock_timestamp() where id=${row.id}`;
      const applied = PersonalSkillVersionPreviewSchema.parse({
        ...preview,
        status: 'applied',
        appliedVersionId: versionId,
        appliedRevision: row.revision + 1,
      });
      await tx`update allrice_personal_skill_version_operations set state='applied',preview=${tx.json(applied)} where id=${operation.id}`;
      return applied;
    },
  );
}
