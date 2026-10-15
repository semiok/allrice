import { randomUUID } from 'node:crypto';
import {
  PersonalSkillDefinitionSchema,
  PersonalSkillSourceSchema,
  PersonalSkillItemSchema,
  PersonalSkillSnapshotSchema,
  PersonalSkillPinSchema,
  PersonalSkillInstallInputSchema,
  PersonalSkillManageRequestSchema,
  PersonalSkillCandidateSchema,
  PersonalSkillPackageSchema,
  StorageObjectSchema,
  EmployeeExecutionSnapshotSchema,
  personalSkillLimits,
  type PersonalSkillCandidate,
  type PersonalSkillPackage,
  type ExecutionContext,
  type PersonalSkillDefinition,
  type PersonalSkillPin,
  type DshNativeSkillSnapshot,
  type EmployeeBaseSkillCatalog,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import {
  DataAccessError,
  createStorageMetadata,
  markStorageReady,
} from '../data.ts';
import {
  readContentPrincipal,
  type ContentIdentity,
} from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { getToolBrokerFile } from '../execution/tool-broker.ts';
import { skillBytesChecksum, validateFrozenSkill } from '../skill-bundles.ts';
import { employeeAccessTransaction } from './employee-access-cancellation.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { enterMethodChat } from './employee-method-chat.ts';
import {
  employeeChatIdentity,
  employeeChatUuid,
  type EmployeeChatCall,
} from './employee-chat-authority.ts';
import {
  explicitPersonalSkillInstallIntent,
  explicitPersonalSkillSelectionIntent,
  explicitPersonalSkillCancelIntent,
} from './personal-skill-intent.ts';
import { employeeBaseSkillLimits } from './employee-base-skills.ts';
import type { ContentSql, ContentTx } from './employee-content-model.ts';

export class PersonalSkillError extends Error {
  constructor(
    readonly code:
      | 'intent_required'
      | 'source_invalid'
      | 'name_conflict'
      | 'limit'
      | 'conflict'
      | 'unavailable',
  ) {
    super(`personal_skill_${code}`);
  }
}
const unavailable = (): never => {
  throw new PersonalSkillError('unavailable');
};
const owner = (context: ContentIdentity) =>
  context.actor.type === 'user' ? context.actor.id : unavailable();

function packageVersionChecksum(
  definitionChecksum: string,
  manifest: PersonalSkillPackage,
) {
  return runtimePolicyDigest({
    definitionChecksum,
    sourcePath: manifest.sourcePath,
    resources: manifest.resources,
  });
}
function validPackage(
  raw: unknown,
  checksum: string | null,
  definitionChecksum: string,
) {
  if (raw === null && checksum === null) return undefined;
  const manifest = PersonalSkillPackageSchema.parse(raw);
  const { checksum: manifestChecksum, ...payload } = manifest;
  if (
    runtimePolicyDigest(payload) !== manifestChecksum ||
    packageVersionChecksum(definitionChecksum, manifest) !== checksum
  )
    return unavailable();
  return manifest;
}

async function items(context: ContentIdentity, sql: ContentSql, id?: string) {
  const rows = await sql`
    select i.*,v.version,v.source,v.definition,v.definition_checksum,v.resource_manifest,v.package_checksum from allrice_personal_skill_installations i
    join allrice_personal_skill_versions v on v.id=i.current_version_id
    where i.organization_id=${context.organizationId} and i.owner_id=${owner(context)}
      and (${id ?? null}::uuid is null or i.id=${id ?? null}) order by i.created_at desc limit 128`;
  const bindings = rows.length
    ? await sql`select b.*,emp.name as employee_name,e.profile from allrice_personal_skill_bindings b
    join allrice_employee_instances e on e.id=b.instance_id and e.archived_at is null
    join allrice_employee_assignments a on a.id=e.assignment_id and a.active
    join allrice_employees emp on emp.id=a.employee_id
    where b.installation_id in ${sql(rows.map((r) => r.id))} and b.organization_id=${context.organizationId}
      and b.owner_id=${owner(context)} and b.workspace_id=${context.workspaceId} order by b.id`
    : [];
  const readable = new Map<string, boolean>();
  const results = [];
  for (const row of rows) {
    const visible = [];
    for (const b of bindings.filter((b) => b.installation_id === row.id)) {
      if (!readable.has(b.instance_id)) {
        try {
          await getEmployeeInstance(context, b.instance_id, sql);
          readable.set(b.instance_id, true);
        } catch (error) {
          if (!(error instanceof DataAccessError)) throw error;
          readable.set(b.instance_id, false);
        }
      }
      if (!readable.get(b.instance_id)) continue;
      visible.push({
        id: b.id,
        instanceId: b.instance_id,
        workspaceId: b.workspace_id,
        enabled: b.enabled,
        epoch: b.epoch,
        label: b.profile?.name ?? b.employee_name,
      });
    }
    // The library belongs to the person, independently of a revoked binding.
    results.push(
      PersonalSkillItemSchema.parse({
        id: row.id,
        name: row.name,
        description: row.definition.description,
        revision: row.revision,
        state: row.state,
        versionId: row.current_version_id,
        version: row.version,
        source: row.source,
        definitionChecksum: row.definition_checksum,
        ...(row.package_checksum
          ? {
              packageChecksum: row.package_checksum,
              resourceCount: row.resource_manifest.resources.length,
            }
          : {}),
        compatibility: 'instruction_format_checked',
        businessVerification: 'not_verified',
        bindings: visible,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }),
    );
  }
  return results;
}

export async function listPersonalSkills(context: ContentIdentity) {
  if (!(await readContentPrincipal(context)))
    throw new DataAccessError('authorization_denied');
  return items(context, getDatabase());
}

async function priorReceipt(
  tx: ContentTx,
  context: ContentIdentity,
  requestId: string,
  input: Record<string, string | number | undefined>,
) {
  const [prior] =
    await tx`select response,request_input=${tx.json(input)}::jsonb matches
    from allrice_personal_skill_receipts where organization_id=${context.organizationId}
      and owner_id=${owner(context)} and request_id=${requestId}`;
  if (prior && !prior.matches) throw new PersonalSkillError('conflict');
  return prior ? PersonalSkillItemSchema.parse(prior.response) : null;
}
async function receipt(
  tx: ContentTx,
  context: ContentIdentity,
  requestId: string,
  input: Record<string, string | number | undefined>,
  id: string,
) {
  const [item] = await items(context, tx, id);
  if (!item) return unavailable();
  await tx`insert into allrice_personal_skill_receipts(organization_id,owner_id,request_id,request_input,response)
    values(${context.organizationId},${owner(context)},${requestId},${tx.json(input)},${tx.json(item)})`;
  return item;
}

function installationIntent(input: EmployeeChatCall, instanceId: string) {
  const args = PersonalSkillInstallInputSchema.parse(input.arguments);
  return {
    requestId: employeeChatUuid(
      'personal-skill-install',
      input.context.organizationId,
      input.context.policySnapshot.subjectId,
      input.userMessageId,
      'objectId' in args
        ? args.objectId
        : `${args.importId}:${'candidatePath' in args ? args.candidatePath : 'cancel'}`,
      instanceId,
    ),
    request: { ...args, userMessageId: input.userMessageId, instanceId },
  };
}
async function priorInstallation(
  tx: ContentTx,
  context: ContentIdentity,
  intent: ReturnType<typeof installationIntent>,
) {
  const prior = await priorReceipt(
    tx,
    context,
    intent.requestId,
    intent.request,
  );
  if (!prior) return null;
  const [current] = await items(context, tx, prior.id);
  const previous = prior.bindings.find(
    (b) => b.instanceId === intent.request.instanceId,
  );
  const binding = current?.bindings.find(
    (b) => b.instanceId === intent.request.instanceId,
  );
  // A retry is the same user intent even with a new tool call ID. It cannot
  // revive a revoked binding or falsely report the old enabled state.
  if (
    !current ||
    current.state !== 'installed' ||
    !binding?.enabled ||
    !previous ||
    binding.epoch !== previous.epoch
  )
    throw new PersonalSkillError('conflict');
  return current;
}

async function importSource(
  tx: ContentTx,
  input: EmployeeChatCall,
  text: string,
) {
  const args = PersonalSkillInstallInputSchema.parse(input.arguments);
  if (!('objectId' in args)) throw new PersonalSkillError('source_invalid');
  const [attachment] =
    await tx`select a.file_name,o.checksum from allrice_message_attachments a
    join allrice_messages m on m.id=a.message_id and m.organization_id=a.organization_id and m.workspace_id=a.workspace_id
    join allrice_storage_objects o on o.id=a.object_id and o.organization_id=a.organization_id and o.workspace_id=a.workspace_id
    where a.object_id=${args.objectId} and a.message_id=${input.userMessageId} and m.session_id=${input.sessionId}
      and a.organization_id=${input.context.organizationId} and a.workspace_id=${input.context.workspaceId!}
      and o.owner_id=${input.context.policySnapshot.subjectId} and o.state='ready' and o.deleted_at is null
    for share of a,o`;
  if (
    !attachment ||
    !explicitPersonalSkillInstallIntent(text, attachment.file_name)
  )
    throw new PersonalSkillError('intent_required');
  // A generic "the attached skill" cannot pick arbitrarily among multiple files.
  const [count] =
    await tx`select count(*)::int n from allrice_message_attachments where message_id=${input.userMessageId}
    and (lower(file_name)='skill.md' or lower(file_name) like '%.zip')`;
  if (count?.n !== 1) throw new PersonalSkillError('source_invalid');
  const file = await getToolBrokerFile(input.context, args.objectId, tx);
  const source = PersonalSkillSourceSchema.parse({
    kind: 'attachment',
    objectId: args.objectId,
    fileName: attachment.file_name,
    originalChecksum: file.object.checksum,
    byteLength: file.object.sizeBytes,
  });
  if (
    !/\.zip$/iu.test(source.fileName) &&
    source.byteLength > personalSkillLimits.sourceBytes
  )
    throw new PersonalSkillError('source_invalid');
  return { source, object: file.object };
}

function packageImportId(input: EmployeeChatCall, instanceId: string) {
  const args = PersonalSkillInstallInputSchema.parse(input.arguments);
  return 'importId' in args
    ? args.importId
    : installationIntent(input, instanceId).requestId;
}

async function packageObject(
  sql: ContentSql,
  context: ContentIdentity,
  id: string,
  pending = false,
) {
  const [row] = await sql`select * from allrice_storage_objects where id=${id}
    and organization_id=${context.organizationId} and owner_id=${owner(context)}
    and category='memory' and visibility='private' and (immutable or ${pending}) and deleted_at is null
    and (state='ready' or (${pending} and state='pending'))`;
  if (!row) return unavailable();
  return StorageObjectSchema.parse({
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
  });
}

async function packageImport(
  tx: ContentTx,
  input: EmployeeChatCall,
  instanceId: string,
  text: string,
) {
  const { scope } = employeeChatIdentity(input);
  const args = PersonalSkillInstallInputSchema.parse(input.arguments);
  const [row] = await tx`select * from allrice_personal_skill_imports
    where id=${packageImportId(input, instanceId)} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${owner(scope)} and instance_id=${instanceId}
      and session_id=${input.sessionId} and expires_at>clock_timestamp() for update`;
  if (!row || row.state !== 'ready') return unavailable();
  const candidates = (row.candidates as unknown[]).map((candidate) =>
    PersonalSkillCandidateSchema.parse(candidate),
  );
  let candidate: PersonalSkillCandidate | undefined;
  if ('importId' in args) {
    if (!('candidatePath' in args))
      throw new PersonalSkillError('source_invalid');
    const [fresh] =
      await tx`select 1 from allrice_messages now_message join allrice_messages original
      on original.id=${row.user_message_id} where now_message.id=${input.userMessageId} and now_message.created_at>original.created_at`;
    const [newer] =
      await tx`select 1 from allrice_personal_skill_imports where organization_id=${scope.organizationId}
      and owner_id=${owner(scope)} and instance_id=${instanceId} and session_id=${input.sessionId}
      and id<>${row.id} and created_at>(select created_at from allrice_personal_skill_imports where id=${row.id}) limit 1`;
    if (
      !fresh ||
      newer ||
      explicitPersonalSkillSelectionIntent(text, candidates) !==
        args.candidatePath
    )
      throw new PersonalSkillError('intent_required');
    candidate = candidates.find((c) => c.sourcePath === args.candidatePath);
  } else {
    const { source } = await importSource(tx, input, text);
    if (
      runtimePolicyDigest(source) !== runtimePolicyDigest(row.source) ||
      candidates.length !== 1
    )
      throw new PersonalSkillError('source_invalid');
    candidate = candidates[0];
  }
  if (
    !candidate?.definition ||
    !candidate.originalText ||
    candidate.issues.length
  )
    throw new PersonalSkillError('source_invalid');
  await packageObject(tx, scope, row.archive_object_id, true);
  const payload = {
    schemaVersion: 1 as const,
    archiveObjectId: row.archive_object_id as string,
    sourcePath: candidate.sourcePath,
    resources: candidate.resources,
  };
  const resourceManifest = PersonalSkillPackageSchema.parse({
    ...payload,
    checksum: runtimePolicyDigest(payload),
  });
  return {
    importId: row.id as string,
    candidate,
    source: PersonalSkillSourceSchema.parse({
      ...row.source,
      candidatePath: candidate.sourcePath,
    }),
    resourceManifest,
  };
}

/** Reserve one private archive using the existing quota gate as first lock.
 * It becomes immutable only when referenced by an installed version.
 * Bytes are written by StoragePort outside this transaction. Retries reuse the
 * exact import/object rather than accumulating copies or enabling a half import. */
export async function reservePersonalSkillPackage(
  input: EmployeeChatCall,
  rawCandidates: PersonalSkillCandidate[],
) {
  const candidates = rawCandidates.map((candidate) =>
    PersonalSkillCandidateSchema.parse(candidate),
  );
  if (
    !candidates.length ||
    candidates.length > personalSkillLimits.packageCandidates
  )
    throw new PersonalSkillError('source_invalid');
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx, instance, text) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        throw new DataAccessError('authorization_denied');
      const { source } = await importSource(tx, input, text);
      if (!/\.zip$/iu.test(source.fileName))
        throw new PersonalSkillError('source_invalid');
      const id = packageImportId(input, instance.id);
      const [existing] =
        await tx`select * from allrice_personal_skill_imports where id=${id} for update`;
      if (existing) {
        if (
          !['staging', 'ready'].includes(existing.state) ||
          existing.expires_at <= new Date() ||
          runtimePolicyDigest(existing.source) !==
            runtimePolicyDigest(source) ||
          runtimePolicyDigest(existing.candidates) !==
            runtimePolicyDigest(candidates)
        )
          throw new PersonalSkillError('conflict');
        return {
          id,
          object: await packageObject(
            tx,
            scope,
            existing.archive_object_id,
            true,
          ),
          writeRequired: existing.state === 'staging',
        };
      }
      const [count] =
        await tx`select count(*)::int n from allrice_personal_skill_imports
      where organization_id=${scope.organizationId} and owner_id=${owner(scope)} and state in ('staging','ready') and expires_at>clock_timestamp()`;
      if (count!.n >= 32) throw new PersonalSkillError('limit');
      // Identical archives already retained by this owner's immutable version
      // are shared across bindings. Re-uploading cannot multiply private bytes.
      const [retained] = await tx`select o.id from allrice_storage_objects o
        where o.organization_id=${scope.organizationId} and o.owner_id=${owner(scope)} and o.category='memory'
          and o.visibility='private' and o.immutable and o.state='ready' and o.deleted_at is null
          and o.checksum=${source.originalChecksum} and o.size_bytes=${source.byteLength}
          and exists(select 1 from allrice_personal_skill_versions v where v.organization_id=o.organization_id
            and v.owner_id=o.owner_id and v.resource_manifest->>'archiveObjectId'=o.id::text) limit 1`;
      const stored = retained
        ? { object: await packageObject(tx, scope, retained.id) }
        : await createStorageMetadata(
            { ...scope, memberships: input.context.policySnapshot.memberships },
            {
              id: randomUUID(),
              workspaceId: scope.workspaceId,
              category: 'memory',
              mediaType: 'application/zip',
              sizeBytes: source.byteLength,
              checksum: source.originalChecksum,
              visibility: 'private',
              retentionUntil: null,
              immutable: false,
            },
            tx,
          );
      await tx`insert into allrice_personal_skill_imports(id,organization_id,workspace_id,owner_id,instance_id,session_id,user_message_id,source,archive_object_id,candidates,state)
      values(${id},${scope.organizationId},${scope.workspaceId},${owner(scope)},${instance.id},${input.sessionId},${input.userMessageId},${tx.json(source)},${stored.object.id},${tx.json(candidates)},${retained ? 'ready' : 'staging'})`;
      return { id, object: stored.object, writeRequired: !retained };
    },
    { reserveStorage: true },
  );
}

