import { randomUUID } from 'node:crypto';
import {
  ChecksumSchema,
  PersonalSkillDefinitionSchema,
  PersonalSkillItemSchema,
  PersonalSkillPackageSchema,
  PersonalSkillSourceSchema,
  UuidSchema,
  personalSkillLimits,
  type RequestContext,
  type PersonalSkillDefinition,
  type PersonalSkillPackage,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { skillBytesChecksum } from '../skill-bundles.ts';
import { employeeAccessTransaction } from './employee-access-cancellation.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { readCurrentEmployeeBaseSkills } from './employee-current-skills.ts';
import { assertOrdinarySkillSceneName } from './personal-scene-names.ts';
import {
  personalSkillUpdateImpact,
  personalSkillSourceIdentity,
} from './personal-skill-versions.ts';
import {
  PersonalSkillError,
  owner,
  personalSkillItems,
  packageVersionChecksum,
  validPackage,
} from './personal-skill-model.ts';

type Target =
  | {
      operation: 'install';
      expectedInstallation: {
        id: string;
        revision: number;
        versionId: string;
      } | null;
    }
  | {
      operation: 'update';
      installationId: string;
      expectedRevision: number;
      expectedVersionId: string;
      bindingsDigest: string;
    };
type BrowserInput = {
  instanceId: string;
  requestId: string;
  attestationDigest: string;
  target: Target;
  source: unknown;
  originalText: string;
  definition: PersonalSkillDefinition;
  resourceManifest: PersonalSkillPackage;
};

export async function authorizePersonalSkillBrowser(
  context: RequestContext,
  instanceId: string,
) {
  if (
    !context.sessionId ||
    context.actor.type !== 'user' ||
    !(await readContentPrincipal(context))?.writable
  )
    throw new DataAccessError('authorization_denied');
  return getEmployeeInstance(context, UuidSchema.parse(instanceId));
}

export async function previewPersonalSkillInstallTarget(
  context: RequestContext,
  instanceId: string,
  name: string,
) {
  await authorizePersonalSkillBrowser(context, instanceId);
  const [row] =
    await getDatabase()`select id,revision,current_version_id from allrice_personal_skill_installations
    where organization_id=${context.organizationId} and owner_id=${owner(context)} and name=${name}`;
  return row
    ? {
        id: row.id as string,
        revision: row.revision as number,
        versionId: row.current_version_id as string,
      }
    : null;
}

/** Server-only writer: the browser route verifies the signed preview and
 * re-parses its frozen source bytes. No model-provided identity or chat intent
 * is converted into authority. Existing storage/receipt tables are reused. */
export async function confirmPersonalSkillBrowser(
  context: RequestContext,
  input: BrowserInput,
) {
  return browserOperation(context, input, false);
}

/** Complete a replay or an existing-version operation without allocating a
 * duplicate archive. A null result requires storage; the final writer repeats
 * every guard under its lock before publishing that new version. */
export async function preparePersonalSkillBrowserConfirmation(
  context: RequestContext,
  input: BrowserInput,
) {
  return browserOperation(context, input, true);
}

async function browserOperation(
  context: RequestContext,
  input: BrowserInput,
  withoutArchive: boolean,
) {
  const instanceId = UuidSchema.parse(input.instanceId);
  const requestId = UuidSchema.parse(input.requestId);
  const attestationDigest = ChecksumSchema.parse(input.attestationDigest);
  if (!context.sessionId || context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  const definition = PersonalSkillDefinitionSchema.parse(input.definition);
  const source = PersonalSkillSourceSchema.parse(input.source);
  const manifest = PersonalSkillPackageSchema.parse(input.resourceManifest);
  const definitionChecksum = runtimePolicyDigest(definition);
  const packageChecksum = packageVersionChecksum(definitionChecksum, manifest);
  validPackage(manifest, packageChecksum, definitionChecksum);
  if (
    definition.checksum !== skillBytesChecksum(definition.content) ||
    Buffer.byteLength(definition.content) > personalSkillLimits.bodyBytes ||
    Buffer.byteLength(input.originalText) > personalSkillLimits.sourceBytes ||
    (source.kind === 'attachment' &&
      source.objectId !== manifest.archiveObjectId)
  )
    throw new PersonalSkillError('source_invalid');
  const requestInput = {
    purpose: 'browser-skill-confirm-v1',
    workspaceId: context.workspaceId,
    instanceId,
    attestationDigest,
    target: input.target,
  };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    if (!(await readContentPrincipal(context, tx, true))?.writable)
      throw new DataAccessError('authorization_denied');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-content:${context.organizationId}`},0))`;
    let instance = await getEmployeeInstance(context, instanceId, tx);
    await tx`select id from allrice_employee_assignments where id=${instance.assignmentId} for share`;
    await tx`select id from allrice_employee_instances where id=${instance.id} for share`;
    instance = await getEmployeeInstance(context, instanceId, tx);
    const [prior] = await tx`
      select response,request_input=${tx.json(requestInput)}::jsonb matches
      from allrice_personal_skill_receipts where organization_id=${context.organizationId}
        and owner_id=${owner(context)} and request_id=${requestId}`;
    if (prior) {
      if (!prior.matches) throw new PersonalSkillError('conflict');
      const result = prior.response;
      const old = PersonalSkillItemSchema.parse(result.skill);
      const [current] = await personalSkillItems(context, tx, old.id);
      const binding = current?.bindings.find(
        (b) => b.instanceId === instanceId,
      );
      const previous = old.bindings.find((b) => b.instanceId === instanceId);
      if (
        !current ||
        current.state !== 'installed' ||
        current.versionId !== old.versionId ||
        !binding?.enabled ||
        binding.epoch !== previous?.epoch
      )
        throw new PersonalSkillError('conflict');
      if (
        input.target.operation === 'update' &&
        runtimePolicyDigest(
          await personalSkillUpdateImpact(tx, context, old.id),
        ) !== runtimePolicyDigest(result.affectedBindings)
      )
        throw new PersonalSkillError('conflict');
      return result;
    }
    const target = input.target;
    const [row] =
      target.operation === 'update'
        ? await tx`select i.*,v.definition_checksum,v.package_checksum,v.source from allrice_personal_skill_installations i
        join allrice_personal_skill_versions v on v.id=i.current_version_id
        where i.id=${UuidSchema.parse(target.installationId)} and i.organization_id=${context.organizationId}
          and i.owner_id=${owner(context)} for update of i`
        : await tx`select i.*,v.definition_checksum,v.package_checksum,v.source from allrice_personal_skill_installations i
        join allrice_personal_skill_versions v on v.id=i.current_version_id
        where i.name=${definition.name} and i.organization_id=${context.organizationId}
          and i.owner_id=${owner(context)} for update of i`;
    let affectedBindings;
    if (target.operation === 'update') {
      if (!row) throw new PersonalSkillError('unavailable');
      if (
        row.state !== 'installed' ||
        row.revision !== target.expectedRevision ||
        row.current_version_id !== target.expectedVersionId
      )
        throw new PersonalSkillError('conflict');
      if (row.name !== definition.name)
        throw new PersonalSkillError('name_conflict');
      affectedBindings = await personalSkillUpdateImpact(tx, context, row.id);
      if (
        runtimePolicyDigest(affectedBindings) !== target.bindingsDigest ||
        !affectedBindings.some((b) => b.instanceId === instanceId && b.enabled)
      )
        throw new PersonalSkillError('conflict');
    } else {
      const expected = target.expectedInstallation;
      if (
        row
          ? !expected ||
            row.id !== expected.id ||
            row.revision !== expected.revision ||
            row.current_version_id !== expected.versionId
          : expected !== null
      )
        throw new PersonalSkillError('conflict');
      if (
        row &&
        (row.definition_checksum !== definitionChecksum ||
          row.package_checksum !== packageChecksum ||
          row.source.originalChecksum !== source.originalChecksum)
      )
        throw new PersonalSkillError('name_conflict');
    }
    for (const binding of affectedBindings ?? [
      { instanceId, workspaceId: context.workspaceId },
    ]) {
      const bound =
        binding.instanceId === instanceId
          ? instance
          : await getEmployeeInstance(
              { ...context, workspaceId: binding.workspaceId },
              binding.instanceId,
              tx,
            );
      const base = await readCurrentEmployeeBaseSkills(tx, bound);
      if (!('enabled' in binding) || binding.enabled)
        await assertOrdinarySkillSceneName(
          tx,
          { ...context, workspaceId: binding.workspaceId },
          binding.instanceId,
          definition.name,
        );
      if (base.nativeSkills.some((s) => s.name === definition.name))
        throw new PersonalSkillError('name_conflict');
    }
    const id: string = row?.id ?? randomUUID();
    const [binding] = await tx`select * from allrice_personal_skill_bindings
      where instance_id=${instanceId} and installation_id=${id} for update`;
    if (target.operation === 'install') {
      const [counts] =
        await tx`select count(*) filter(where state='installed')::int active,count(*)::int retained
        from allrice_personal_skill_installations where organization_id=${context.organizationId} and owner_id=${owner(context)}`;
      if (
        (!row &&
          counts!.retained >= personalSkillLimits.retainedInstallations) ||
        ((!row || row.state !== 'installed') &&
          counts!.active >= personalSkillLimits.installations)
      )
        throw new PersonalSkillError('limit');
      const [bindings] =
        await tx`select count(*)::int n from allrice_personal_skill_bindings where instance_id=${instanceId} and enabled`;
      if (
        !binding?.enabled &&
        bindings!.n >= personalSkillLimits.enabledPerInstance
      )
        throw new PersonalSkillError('limit');
    }
    const unchanged =
      row &&
      row.state === 'installed' &&
      row.definition_checksum === definitionChecksum &&
      row.package_checksum === packageChecksum &&
      runtimePolicyDigest(personalSkillSourceIdentity(row.source)) ===
        runtimePolicyDigest(personalSkillSourceIdentity(source));
    const needsVersion = !row || (target.operation === 'update' && !unchanged);
    if (needsVersion) {
      const [count] =
        await tx`select count(*)::int n,coalesce(max(version),0)::int latest
        from allrice_personal_skill_versions where installation_id=${id}`;
      if (count!.n >= personalSkillLimits.retainedVersions)
        throw new PersonalSkillError('limit');
      // Match the existing owner-library archive reuse semantics. Provenance
      // changes create a version but do not duplicate identical retained bytes.
      const [retained] = await tx`select o.id from allrice_storage_objects o
        where o.organization_id=${context.organizationId} and o.owner_id=${owner(context)} and o.category='memory'
          and o.visibility='private' and o.immutable and o.state='ready' and o.deleted_at is null
          and o.checksum=${source.originalChecksum} and o.size_bytes=${source.byteLength}
          and exists(select 1 from allrice_personal_skill_versions v where v.organization_id=o.organization_id
            and v.owner_id=o.owner_id and v.resource_manifest->>'archiveObjectId'=o.id::text)
        order by o.id limit 1 for share of o`;
      if (withoutArchive && !retained) return null;
      const [pending] = retained
        ? []
        : await tx`select id from allrice_storage_objects
        where id=${manifest.archiveObjectId} and organization_id=${context.organizationId}
          and workspace_id=${context.workspaceId} and owner_id=${owner(context)} and category='memory'
          and visibility='private' and state='pending' and deleted_at is null
          and checksum=${source.originalChecksum} and size_bytes=${source.byteLength} for update`;
      const archive = retained ?? pending;
      if (!archive) throw new PersonalSkillError('source_invalid');
      const versionSource =
        source.kind === 'attachment'
          ? { ...source, objectId: archive.id }
          : source;
      const payload = {
        schemaVersion: manifest.schemaVersion,
        archiveObjectId: archive.id as string,
        sourcePath: manifest.sourcePath,
        resources: manifest.resources,
      };
      const versionManifest = {
        ...payload,
        checksum: runtimePolicyDigest(payload),
      };
      const versionId = randomUUID();
      if (!row)
        await tx`insert into allrice_personal_skill_installations
        (id,organization_id,owner_id,name,state,current_version_id)
        values(${id},${context.organizationId},${owner(context)},${definition.name},'installed',${versionId})`;
      await tx`insert into allrice_personal_skill_versions
        (id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum,resource_manifest,package_checksum)
        values(${versionId},${context.organizationId},${owner(context)},${id},${count!.latest + 1},${tx.json(versionSource)},
          ${input.originalText},${tx.json(definition)},${definitionChecksum},${tx.json(versionManifest)},${packageChecksum})`;
      if (!retained)
        await tx`update allrice_storage_objects set state='ready',immutable=true,updated_at=clock_timestamp() where id=${archive.id}`;
      if (row)
        await tx`update allrice_personal_skill_installations set current_version_id=${versionId},revision=revision+1,updated_at=clock_timestamp() where id=${id}`;
    }
    if (target.operation === 'install') {
      if (row && (!binding?.enabled || row.state !== 'installed'))
        await tx`update allrice_personal_skill_installations set state='installed',revision=revision+1,updated_at=clock_timestamp() where id=${id}`;
      await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
        values(${context.organizationId},${context.workspaceId},${owner(context)},${instanceId},${id},true)
        on conflict(instance_id,installation_id) do update set enabled=true,
          epoch=allrice_personal_skill_bindings.epoch+case when allrice_personal_skill_bindings.enabled then 0 else 1 end,updated_at=clock_timestamp()`;
    }
    const [skill] = await personalSkillItems(context, tx, id);
    if (!skill) throw new PersonalSkillError('unavailable');
    const result = {
      skill,
      ...(affectedBindings ? { affectedBindings } : {}),
      receipt: {
        operation: target.operation,
        requestId,
        instanceId,
        installationId: id,
        revision: skill.revision,
        versionId: skill.versionId,
        definitionChecksum: skill.definitionChecksum,
        packageChecksum: skill.packageChecksum,
        source: skill.source,
        effectiveFrom: 'next_task',
        ...(affectedBindings
          ? { affectedBindings, unchanged: !!unchanged }
          : {}),
      },
    };
    await tx`insert into allrice_personal_skill_receipts(organization_id,owner_id,request_id,request_input,response)
      values(${context.organizationId},${owner(context)},${requestId},${tx.json(requestInput)},${tx.json(result)})`;
    return result;
  });
}

/** Never delete bytes following an uncertain commit: only a still-pending
 * object can be claimed for cleanup, under the same row lock as confirmation. */
export async function abandonPersonalSkillBrowserArchive(
  context: RequestContext,
  objectId: string,
) {
  const rows =
    await getDatabase()`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=${UuidSchema.parse(objectId)} and organization_id=${context.organizationId} and owner_id=${owner(context)}
      and state='pending' and not immutable returning id`;
  return rows.length === 1;
}