export async function completePersonalSkillPackage(input: EmployeeChatCall) {
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx, instance, text) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        throw new DataAccessError('authorization_denied');
      const { source } = await importSource(tx, input, text);
      const id = packageImportId(input, instance.id);
      const [row] =
        await tx`select * from allrice_personal_skill_imports where id=${id} and organization_id=${scope.organizationId}
      and owner_id=${owner(scope)} and instance_id=${instance.id} and session_id=${input.sessionId} and expires_at>clock_timestamp() for update`;
      if (
        !row ||
        runtimePolicyDigest(row.source) !== runtimePolicyDigest(source) ||
        !['staging', 'ready'].includes(row.state)
      )
        throw new PersonalSkillError('conflict');
      if (row.state === 'staging') {
        await markStorageReady(
          { ...scope, memberships: input.context.policySnapshot.memberships },
          row.archive_object_id,
          tx,
        );
        await tx`update allrice_personal_skill_imports set state='ready' where id=${id}`;
      }
      return {
        importId: id,
        expiresAt: row.expires_at.toISOString() as string,
        candidates: (row.candidates as unknown[]).map((candidate) =>
          PersonalSkillCandidateSchema.parse(candidate),
        ),
      };
    },
  );
}

export async function cancelPersonalSkillPackage(input: EmployeeChatCall) {
  const { scope } = employeeChatIdentity(input);
  const args = PersonalSkillInstallInputSchema.parse(input.arguments);
  if (!('operation' in args)) throw new PersonalSkillError('source_invalid');
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx, instance, text) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        throw new DataAccessError('authorization_denied');
      const [row] =
        await tx`select * from allrice_personal_skill_imports where id=${args.importId}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${owner(scope)}
      and instance_id=${instance.id} and session_id=${input.sessionId} for update`;
      if (!row || row.state === 'consumed') return unavailable();
      const [fresh] =
        await tx`select 1 from allrice_messages where id=${input.userMessageId} and created_at>${row.created_at}`;
      if (!fresh) throw new PersonalSkillError('intent_required');
      if (!explicitPersonalSkillCancelIntent(text, row.source.fileName))
        throw new PersonalSkillError('intent_required');
      await tx`update allrice_personal_skill_imports set state='canceled' where id=${row.id}`;
      return {
        status: 'canceled' as const,
        importId: row.id as string,
        installed: false,
      };
    },
  );
}

/** Retire only unused private staging copies. Version-referenced objects are
 * never eligible. Physical deletion happens outside the quota/authority locks;
 * a failed deletion keeps its quota and is retried on a later owned request. */
export async function preparePersonalSkillImportCleanup(
  input: EmployeeChatCall,
) {
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx, instance) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        return unavailable();
      await tx`update allrice_personal_skill_imports set state='canceled'
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${owner(scope)}
        and state in ('staging','ready') and expires_at<=clock_timestamp()`;
      const currentId = packageImportId(input, instance.id);
      const rows =
        await tx`select distinct o.* from allrice_personal_skill_imports i
      join allrice_storage_objects o on o.id=i.archive_object_id
      where i.organization_id=${scope.organizationId} and i.workspace_id=${scope.workspaceId} and i.owner_id=${owner(scope)}
        and i.state in ('canceled','consumed') and o.organization_id=i.organization_id and o.owner_id=i.owner_id
        and o.category='memory' and o.visibility='private' and not o.immutable
        and (o.state<>'deleted' or i.id=${currentId})
        and not exists(select 1 from allrice_personal_skill_versions v where v.resource_manifest->>'archiveObjectId'=o.id::text)
      limit 64`;
      return rows.map((row) =>
        StorageObjectSchema.parse({
          id: row.id,
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          ownerId: row.owner_id,
          key: row.object_key,
          checksum: row.checksum,
          mediaType: row.media_type,
          sizeBytes: Number(row.size_bytes),
          immutable: false,
          retentionUntil: null,
          deletedAt: row.deleted_at?.toISOString() ?? null,
        }),
      );
    },
    { reserveStorage: true },
  );
}

export async function completePersonalSkillImportCleanup(
  input: EmployeeChatCall,
  objectIds: string[],
) {
  if (!objectIds.length) return;
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        return unavailable();
      await tx`update allrice_storage_objects o set state='deleted',deleted_at=coalesce(deleted_at,clock_timestamp()),updated_at=clock_timestamp()
      where o.id in ${tx(objectIds)} and o.organization_id=${scope.organizationId} and o.workspace_id=${scope.workspaceId}
        and o.owner_id=${owner(scope)} and not o.immutable and o.category='memory' and o.visibility='private'
        and exists(select 1 from allrice_personal_skill_imports i where i.archive_object_id=o.id and i.state in ('canceled','consumed'))
        and not exists(select 1 from allrice_personal_skill_versions v where v.resource_manifest->>'archiveObjectId'=o.id::text)`;
    },
    { reserveStorage: true },
  );
}

/** Admission before any source bytes are read; parsing runs outside locks. */
export async function preparePersonalSkillImport(input: EmployeeChatCall) {
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx, instance, text) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        throw new DataAccessError('authorization_denied');
      const prior = await priorInstallation(
        tx,
        scope,
        installationIntent(input, instance.id),
      );
      if (prior) return { prior };
      if ('importId' in PersonalSkillInstallInputSchema.parse(input.arguments))
        return {
          selection: await packageImport(tx, input, instance.id, text),
          instanceId: instance.id,
        };
      const source = await importSource(tx, input, text);
      const currentImport = packageImportId(input, instance.id);
      await tx`update allrice_personal_skill_imports set state='canceled' where organization_id=${scope.organizationId}
        and owner_id=${owner(scope)} and instance_id=${instance.id} and session_id=${input.sessionId}
        and id<>${currentImport} and state in ('staging','ready')`;
      return {
        ...source,
        instanceId: instance.id,
      };
    },
  );
}

export async function installPersonalSkillFromChat(
  input: EmployeeChatCall,
  parsed: {
    originalText: string;
    definition: PersonalSkillDefinition;
  },
) {
  const definition = PersonalSkillDefinitionSchema.parse(parsed.definition);
  if (skillBytesChecksum(definition.content) !== definition.checksum)
    throw new PersonalSkillError('source_invalid');
  const { scope } = employeeChatIdentity(input);
  return enterMethodChat(
    input,
    'workspace.personal_skill.install',
    false,
    async (tx, instance, text) => {
      if (!(await readContentPrincipal(scope, tx))?.writable)
        throw new DataAccessError('authorization_denied');
      const intent = installationIntent(input, instance.id);
      const prior = await priorInstallation(tx, scope, intent);
      if (prior) return prior;
      const args = PersonalSkillInstallInputSchema.parse(input.arguments);
      const attached =
        'objectId' in args ? await importSource(tx, input, text) : null;
      const selected =
        !attached || /\.zip$/iu.test(attached.source.fileName)
          ? await packageImport(tx, input, instance.id, text)
          : null;
      const source = selected?.source ?? attached!.source;
      if (
        selected
          ? parsed.originalText !== selected.candidate.originalText ||
            runtimePolicyDigest(definition) !==
              runtimePolicyDigest(selected.candidate.definition)
          : Buffer.byteLength(parsed.originalText) !== source.byteLength ||
            skillBytesChecksum(parsed.originalText) !== source.originalChecksum
      )
        throw new PersonalSkillError('source_invalid');
      const [run] =
        await tx`select native_skills from allrice_employee_runs where run_id=${input.context.runId}`;
      if (
        run?.native_skills?.some(
          (s: DshNativeSkillSnapshot) =>
            s.name === definition.name && !s.personal,
        )
      )
        throw new PersonalSkillError('name_conflict');
      const [existing] =
        await tx`select i.*,v.definition_checksum,v.source,v.package_checksum from allrice_personal_skill_installations i
      join allrice_personal_skill_versions v on v.id=i.current_version_id
      where i.organization_id=${scope.organizationId} and i.owner_id=${scope.actor.id} and i.name=${definition.name} for update of i`;
      const digest = runtimePolicyDigest(definition);
      const packageDigest = selected
        ? packageVersionChecksum(digest, selected.resourceManifest)
        : null;
      if (
        existing &&
        (existing.definition_checksum !== digest ||
          existing.package_checksum !== packageDigest ||
          existing.source.originalChecksum !== source.originalChecksum)
      )
        throw new PersonalSkillError('name_conflict');
      const [counts] =
        await tx`select count(*) filter(where state='installed')::int n,count(*)::int retained
      from allrice_personal_skill_installations where organization_id=${scope.organizationId} and owner_id=${scope.actor.id}`;
      if (
        !existing &&
        counts!.retained >= personalSkillLimits.retainedInstallations
      )
        throw new PersonalSkillError('limit');
      if (
        (!existing || existing.state !== 'installed') &&
        counts!.n >= personalSkillLimits.installations
      )
        throw new PersonalSkillError('limit');
      const id: string = existing?.id ?? randomUUID();
      const [binding] =
        await tx`select * from allrice_personal_skill_bindings where instance_id=${instance.id} and installation_id=${id} for update`;
      if (existing) {
        const [stale] = await tx`select 1 from allrice_messages m
          where m.id=${input.userMessageId} and m.created_at<=greatest(
            ${existing.revoked_at}::timestamptz,${binding?.revoked_at ?? null}::timestamptz)`;
        if (stale) throw new PersonalSkillError('conflict');
      }
      await assertBindingCapacity(tx, instance.id, !!binding?.enabled);
      if (!existing) {
        const versionId = randomUUID();
        if (selected)
          await tx`update allrice_storage_objects set immutable=true where id=${selected.resourceManifest.archiveObjectId}
          and organization_id=${scope.organizationId} and owner_id=${owner(scope)} and state='ready' and deleted_at is null`;
        await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id)
        values(${id},${scope.organizationId},${scope.actor.id},${definition.name},'installed',${versionId})`;
        await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum,resource_manifest,package_checksum)
        values(${versionId},${scope.organizationId},${scope.actor.id},${id},1,${tx.json(source)},${parsed.originalText},${tx.json(definition)},${digest},${selected ? tx.json(selected.resourceManifest) : null},${packageDigest})`;
      } else if (!binding?.enabled || existing.state !== 'installed') {
        await tx`update allrice_personal_skill_installations set state='installed',revision=revision+1,updated_at=clock_timestamp() where id=${id}`;
      }
      await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
      values(${scope.organizationId},${scope.workspaceId},${scope.actor.id},${instance.id},${id},true)
      on conflict(instance_id,installation_id) do update set enabled=true,
        epoch=allrice_personal_skill_bindings.epoch+case when allrice_personal_skill_bindings.enabled then 0 else 1 end,updated_at=clock_timestamp()`;
      if (selected)
        await tx`update allrice_personal_skill_imports set state='consumed',selected_path=${selected.candidate.sourcePath},installation_id=${id} where id=${selected.importId}`;
      return receipt(tx, scope, intent.requestId, intent.request, id);
    },
  );
}

async function assertBindingCapacity(
  tx: ContentTx,
  instanceId: string,
  alreadyEnabled: boolean,
) {
  const [count] =
    await tx`select count(*)::int n from allrice_personal_skill_bindings where instance_id=${instanceId} and enabled`;
  if (!alreadyEnabled && count!.n >= personalSkillLimits.enabledPerInstance)
    throw new PersonalSkillError('limit');
}

export async function managePersonalSkill(
  contextInput: RequestContext,
  raw: unknown,
) {
  const args = PersonalSkillManageRequestSchema.parse(raw);
  const context = { ...contextInput, workspaceId: args.workspaceId };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    if (!(await readContentPrincipal(context, tx, true))?.writable)
      throw new DataAccessError('authorization_denied');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${context.organizationId}`},0))`;
    if (args.operation !== 'uninstall') {
      if (!args.instanceId) return unavailable();
      const instance = await getEmployeeInstance(context, args.instanceId, tx);
      await tx`select id from allrice_employee_assignments where id=${instance.assignmentId} for share`;
      await tx`select id from allrice_employee_instances where id=${instance.id} for share`;
      await getEmployeeInstance(context, args.instanceId, tx);
    }
    const prior = await priorReceipt(tx, context, args.requestId, args);
    if (prior) return prior;
    const [row] = await tx`select * from allrice_personal_skill_installations
      where id=${args.installationId} and organization_id=${context.organizationId} and owner_id=${owner(context)} for update`;
    if (!row) return unavailable();
    if (row.revision !== args.expectedRevision || row.state !== 'installed')
      throw new PersonalSkillError('conflict');
    if (args.operation === 'uninstall') {
      await tx`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1,revoked_at=clock_timestamp(),updated_at=clock_timestamp() where installation_id=${row.id}`;
    } else {
      const [binding] = await tx`select * from allrice_personal_skill_bindings
        where instance_id=${args.instanceId!} and installation_id=${args.installationId} for update`;
      if (!binding) return unavailable();
      if (args.operation === 'enable')
        await assertBindingCapacity(tx, args.instanceId!, binding.enabled);
      if (binding.enabled !== (args.operation === 'enable'))
        await tx`update allrice_personal_skill_bindings set enabled=${args.operation === 'enable'},epoch=epoch+1,
          revoked_at=case when ${args.operation === 'disable'} then clock_timestamp() else revoked_at end,
          updated_at=clock_timestamp() where id=${binding.id}`;
    }
    await tx`update allrice_personal_skill_installations set state=${args.operation === 'uninstall' ? 'uninstalled' : 'installed'},
      revoked_at=case when ${args.operation === 'uninstall'} then clock_timestamp() else revoked_at end,
      revision=revision+1,updated_at=clock_timestamp() where id=${row.id}`;
    return receipt(tx, context, args.requestId, args, row.id);
  });
}

/** Freeze after ordinary capabilities are resolved. Personal content never
 * grants a tool, dependency, network target or platform-review status. */
export async function freezePersonalSkills(
  context: ContentIdentity,
  instance: { id: string },
  base: {
    nativeSkills: DshNativeSkillSnapshot[];
    catalog?: EmployeeBaseSkillCatalog;
  },
) {
  const instanceId = instance.id;
  return getDatabase().begin(async (tx) => {
    if (!(await readContentPrincipal(context, tx, true))) return unavailable();
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${context.organizationId}`},0))`;
    await getEmployeeInstance(context, instanceId, tx);
    const rows =
      await tx`select b.*,v.id version_id,v.definition,v.definition_checksum,v.resource_manifest,v.package_checksum from allrice_personal_skill_bindings b
      join allrice_personal_skill_installations i on i.id=b.installation_id and i.state='installed'
      join allrice_personal_skill_versions v on v.id=i.current_version_id
      where b.instance_id=${instanceId} and b.organization_id=${context.organizationId} and b.owner_id=${owner(context)} and b.enabled order by b.id`;
    if (!rows.length) return { ...base, personalSkills: undefined };
    const pins: PersonalSkillPin[] = [];
    const additional = rows.map((row) => {
      const definition = PersonalSkillDefinitionSchema.parse(row.definition);
      if (runtimePolicyDigest(definition) !== row.definition_checksum)
        return unavailable();
      validPackage(
        row.resource_manifest,
        row.package_checksum,
        row.definition_checksum,
      );
      const pin: PersonalSkillPin = {
        organizationId: context.organizationId,
        ownerId: owner(context),
        instanceId,
        installationId: row.installation_id,
        versionId: row.version_id,
        bindingId: row.id,
        bindingEpoch: row.epoch,
        definitionChecksum: row.definition_checksum,
        ...(row.package_checksum
          ? { packageChecksum: row.package_checksum }
          : {}),
      };
      pins.push(pin);
      return validateFrozenSkill({
        ...definition,
        id: row.version_id,
        requiredToolRefs: [],
        personal: pin,
      });
    });
    const nativeSkills = [...base.nativeSkills, ...additional].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    if (new Set(nativeSkills.map((s) => s.name)).size !== nativeSkills.length)
      throw new PersonalSkillError('name_conflict');
    if (
      nativeSkills.length > employeeBaseSkillLimits.count ||
      Buffer.byteLength(JSON.stringify(nativeSkills)) >
        employeeBaseSkillLimits.snapshotBytes
    )
      throw new PersonalSkillError('limit');
    const index = { schemaVersion: 1 as const, instanceId, skills: pins };
    const personalSkills = PersonalSkillSnapshotSchema.parse({
      ...index,
      checksum: runtimePolicyDigest(index),
    });
    return {
      nativeSkills,
      personalSkills,
      catalog: base.catalog
        ? {
            ...base.catalog,
            snapshotChecksum: runtimePolicyDigest({
              skills: base.catalog.skills,
              nativeSkills,
            }),
          }
        : undefined,
    };
  });
}

/** The history guard only reads compact immutable provenance, not every
 * historical Skill body on each model request. */
export function assertPersonalSkillPins(
  raw: unknown,
  nativePins: { id: string; personal: unknown }[],
  instanceId?: string,
) {
  if (raw === undefined) {
    if (nativePins.length) return unavailable();
    return;
  }
  const snapshot = PersonalSkillSnapshotSchema.parse(raw);
  const { checksum, ...index } = snapshot;
  if (
    runtimePolicyDigest(index) !== checksum ||
    snapshot.instanceId !== instanceId ||
    nativePins.length !== snapshot.skills.length ||
    new Set(snapshot.skills.map((p) => p.bindingId)).size !==
      snapshot.skills.length
  )
    return unavailable();
  for (const pin of snapshot.skills) {
    const native = nativePins.find((s) => s.id === pin.versionId);
    if (
      !native ||
      runtimePolicyDigest(PersonalSkillPinSchema.parse(native.personal)) !==
        runtimePolicyDigest(pin) ||
      pin.instanceId !== instanceId
    )
      return unavailable();
  }
  return snapshot;
}
export function assertFrozenPersonalSkills(
  raw: unknown,
  nativeSkills: DshNativeSkillSnapshot[],
  instanceId?: string,
) {
  const personal = nativeSkills.filter((s) => s.personal);
  const snapshot = assertPersonalSkillPins(
    raw,
    personal.map((skill) => ({ id: skill.id, personal: skill.personal })),
    instanceId,
  );
  if (!snapshot) return;
  for (const pin of snapshot.skills) {
    const skill = personal.find((s) => s.id === pin.versionId)!;
    if (skill.bundle || skill.requiredToolRefs.length) return unavailable();
    const definition = {
      name: skill.name,
      description: skill.description,
      content: skill.content,
      checksum: skill.checksum,
      invocation: skill.invocation,
      ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
    };
    if (
      runtimePolicyDigest(PersonalSkillDefinitionSchema.parse(definition)) !==
      pin.definitionChecksum
    )
      return unavailable();
  }
}

/** Used by the existing context-generation guard, including prior Runs and
 * imported history. Revocation is independent of a version pointer change. */
export async function assertPersonalSkillsReadable(
  context: ContentIdentity,
  raw: unknown,
  sql: ContentSql,
) {
  if (raw === undefined) return;
  const snapshot = PersonalSkillSnapshotSchema.parse(raw);
  const { checksum, ...index } = snapshot;
  if (runtimePolicyDigest(index) !== checksum) return unavailable();
  try {
    await getEmployeeInstance(context, snapshot.instanceId, sql);
  } catch (error) {
    if (error instanceof DataAccessError) return unavailable();
    throw error;
  }
  for (const pin of snapshot.skills) {
    if (
      pin.organizationId !== context.organizationId ||
      pin.ownerId !== owner(context) ||
      pin.instanceId !== snapshot.instanceId
    )
      return unavailable();
    const [row] =
      await sql`select v.definition_checksum,v.package_checksum from allrice_personal_skill_bindings b
      join allrice_personal_skill_installations i on i.id=b.installation_id and i.state='installed'
      join allrice_personal_skill_versions v on v.installation_id=i.id and v.id=${pin.versionId}
      where b.id=${pin.bindingId} and b.instance_id=${pin.instanceId} and b.installation_id=${pin.installationId}
        and b.organization_id=${context.organizationId} and b.workspace_id=${context.workspaceId} and b.owner_id=${owner(context)}
        and b.enabled and b.epoch=${pin.bindingEpoch}`;
    if (
      !row ||
      row.definition_checksum !== pin.definitionChecksum ||
      (row.package_checksum ?? undefined) !== pin.packageChecksum
    )
      return unavailable();
  }
}

/** Resolve a package resource only from the exact persisted Run and its current
 * private binding. No arbitrary object ID or historical disabled pin is authority.
 * Caller repeats this guard after StoragePort IO before exposing bytes. */
export async function resolvePersonalSkillResource(input: {
  context: ExecutionContext;
  sessionId: string;
  skill: string;
  path: string;
}) {
  const c = input.context;
  const scope = {
    organizationId: c.organizationId,
    workspaceId: c.workspaceId!,
    actor: { type: 'user' as const, id: c.policySnapshot.subjectId },
  };
  return getDatabase().begin(async (tx) => {
    if (!(await readContentPrincipal(scope, tx, true))) return unavailable();
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`employee-content:${scope.organizationId}`},0))`;
    const [run] =
      await tx`select native_skills,execution_snapshot from allrice_employee_runs
      where run_id=${c.runId} and organization_id=${c.organizationId} and workspace_id=${c.workspaceId}
        and owner_id=${scope.actor.id} and session_id=${input.sessionId}`;
    if (!run) return unavailable();
    const execution = EmployeeExecutionSnapshotSchema.parse(
      run.execution_snapshot,
    );
    if (
      execution.schemaVersion !== 2 ||
      !execution.capabilitySnapshot.bindings.toolNames.includes(
        'workspace.skill.read',
      ) ||
      !execution.capabilitySnapshot.grantedCapabilities.includes('storage:read')
    )
      return unavailable();
    const skills = (run.native_skills as unknown[]).map(validateFrozenSkill);
    assertFrozenPersonalSkills(
      execution.personalSkills,
      skills,
      execution.instance?.id,
    );
    await assertPersonalSkillsReadable(scope, execution.personalSkills, tx);
    const skill = skills.find((skill) => skill.name === input.skill);
    if (!skill?.personal?.packageChecksum) return unavailable();
    const [version] =
      await tx`select resource_manifest,package_checksum,definition_checksum,version from allrice_personal_skill_versions
      where id=${skill.personal.versionId} and organization_id=${scope.organizationId} and owner_id=${scope.actor.id}`;
    if (!version || version.package_checksum !== skill.personal.packageChecksum)
      return unavailable();
    const manifest = validPackage(
      version.resource_manifest,
      version.package_checksum,
      version.definition_checksum,
    );
    const resource = manifest?.resources.find(
      (resource) => resource.path === input.path,
    );
    if (!manifest || !resource) throw new PersonalSkillError('source_invalid');
    const object = await packageObject(tx, scope, manifest.archiveObjectId);
    return {
      object,
      sourcePath: manifest.sourcePath,
      resource,
      skill: skill.name,
      version: String(version.version),
      versionId: skill.personal.versionId,
      packageChecksum: version.package_checksum as string,
      bindingId: skill.personal.bindingId,
      bindingEpoch: skill.personal.bindingEpoch,
    };
  });
}
