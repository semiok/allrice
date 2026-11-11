import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import {
  CreateEmployeeInstanceInputSchema,
  UpdateEmployeeInstanceInputSchema,
  EmployeeInstanceSchema,
  EmployeeInstanceSnapshotSchema,
  EmployeeInstanceLifecycleInputSchema,
  EmployeeInstanceRevisionSchema,
  EmployeeVersionSourceSchema,
  EmployeeProfileChatInputSchema,
  ExecutionContextSchema,
  EmployeeInstanceProfileSchema,
  EmployeeManifestSchema,
  EmployeeDefinitionSchema,
  EmployeePersonaPinSchema,
  EmployeePersonaVersionSourceSchema,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  UuidSchema,
  type EmployeeInstance,
  type EmployeeInstanceSnapshot,
  type RequestContext,
  type ExecutionContext,
  type EmployeeInstanceProfile,
  type EmployeePersonaPin,
  type EmployeePersonaTask,
  type EmployeePersonaSourceMaterial,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { isBaseRiceInstance } from './employee-instance-policy.ts';
import { employeeManifestChecksum } from './employee-config.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import { frozenPackageSkills } from '../skill-bundles.ts';
import {
  runtimePackageChecksum,
  runtimePackageSystemPrompt,
  employeePersonaManifestMaterial,
  employeePersonaPlatformSystemPrompt,
  readEmployeePersonaAdmissionPreparation,
  withEmployeePersonaAdmissionPreparation,
} from '../platform-employees/runtime-package.ts';
import {
  cancelEmployeeAccessRuns,
  employeeAccessTransaction,
} from './employee-access-cancellation.ts';
import {
  assertEmployeeChatRun,
  assertEmployeeChatHumanSource,
} from './employee-chat-authority.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
type Tx = postgres.TransactionSql;
type Identity = Pick<
  RequestContext,
  'actor' | 'organizationId' | 'workspaceId'
> &
  Partial<Pick<RequestContext, 'sessionId'>>;
type InstanceRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  assignment_id: string;
  kind: 'general' | 'custom';
  creation_version_id: string;
  current_version_id: string;
  revision: number;
  profile: unknown;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

/** Resolve an immutable tenant version, never the deployment's mutable pointer. */
export async function readEmployeeVersionPublication(
  scope: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    versionId: string;
  },
  sql: Sql = getDatabase(),
) {
  const [publication] = await sql<
    {
      platform_employee_id: string;
      revision_id: string;
      revision: number;
      checksum: string;
      definition: unknown;
    }[]
  >`
    select r.employee_id as platform_employee_id, r.id as revision_id,
      r.revision, r.checksum, r.definition
    from allrice_employee_version_sources p
    join allrice_platform_employee_revisions r
      on r.id = p.platform_revision_id and r.employee_id = p.platform_employee_id
    where p.organization_id = ${scope.organizationId}
      and p.workspace_id = ${scope.workspaceId}
      and p.employee_id = ${scope.employeeId}
      and p.employee_version_id = ${scope.versionId}
      and r.status = 'published'
  `;
  return publication;
}

/** A tenant version can attest explicit null-package materials or a signed
 * schema-3 package. Neither invents a platform publication. */
export async function readEmployeeTenantPersonaVersion(
  scope: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    versionId: string;
    role?: 'basis' | 'engine';
    expectedSource?: EmployeeInstanceSnapshot['source'];
    forRunInput?: boolean;
  },
  sql: Sql,
): Promise<
  | {
      source: {
        kind: 'tenant_version';
        employeeVersionId: string;
        configChecksum: string;
        manifestDigest: string;
      };
      material: EmployeePersonaSourceMaterial;
      manifest: ReturnType<typeof EmployeeDefinitionSchema.parse>;
    }
  | undefined
> {
  const [row] = await sql<
    { manifest: unknown; config_checksum: string; mapping_id: string | null }[]
  >`select v.manifest,v.config_checksum,p.employee_version_id mapping_id
    from allrice_employee_versions v
    left join allrice_employee_version_sources p on p.employee_version_id=v.id
    where v.id=${scope.versionId} and v.organization_id=${scope.organizationId}
      and v.workspace_id=${scope.workspaceId} and v.employee_id=${scope.employeeId}`;
  return parseEmployeeTenantPersonaVersion(scope, row);
}

function assertPersonaSourcePresence(
  scope: { forRunInput?: boolean; role?: 'basis' | 'engine' },
  row: { manifest: unknown; mapping_id: string | null },
) {
  const raw = row.manifest;
  if (raw === null || typeof raw !== 'object') return false;
  const rawPackage = 'runtimePackage' in raw ? raw.runtimePackage : undefined;
  const hasPackageMaterial =
    rawPackage !== null &&
    typeof rawPackage === 'object' &&
    'schemaVersion' in rawPackage &&
    rawPackage.schemaVersion === 3;
  if (!('personaSource' in raw) && !hasPackageMaterial) {
    // Read-only absence never recovers policy from composite text. New input
    // retires only the approved raw old-package/null/v1-basis shapes.
    if (
      scope.forRunInput &&
      rawPackage !== null &&
      typeof rawPackage === 'object' &&
      'schemaVersion' in rawPackage &&
      (rawPackage.schemaVersion === 1 || rawPackage.schemaVersion === 2)
    )
      throw Error('employee_persona_source_unavailable', {
        cause: 'legacy_runtime_package_platform_policy_missing',
      });
    if (
      scope.forRunInput &&
      row.mapping_id === null &&
      'schemaVersion' in raw &&
      ((raw.schemaVersion === 2 && rawPackage === null) ||
        (raw.schemaVersion === 1 && scope.role === 'basis'))
    )
      throw Error('employee_persona_source_unavailable', {
        cause:
          raw.schemaVersion === 1
            ? 'legacy_v1_basis_persona_source_missing'
            : 'legacy_null_package_persona_source_missing',
      });
    return false;
  }
  return true;
}

function parseEmployeeTenantPersonaVersion(
  scope: {
    organizationId: string;
    workspaceId: string;
    employeeId: string;
    versionId: string;
    role?: 'basis' | 'engine';
    expectedSource?: EmployeeInstanceSnapshot['source'];
    forRunInput?: boolean;
  },
  row:
    | { manifest: unknown; config_checksum: string; mapping_id: string | null }
    | undefined,
) {
  if (!row) throw Error('employee_persona_source_unavailable');
  if (!assertPersonaSourcePresence(scope, row)) return undefined;
  const raw = row.manifest;
  const manifest = EmployeeDefinitionSchema.parse(raw);
  const pkg = manifest.runtimePackage;
  if (
    row.mapping_id !== null ||
    (pkg !== null && pkg.schemaVersion !== 3) ||
    (scope.expectedSource &&
      (scope.expectedSource.kind !== 'tenant_version' ||
        scope.expectedSource.employeeVersionId !== scope.versionId))
  )
    throw Error('employee_persona_source_mapping_invalid');
  if (pkg) frozenPackageSkills(pkg);
  if (
    (pkg?.checksum ?? employeeManifestChecksum(manifest)) !==
    row.config_checksum
  )
    throw Error('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
  const material = employeePersonaManifestMaterial(manifest);
  if (!material) throw Error('employee_persona_source_unavailable');
  return {
    source: {
      kind: 'tenant_version' as const,
      employeeVersionId: scope.versionId,
      configChecksum: row.config_checksum,
      manifestDigest: runtimePolicyDigest(manifest),
    },
    material,
    manifest,
  };
}

/** Only actual raw absence is unmigrated. A default basis is read from its
 * independent publication, not subjected to engine/materializer eligibility.
 * The engine separately proves the original package/policy relationship. */
type PersonaSourceScope = {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  versionId: string;
  role: 'basis' | 'engine';
  expectedSource?: EmployeeInstanceSnapshot['source'];
  forRunInput?: boolean;
};
type PersonaSourceRow = {
  manifest: unknown;
  config_checksum: string;
  mapping_id: string | null;
  mapping_organization_id: string | null;
  mapping_workspace_id: string | null;
  mapping_employee_id: string | null;
  template_id: string | null;
  template_revision_id: string | null;
  revision_employee_id: string | null;
  revision: number | null;
  revision_status: string | null;
  definition: unknown;
  definition_checksum: string | null;
  runtime_profile: unknown;
  platform_key: string | null;
};
type PreparedPersona = {
  scope: PersonaSourceScope;
  row: PersonaSourceRow;
  projection: { error: unknown } | { value: void };
  values: Record<
    'basis' | 'engine',
    | { value: ReturnType<typeof parseEmployeePersonaVersion> }
    | { error: unknown }
  >;
};
type PersonaProjectionInput = {
  employeeVersionId: string;
  configChecksum: string;
  manifest: unknown;
};
export type EmployeePersonaAdmissionPreparation = {
  sources: Map<string, PreparedPersona>;
  used: Map<string, PersonaSourceScope>;
  projections: Map<string, PersonaSourceScope>;
  assertProjection: (input: PersonaProjectionInput) => void;
};
const personaSourceKey = (s: PersonaSourceScope) =>
  `${s.organizationId}:${s.workspaceId}:${s.employeeId}:${s.versionId}`;

async function readPersonaSourceRow(scope: PersonaSourceScope, sql: Sql) {
  const [row] = await sql<
    PersonaSourceRow[]
  >`select v.manifest,v.config_checksum,
    p.employee_version_id mapping_id,p.organization_id mapping_organization_id,
    p.workspace_id mapping_workspace_id,p.employee_id mapping_employee_id,
    p.platform_employee_id template_id,p.platform_revision_id template_revision_id,
    r.employee_id revision_employee_id,r.revision,r.status revision_status,
    r.definition,r.checksum definition_checksum,r.runtime_profile,pe.employee_key platform_key
    from allrice_employee_versions v
    left join allrice_employee_version_sources p on p.employee_version_id=v.id
    left join allrice_platform_employee_revisions r on r.id=p.platform_revision_id
    left join allrice_platform_employees pe on pe.id=r.employee_id
    where v.id=${scope.versionId} and v.organization_id=${scope.organizationId}
      and v.workspace_id=${scope.workspaceId} and v.employee_id=${scope.employeeId}`;
  return row;
}

function freezePersonaSource<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezePersonaSource(child);
    Object.freeze(value);
  }
  return value;
}

/** Parsing and signature/resource verification happen before begin takes any
 * admission locks. Failures are deferred until the original authority gates. */
export async function employeePersonaAdmission<T>(
  sql: ReturnType<typeof getDatabase>,
  target:
    | {
        automationId: string;
        ownerId?: string;
        organizationId?: string;
        workspaceId?: string;
      }
    | {
        organizationId: string;
        workspaceId: string;
        employeeId: string;
        versionIds: string[];
      }
    | {
        assignmentId: string;
        organizationId: string;
        workspaceId?: string;
        ownerId: string;
      }
    | undefined,
  operation: (tx: Tx) => Promise<T>,
) {
  const scopes =
    target &&
    'automationId' in target &&
    UuidSchema.safeParse(target.automationId).success
      ? await sql<
          {
            organization_id: string;
            workspace_id: string;
            employee_id: string;
            version_id: string;
          }[]
        >`
        select distinct v.organization_id,v.workspace_id,v.employee_id,v.id version_id
        from allrice_automations p
        join allrice_employee_assignments a on a.id=p.employee_assignment_id
          and a.organization_id=p.organization_id and a.workspace_id=p.workspace_id and a.user_id=p.owner_id
        join allrice_chat_sessions c on c.id=p.session_id and c.owner_id=p.owner_id
          and c.organization_id=p.organization_id and c.workspace_id=p.workspace_id
        join allrice_employee_versions v on v.employee_id=a.employee_id
          and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
          and v.id in (a.employee_version_id,c.employee_version_id)
        where p.id=${target.automationId}
          and (${target.ownerId ?? null}::uuid is null or p.owner_id=${target.ownerId ?? null})
          and (${target.organizationId ?? null}::uuid is null or p.organization_id=${target.organizationId ?? null})
          and (${target.workspaceId ?? null}::uuid is null or p.workspace_id=${target.workspaceId ?? null})
          and p.brand_content_binding is null
          and p.quality_binding is null and p.experience_binding is null`
      : target && 'versionIds' in target
        ? [...new Set(target.versionIds)].map((versionId) => ({
            organization_id: target.organizationId,
            workspace_id: target.workspaceId,
            employee_id: target.employeeId,
            version_id: versionId,
          }))
        : target &&
            'assignmentId' in target &&
            UuidSchema.safeParse(target.assignmentId).success
          ? await sql<
              {
                organization_id: string;
                workspace_id: string;
                employee_id: string;
                version_id: string;
              }[]
            >`select a.organization_id,a.workspace_id,a.employee_id,a.employee_version_id version_id
              from allrice_employee_assignments a where a.id=${target.assignmentId}
                and a.organization_id=${target.organizationId} and a.user_id=${target.ownerId}
                and (${target.workspaceId ?? null}::uuid is null or a.workspace_id=${target.workspaceId ?? null})`
          : [];
  const prepared = new Map<string, PreparedPersona>();
  for (const s of scopes) {
    const scope: PersonaSourceScope = {
      organizationId: s.organization_id,
      workspaceId: s.workspace_id,
      employeeId: s.employee_id,
      versionId: s.version_id,
      role: 'engine',
    };
    const row = await readPersonaSourceRow(scope, sql);
    if (!row) continue;
    const values = {} as PreparedPersona['values'];
    for (const role of ['basis', 'engine'] as const) {
      try {
        values[role] = {
          value: freezePersonaSource(
            parseEmployeePersonaVersion({ ...scope, role }, row),
          ),
        };
      } catch (error) {
        values[role] = { error };
      }
    }
    let projection: PreparedPersona['projection'];
    try {
      employeePersonaManifestMaterial(
        EmployeeDefinitionSchema.parse(row.manifest),
      );
      projection = { value: undefined };
    } catch (error) {
      projection = { error };
    }
    prepared.set(personaSourceKey(scope), { scope, row, values, projection });
  }
  return sql.begin(async (tx) => {
    const used = new Map<string, PersonaSourceScope>();
    const projections = new Map<string, PersonaSourceScope>();
    return withEmployeePersonaAdmissionPreparation(
      tx,
      {
        sources: prepared,
        used,
        projections,
        assertProjection: (input) =>
          assertPreparedEmployeePersonaProjection(input, prepared, projections),
      },
      async () => {
        const result = await operation(tx);
        // The real outer owner validates after its last write/wait, including
        // occurrence/automation bindings after enqueue returns.
        const checked = new Set<string>();
        for (const scope of used.values()) {
          await readEmployeePersonaVersion(scope, tx);
          checked.add(personaSourceKey(scope));
        }
        // Current execution binding also serves legacy/no-PERSONA callers. Its
        // projection proof adds raw OCC, never an extra engine eligibility gate.
        for (const [key, scope] of projections) {
          if (checked.has(key)) continue;
          const row = await readPersonaSourceRow(scope, tx);
          if (!isDeepStrictEqual(row, prepared.get(key)?.row))
            throw new EmployeeInstanceError('instance_conflict');
        }
        return result;
      },
    );
  });
}

/** Consume only the projection prepared for this actual admission transaction.
 * The original current-binding validator still owns all baseline checks. */
function assertPreparedEmployeePersonaProjection(
  input: PersonaProjectionInput,
  sources: Map<string, PreparedPersona>,
  projections: Map<string, PersonaSourceScope>,
) {
  for (const [key, prior] of sources) {
    if (prior.scope.versionId !== input.employeeVersionId) continue;
    if (
      prior.row.config_checksum !== input.configChecksum ||
      !isDeepStrictEqual(prior.row.manifest, input.manifest)
    )
      throw new EmployeeInstanceError('instance_conflict');
    projections.set(key, prior.scope);
    if ('error' in prior.projection) throw prior.projection.error;
    return;
  }
  throw new EmployeeInstanceError('instance_conflict');
}

export async function readEmployeePersonaVersion(
  scope: PersonaSourceScope,
  sql: Sql,
) {
  const row = await readPersonaSourceRow(scope, sql);
  const preparation = readEmployeePersonaAdmissionPreparation(sql as Tx);
  if (!preparation) return parseEmployeePersonaVersion(scope, row);
  if (!row) throw Error('employee_persona_source_unavailable');
  // This exact raw classification deliberately stays in the original short
  // transaction, after current authority, and keeps the three approved causes.
  if (row.mapping_id === null) {
    if (scope.expectedSource?.kind === 'platform')
      throw Error('employee_persona_source_unavailable');
    assertPersonaSourcePresence(scope, row);
  }
  const key = personaSourceKey(scope);
  const prior = preparation.sources.get(key);
  if (!prior || !isDeepStrictEqual(row, prior.row))
    throw new EmployeeInstanceError('instance_conflict');
  preparation.used.set(
    `${key}:${scope.role}:${scope.forRunInput === true}`,
    scope,
  );
  const outcome = prior.values[scope.role];
  if ('error' in outcome) throw outcome.error;
  const value = outcome.value;
  if (scope.expectedSource) {
    if (row.mapping_id === null && scope.expectedSource.kind === 'platform')
      throw Error('employee_persona_source_unavailable');
    if (value && 'kind' in value.source) {
      if (
        scope.expectedSource.kind !== 'tenant_version' ||
        scope.expectedSource.employeeVersionId !== scope.versionId
      )
        throw Error('employee_persona_source_mapping_invalid');
    } else if (
      value &&
      (scope.expectedSource.kind !== 'platform' ||
        scope.expectedSource.employeeVersionId !== scope.versionId ||
        scope.expectedSource.templateId !== row.template_id ||
        scope.expectedSource.templateRevisionId !== row.template_revision_id ||
        scope.expectedSource.templateRevision !== row.revision ||
        scope.expectedSource.templateChecksum !== row.definition_checksum)
    )
      throw Error('employee_persona_source_mapping_changed');
  }
  return value;
}

function parseEmployeePersonaVersion(
  scope: PersonaSourceScope,
  row: PersonaSourceRow | undefined,
) {
  if (!row) throw Error('employee_persona_source_unavailable');
  if (row.mapping_id === null) {
    if (scope.expectedSource?.kind === 'platform')
      throw Error('employee_persona_source_unavailable');
    return parseEmployeeTenantPersonaVersion(scope, row);
  }
  if (
    row.mapping_organization_id !== scope.organizationId ||
    row.mapping_workspace_id !== scope.workspaceId ||
    row.mapping_employee_id !== scope.employeeId ||
    row.revision_employee_id !== row.template_id ||
    row.revision_status !== 'published' ||
    !row.platform_key
  )
    throw Error('employee_persona_source_mapping_invalid');
  const definition = PlatformEmployeeDefinitionSchema.parse(row.definition);
  if (runtimePackageChecksum(definition) !== row.definition_checksum)
    throw Error('employee_persona_source_definition_checksum_mismatch');
  if (
    scope.expectedSource &&
    (scope.expectedSource.kind !== 'platform' ||
      scope.expectedSource.employeeVersionId !== scope.versionId ||
      scope.expectedSource.templateId !== row.template_id ||
      scope.expectedSource.templateRevisionId !== row.template_revision_id ||
      scope.expectedSource.templateRevision !== row.revision ||
      scope.expectedSource.templateChecksum !== row.definition_checksum)
  )
    throw Error('employee_persona_source_mapping_changed');
  const evidence = {
    employeeVersionId: scope.versionId,
    configChecksum: row.config_checksum,
    templateId: row.template_id,
    templateRevisionId: row.template_revision_id,
    templateRevision: row.revision,
    templateChecksum: row.definition_checksum,
  };
  const material = {
    foundation: {
      name: definition.name,
      description: definition.description,
      appearance: definition.appearance,
      identity: definition.identity,
    },
    platformPolicy: definition.systemPrompt,
  };
  if (scope.role === 'basis') {
    // The config checksum is the original version's stored identity, not an
    // assertion that v1 has a package or that a default is executable. The
    // independent, checksum-verified publication supplies every default field.
    const manifest = EmployeeManifestSchema.parse(row.manifest);
    return {
      source: EmployeePersonaVersionSourceSchema.parse({
        ...evidence,
        manifestDigest: runtimePolicyDigest(manifest),
      }),
      definition,
      material,
      manifest,
      platformKey: row.platform_key,
    };
  }
  const manifest = EmployeeDefinitionSchema.parse(row.manifest);
  const pkg = manifest.runtimePackage;
  if (pkg) {
    // Existing signature/resources, never a current-generation test on basis.
    frozenPackageSkills(pkg);
    if (pkg.checksum !== row.config_checksum)
      throw Error('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
    if (pkg.schemaVersion === 3) {
      employeePersonaManifestMaterial(manifest);
      if (
        runtimePolicyDigest(pkg.foundation) !==
          runtimePolicyDigest(material.foundation) ||
        pkg.platformPolicy !== material.platformPolicy
      )
        throw Error('employee_persona_source_projection_mismatch');
    }
  } else if (employeeManifestChecksum(manifest) !== row.config_checksum) {
    throw Error('CURRENT_EXECUTION_SOURCE_CHECKSUM_MISMATCH');
  }
  // The real materializer requires a package and copies this exact package
  // from the published revision. A hypothetical null+mapping is not proof.
  const publication = PlatformEmployeeRuntimeProfileSchema.pick({
    runtimePackage: true,
  })
    .strip()
    .parse(row.runtime_profile);
  if (
    !pkg ||
    !publication.runtimePackage ||
    publication.runtimePackage.checksum !== pkg.checksum ||
    runtimePolicyDigest(publication.runtimePackage) !== runtimePolicyDigest(pkg)
  )
    throw Error('employee_persona_source_package_mismatch');
  const identity = {
    role: definition.identity.role,
    mission: definition.identity.mission,
    workStyle: definition.identity.workStyle,
    behaviorRules: definition.identity.behaviorRules,
    safetyBoundaries: definition.identity.safetyBoundaries,
  };
  if (
    manifest.name !== definition.name ||
    manifest.description !== definition.description ||
    runtimePolicyDigest(manifest.appearance) !==
      runtimePolicyDigest(definition.appearance) ||
    runtimePolicyDigest(manifest.identity) !== runtimePolicyDigest(identity) ||
    manifest.partnerProfile.communicationStyle !==
      definition.identity.expressionStyle ||
    manifest.partnerProfile.outputLanguage !==
      definition.identity.outputLanguage ||
    (manifest.systemPrompt !==
      employeePersonaPlatformSystemPrompt(definition) &&
      (pkg.schemaVersion === 3 ||
        manifest.systemPrompt !==
          runtimePackageSystemPrompt({
            platformPolicy: definition.systemPrompt,
            runtimePackage: pkg,
          })))
  )
    throw Error('employee_persona_source_projection_mismatch');
  return {
    source: EmployeePersonaVersionSourceSchema.parse({
      ...evidence,
      manifestDigest: runtimePolicyDigest(manifest),
      packageChecksum: pkg.checksum,
    }),
    definition,
    material,
    manifest,
    platformKey: row.platform_key,
  };
}

export class EmployeeInstanceError extends Error {
  constructor(
    public readonly code:
      'instance_conflict' | 'instance_archived' | 'default_protected',
  ) {
    super(code);
  }
}

function actorId(context: Identity) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  return context.actor.id;
}

async function authority(
  context: Identity,
  sql: Sql,
  lock: boolean | 'update_user' = false,
) {
  const principal = await readContentPrincipal(context, sql, lock);
  if (!principal || (lock && !principal.writable))
    throw new DataAccessError('authorization_denied');
}

async function auditInstance(
  tx: Tx,
  context: Identity & Pick<RequestContext, 'requestId'>,
  id: string,
  operation: 'create' | 'update' | 'archive' | 'restore',
) {
  await tx`insert into allrice_audit_events
    (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${context.organizationId},${context.workspaceId},${actorId(context)},${`employee.instance.${operation}`},
      'employee_instance',${id},'allowed','owner_with_current_assignment',${context.requestId})`;
}

/** The assignment row serializes publication/revocation. We deliberately do
 * not take the deployment advisory gate after identity locks: publication and
 * membership writers already hold different outer gates. */
async function assignment(
  context: Identity,
  id: string,
  sql: Sql,
  lock = false,
) {
  const rows = await sql<
    { id: string; employee_version_id: string; employee_id: string }[]
  >`
    select a.id,a.employee_version_id,a.employee_id from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    where a.id=${UuidSchema.parse(id)} and a.organization_id=${context.organizationId}
      and a.workspace_id=${context.workspaceId} and a.user_id=${actorId(context)}
      and a.active and e.status='active'
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
          and d.tenant_employee_id=a.employee_id and not d.active)
    ${lock ? sql`for share of a` : sql``}`;
  if (!rows[0]) throw new DataAccessError('authorization_denied');
  return rows[0];
}

/** Stable default mapping for old and newly assigned employees. This never
 * changes a profile, revives an instance, or transfers its owner. */
export async function ensureGeneralEmployeeInstance(
  sql: Sql,
  assignmentId: string,
) {
  await sql`insert into allrice_employee_instances
    (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id)
    select id,organization_id,workspace_id,user_id,id,'general',employee_version_id
    from allrice_employee_assignments where id=${assignmentId}
    on conflict(id) do nothing`;
  await sql`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation)
    select id,1,'{}'::jsonb,'create' from allrice_employee_instances where id=${assignmentId}
    on conflict(instance_id,revision) do nothing`;
}

async function mapInstances(
  rows: InstanceRow[],
  sql: Sql,
): Promise<EmployeeInstance[]> {
  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.creation_version_id, r.current_version_id]),
    ),
  ];
  const sources = ids.length
    ? await sql<
        {
          employee_version_id: string;
          platform_employee_id: string;
          platform_revision_id: string;
          revision: number;
          checksum: string;
        }[]
      >`
    select s.employee_version_id,s.platform_employee_id,s.platform_revision_id,r.revision,r.checksum
    from allrice_employee_version_sources s join allrice_platform_employee_revisions r
      on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
    where s.employee_version_id in ${sql(ids)}`
    : [];
  const source = (id: string) => {
    const row = sources.find((s) => s.employee_version_id === id);
    return EmployeeVersionSourceSchema.parse(
      row
        ? {
            kind: 'platform',
            employeeVersionId: id,
            templateId: row.platform_employee_id,
            templateRevisionId: row.platform_revision_id,
            templateRevision: row.revision,
            templateChecksum: row.checksum,
          }
        : { kind: 'tenant_version', employeeVersionId: id },
    );
  };
  return rows.map((r) =>
    EmployeeInstanceSchema.parse({
      id: r.id,
      assignmentId: r.assignment_id,
      organizationId: r.organization_id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      kind: r.kind,
      revision: r.revision,
      profile: r.profile,
      creationSource: source(r.creation_version_id),
      source: source(r.current_version_id),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      archivedAt: r.archived_at?.toISOString() ?? null,
    }),
  );
}

export async function listEmployeeInstances(
  context: Identity,
  workspaceId: string,
  sql: Sql = getDatabase(),
) {
  const scope = { ...context, workspaceId: UuidSchema.parse(workspaceId) };
  await authority(scope, sql);
  const rows = await sql<InstanceRow[]>`
    select i.*,a.employee_version_id current_version_id from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id
    join allrice_employees e on e.id=a.employee_id
    where i.organization_id=${context.organizationId} and i.workspace_id=${workspaceId}
      and i.owner_id=${actorId(context)} and i.archived_at is null and a.active and e.status='active'
      and not exists(select 1 from allrice_platform_employee_tenant_assignments d
        where d.organization_id=a.organization_id and d.workspace_id=a.workspace_id
          and d.tenant_employee_id=a.employee_id and not d.active)
    order by i.kind desc,i.created_at,i.id`;
  return mapInstances(rows, sql);
}

export async function getEmployeeInstance(
  context: Identity,
  idInput: string,
  sql: Sql = getDatabase(),
) {
  const instance = await getEmployeeInstanceForHistory(context, idInput, sql);
  await assignment(context, instance.assignmentId, sql);
  if (instance.archivedAt) throw new EmployeeInstanceError('instance_archived');
  return instance;
}

/** Read-only owner history survives archival/withdrawal. Execution and edits
 * must use getEmployeeInstance and independently require current assignment. */
export async function getEmployeeInstanceForHistory(
  context: Identity,
  idInput: string,
  sql: Sql = getDatabase(),
) {
  await authority(context, sql);
  const [row] = await sql<
    InstanceRow[]
  >`select i.*,a.employee_version_id current_version_id
    from allrice_employee_instances i join allrice_employee_assignments a on a.id=i.assignment_id
    where i.id=${UuidSchema.parse(idInput)} and i.organization_id=${context.organizationId}
      and i.workspace_id=${context.workspaceId} and i.owner_id=${actorId(context)}`;
  if (!row) throw new DataAccessError('not_found');
  return (await mapInstances([row], sql))[0]!;
}

export async function getEmployeeInstanceHistory(
  context: Identity,
  idInput: string,
  beforeRevision?: number,
) {
  const sql = getDatabase(),
    instance = await getEmployeeInstanceForHistory(context, idInput, sql);
  if (
    beforeRevision !== undefined &&
    (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
  )
    throw new EmployeeInstanceError('instance_conflict');
  const rows =
    await sql`select revision,profile,operation,archived_at,restored_from_revision,created_at
    from allrice_employee_instance_revisions where instance_id=${instance.id}
      ${beforeRevision === undefined ? sql`` : sql`and revision<${beforeRevision}`}
    order by revision desc limit 101`;
  const revisions = rows.slice(0, 100).map((row) =>
    EmployeeInstanceRevisionSchema.parse({
      revision: row.revision,
      profile: row.profile,
      operation: row.operation,
      archivedAt: row.archived_at?.toISOString() ?? null,
      restoredFromRevision: row.restored_from_revision,
      createdAt: row.created_at.toISOString(),
    }),
  );
  return {
    instance,
    revisions,
    nextBeforeRevision: rows.length > 100 ? revisions.at(-1)!.revision : null,
  };
}

/** Owner-only discovery also includes archived and withdrawn instances. This
 * list grants no execution or editing authority. */
export async function listHistoricalEmployeeInstances(
  context: Identity,
  workspaceId: string,
  beforeId?: string,
) {
  const scope = { ...context, workspaceId: UuidSchema.parse(workspaceId) };
  const cursor =
    beforeId === undefined ? undefined : UuidSchema.parse(beforeId);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await authority(scope, tx);
      const rows = await tx<
        InstanceRow[]
      >`select i.*,a.employee_version_id current_version_id
      from allrice_employee_instances i join allrice_employee_assignments a on a.id=i.assignment_id
      where i.organization_id=${scope.organizationId} and i.workspace_id=${scope.workspaceId}
        and i.owner_id=${actorId(scope)} ${cursor ? tx`and i.id<${cursor}` : tx``}
      order by i.id desc limit 101`;
      return {
        instances: await mapInstances(rows.slice(0, 100), tx),
        nextBeforeId: rows.length > 100 ? rows[99]!.id : null,
      };
    },
  );
}

export async function createEmployeeInstance(
  context: RequestContext,
  input: unknown,
) {
  const value = CreateEmployeeInstanceInputSchema.parse(input),
    scope = { ...context, workspaceId: value.workspaceId };
  return getDatabase().begin(async (tx) => {
    await authority(scope, tx, true);
    const current = await assignment(scope, value.assignmentId, tx, true);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`employee-instance-create:${scope.organizationId}:${scope.workspaceId}:${actorId(scope)}:${value.requestId}`},0))`;
    const [prior] = await tx<
      { id: string; matches: boolean }[]
    >`select id,creation_input=${tx.json(value)}::jsonb matches
      from allrice_employee_instances where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${actorId(scope)} and creation_request_id=${value.requestId}`;
    if (prior) {
      if (!prior.matches) throw new EmployeeInstanceError('instance_conflict');
      await getEmployeeInstance(scope, prior.id, tx);
      const [saved] =
        await tx`select response from allrice_employee_instance_revisions where instance_id=${prior.id} and revision=1`;
      return EmployeeInstanceSchema.parse(saved?.response);
    }
    const id = randomUUID();
    await tx`insert into allrice_employee_instances
      (id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id,profile,creation_request_id,creation_input)
      values(${id},${scope.organizationId},${scope.workspaceId},${actorId(scope)},${current.id},'custom',${current.employee_version_id},${tx.json(value.profile)},${value.requestId},${tx.json(value)})`;
    await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation) values(${id},1,${tx.json(value.profile)},'create')`;
    const result = await getEmployeeInstance(scope, id, tx);
    await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=1`;
    await auditInstance(tx, scope, id, 'create');
    return result;
  });
}

export async function updateEmployeeInstance(
  context: RequestContext,
  idInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    value = UpdateEmployeeInstanceInputSchema.parse(input),
    scope = { ...context, workspaceId: value.workspaceId };
  return getDatabase().begin((tx) =>
    writeInstanceProfile(
      tx,
      scope,
      id,
      value,
      (current, before) =>
        'operation' in value
          ? {}
          : before.kind === 'general'
            ? {
                ...current,
                ...value.profile,
                ...(value.profile.appearance !== undefined
                  ? {
                      appearance: {
                        ...current.appearance,
                        ...value.profile.appearance,
                      },
                    }
                  : {}),
              }
            : value.profile,
      async (before) => {
        const rice = await isBaseRiceInstance(before, tx);
        if ('operation' in value) {
          if (!rice) throw new DataAccessError('authorization_denied');
          return;
        }
        const allowed: readonly string[] = rice
          ? EmployeeInstanceProfileSchema.keyof().options
          : ['expressionStyle'];
        if (
          before.kind === 'general' &&
          (!Object.keys(value.profile).length ||
            Object.keys(value.profile).some((key) => !allowed.includes(key)))
        )
          throw new DataAccessError('authorization_denied');
      },
    ),
  );
}

/** One revision/receipt transaction for HTTP and governed chat updates. Patch
 * against the locked profile only after replay lookup, preserving other fields. */
async function writeInstanceProfile(
  tx: Tx,
  scope: Identity & Pick<RequestContext, 'requestId'>,
  id: string,
  value: { requestId: string; expectedRevision: number } & postgres.JSONValue,
  profileFor: (
    current: EmployeeInstanceProfile,
    before: EmployeeInstance,
  ) => EmployeeInstanceProfile,
  authorize?: (before: EmployeeInstance) => Promise<void>,
) {
  await authority(scope, tx, true);
  const before = await getEmployeeInstance(scope, id, tx);
  await assignment(scope, before.assignmentId, tx, true);
  const [row] = await tx<
    { revision: number; profile: unknown; archived_at: Date | null }[]
  >`select revision,profile,archived_at from allrice_employee_instances where id=${id} for update`;
  if (!row || row.archived_at)
    throw new EmployeeInstanceError('instance_archived');
  await authorize?.(before);
  const [prior] = await tx<
    { response: unknown; matches: boolean }[]
  >`select response,request_input=${tx.json(value)}::jsonb matches
      from allrice_employee_instance_revisions where instance_id=${id} and request_id=${value.requestId}`;
  if (prior) {
    if (!prior.matches) throw new EmployeeInstanceError('instance_conflict');
    return EmployeeInstanceSchema.parse(prior.response);
  }
  if (row?.revision !== value.expectedRevision)
    throw new EmployeeInstanceError('instance_conflict');
  const revision = row.revision + 1;
  const profile = EmployeeInstanceProfileSchema.parse(
    profileFor(EmployeeInstanceProfileSchema.parse(row.profile), before),
  );
  await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,request_id,request_input)
      values(${id},${revision},${tx.json(profile)},${value.requestId},${tx.json(value)})`;
  await tx`update allrice_employee_instances set revision=${revision},profile=${tx.json(profile)},updated_at=clock_timestamp() where id=${id}`;
  const result = await getEmployeeInstance(scope, id, tx);
  await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=${revision}`;
  await auditInstance(tx, scope, id, 'update');
  return result;
}

export class EmployeeProfileChatError extends Error {
  constructor(
    public readonly code:
      'profile_run_unavailable' | 'general_profile_style_only',
  ) {
    super(code);
  }
}

/** The sole chat write entry. The root Run, original user message, Session and
 * current assignment resolve the private target; model arguments contain none. */
export async function updateEmployeeProfileFromChat(input: {
  context: ExecutionContext;
  sessionId: string;
  userMessageId: string;
  callId: string;
  worker: { attempt: number; leaseToken: string };
  arguments: unknown;
}) {
  const ctx = ExecutionContextSchema.parse(input.context);
  const args = EmployeeProfileChatInputSchema.parse(input.arguments);
  function fail(): never {
    throw new EmployeeProfileChatError('profile_run_unavailable');
  }
  if (
    !ctx.workspaceId ||
    ctx.policySnapshot.organizationId !== ctx.organizationId ||
    ctx.delegatedBy.type !== 'user' ||
    ctx.delegatedBy.id !== ctx.policySnapshot.subjectId ||
    Date.parse(ctx.policySnapshot.expiresAt) <= Date.now() ||
    !input.callId ||
    input.callId.length > 200 ||
    !Number.isSafeInteger(input.worker.attempt) ||
    input.worker.attempt < 0
  )
    fail();
  UuidSchema.parse(input.sessionId);
  UuidSchema.parse(input.userMessageId);
  UuidSchema.parse(input.worker.leaseToken);
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        ctx.organizationId,
        ctx.workspaceId,
        ctx.runId,
        input.callId,
      ]),
    )
    .digest('hex');
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const scope: Identity & Pick<RequestContext, 'requestId'> = {
    actor: { type: 'user', id: ctx.policySnapshot.subjectId },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId!,
    requestId,
  };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    // Read the target without locks first. The same binding is checked again
    // under the Session lock below, after identity/assignment/instance locks.
    const [target] = await tx<
      { id: string }[]
    >`select coalesce(s.employee_instance_id,s.employee_assignment_id) id
      from allrice_chat_sessions s where s.id=${input.sessionId} and s.organization_id=${ctx.organizationId}
        and s.workspace_id=${ctx.workspaceId!} and s.owner_id=${ctx.policySnapshot.subjectId} and s.archived_at is null`;
    if (!target) fail();
    const { expectedRevision, ...patch } = args;
    return writeInstanceProfile(
      tx,
      scope,
      target.id,
      {
        requestId,
        expectedRevision,
        patch,
        runId: ctx.runId,
        userMessageId: input.userMessageId,
      },
      (current) => ({ ...current, ...patch }),
      async (before) => {
        if (
          before.kind === 'general' &&
          args.name !== undefined &&
          !(await isBaseRiceInstance(before, tx))
        )
          throw new EmployeeProfileChatError('general_profile_style_only');
        await assertEmployeeChatRun(
          tx,
          input,
          before,
          'workspace.employee.profile.update',
          fail,
        );
        await assertEmployeeChatHumanSource(input, tx);
      },
    );
  });
}

export async function changeEmployeeInstanceLifecycle(
  contextInput: RequestContext,
  idInput: string,
  raw: unknown,
) {
  const value = EmployeeInstanceLifecycleInputSchema.parse(raw),
    id = UuidSchema.parse(idInput),
    context = { ...contextInput, workspaceId: value.workspaceId };
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await authority(context, tx, true);
    const before = await getEmployeeInstanceForHistory(context, id, tx);
    await assignment(context, before.assignmentId, tx, true);
    const [row] = await tx<
      InstanceRow[]
    >`select * from allrice_employee_instances where id=${id} for update`;
    // Default identity is immutable provenance, not a mutable display name or
    // assignment selection. Refuse before receipts, revisions or cancellation.
    if (value.operation === 'archive' && (await isBaseRiceInstance(before, tx)))
      throw new EmployeeInstanceError('default_protected');
    const [prior] =
      await tx`select response,request_input=${tx.json(value)}::jsonb matches
      from allrice_employee_instance_revisions where instance_id=${id} and request_id=${value.requestId}`;
    if (prior) {
      if (!prior.matches) throw new EmployeeInstanceError('instance_conflict');
      return EmployeeInstanceSchema.parse(prior.response);
    }
    if (!row || row.revision !== value.expectedRevision)
      throw new EmployeeInstanceError('instance_conflict');
    const revision = row.revision + 1;
    let profile = row.profile;
    if (value.operation === 'restore') {
      const [source] =
        await tx`select profile from allrice_employee_instance_revisions where instance_id=${id} and revision=${value.sourceRevision}`;
      if (!source) throw new DataAccessError('not_found');
      if (before.kind === 'general') {
        const current = EmployeeInstanceProfileSchema.parse(row.profile);
        const sourceProfile = EmployeeInstanceProfileSchema.parse(
          source.profile,
        );
        const rice = await isBaseRiceInstance(before, tx);
        const retained = { ...current };
        delete retained.expressionStyle;
        profile = rice
          ? sourceProfile
          : {
              ...retained,
              ...(sourceProfile.expressionStyle
                ? { expressionStyle: sourceProfile.expressionStyle }
                : {}),
            };
      } else profile = source.profile;
    } else if (row.archived_at)
      throw new EmployeeInstanceError('instance_conflict');
    const [updated] =
      await tx`update allrice_employee_instances set revision=${revision},profile=${tx.json(profile as postgres.JSONValue)},
      archived_at=${value.operation === 'archive' ? tx`clock_timestamp()` : tx`null`},updated_at=clock_timestamp() where id=${id} returning archived_at`;
    await tx`insert into allrice_employee_instance_revisions(instance_id,revision,profile,operation,archived_at,restored_from_revision,request_id,request_input)
      values(${id},${revision},${tx.json(profile as postgres.JSONValue)},${value.operation},${updated!.archived_at},${value.operation === 'restore' ? value.sourceRevision : null},${value.requestId},${tx.json(value)})`;
    if (value.operation === 'archive')
      await cancelEmployeeAccessRuns(
        tx,
        {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          instanceId: id,
        },
        'AI 员工已归档',
        context,
      );
    const result = await getEmployeeInstanceForHistory(context, id, tx);
    await tx`update allrice_employee_instance_revisions set response=${tx.json(result)} where instance_id=${id} and revision=${revision}`;
    await auditInstance(tx, context, id, value.operation);
    return result;
  });
}

/** Caller covers authorization and Session/message persistence in one
 * transaction. Identity → assignment → instance precede any Session lock;
 * archival cannot pass this check while a new Session or message is saved. */
export async function resolveEmployeeSessionInstance(
  context: Identity,
  assignmentId: string,
  instanceId: string | undefined,
  tx: Tx,
  lock = true,
) {
  await authority(context, tx, lock);
  await assignment(context, assignmentId, tx, lock);
  // A read never creates the general instance; a missing one is not found.
  if (!instanceId && lock)
    await ensureGeneralEmployeeInstance(tx, assignmentId);
  await tx`select id from allrice_employee_instances where id=${instanceId ?? assignmentId} ${lock ? tx`for share` : tx``}`;
  const instance = await getEmployeeInstance(
    context,
    instanceId ?? assignmentId,
    tx,
  );
  if (instance.assignmentId !== assignmentId)
    throw new DataAccessError('authorization_denied');
  return instance;
}

/** Read the current personal profile with the Session's compatible engine
 * version. Assignment/owner/archive checks stay current; only an explicit
 * cross-engine publication keeps the Session's original package. */
async function sessionEmployeeInstance(
  context: Identity,
  instanceId: string,
  sessionId: string,
  sql: Sql,
) {
  await getEmployeeInstance(context, instanceId, sql);
  const rows = await sql<InstanceRow[]>`
    select i.*,case when allrice_native_session_version_compatible(c.native_root_origin,v.manifest)
      then a.employee_version_id else c.employee_version_id end current_version_id
    from allrice_employee_instances i
    join allrice_employee_assignments a on a.id=i.assignment_id
    join allrice_employee_versions v on v.id=a.employee_version_id
    join allrice_chat_sessions c on c.employee_assignment_id=a.id and coalesce(c.employee_instance_id,c.employee_assignment_id)=i.id
    where i.id=${instanceId} and c.id=${sessionId} and c.organization_id=${context.organizationId}
      and c.workspace_id=${context.workspaceId} and c.owner_id=${actorId(context)} and c.archived_at is null`;
  if (!rows[0]) throw new DataAccessError('authorization_denied');
  return (await mapInstances(rows, sql))[0]!;
}

export async function prepareEmployeeInstanceSnapshot(
  context: Identity,
  sessionId: string,
  assignmentId: string,
  versionId: string,
  sql: Sql = getDatabase(),
): Promise<EmployeeInstanceSnapshot> {
  const [session] = await sql<
    { instance_id: string }[]
  >`select coalesce(employee_instance_id,employee_assignment_id) instance_id
    from allrice_chat_sessions where id=${sessionId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId} and owner_id=${actorId(context)} and employee_assignment_id=${assignmentId} and archived_at is null`;
  if (!session) throw new DataAccessError('authorization_denied');
  // Legacy/default mappings may have been materialized outside the publication path.
  if (session.instance_id === assignmentId)
    await ensureGeneralEmployeeInstance(sql, assignmentId);
  const instance = await sessionEmployeeInstance(
    context,
    session.instance_id,
    sessionId,
    sql,
  );
  if (
    instance.assignmentId !== assignmentId ||
    instance.source.employeeVersionId !== versionId
  )
    throw new EmployeeInstanceError('instance_conflict');
  const snapshot = { ...instance } as Record<string, unknown>;
  delete snapshot.createdAt;
  delete snapshot.updatedAt;
  delete snapshot.archivedAt;
  return EmployeeInstanceSnapshotSchema.parse(snapshot);
}

/** Runs retain their frozen profile, but admission uses current authority.
 * Take the user's final NO KEY UPDATE mode up front (queue allocates a policy version)
 * instead of upgrading SHARE locks in concurrent Sessions. */
export async function assertEmployeeInstanceAdmission(
  tx: Tx,
  context: Identity,
  sessionId: string,
  snapshotInput: EmployeeInstanceSnapshot,
  personaInput?: EmployeePersonaPin,
  taskProducer?: EmployeePersonaTask,
) {
  const snapshot = EmployeeInstanceSnapshotSchema.parse(snapshotInput);
  if (
    snapshot.ownerId !== actorId(context) ||
    snapshot.organizationId !== context.organizationId ||
    snapshot.workspaceId !== context.workspaceId
  )
    throw new DataAccessError('authorization_denied');
  await authority(context, tx, 'update_user');
  const currentAssignment = await assignment(
    context,
    snapshot.assignmentId,
    tx,
    true,
  );
  await tx`select id from allrice_employee_instances where id=${snapshot.id} for share`;
  const instance = await sessionEmployeeInstance(
    context,
    snapshot.id,
    sessionId,
    tx,
  );
  const currentSnapshot = { ...instance } as Record<string, unknown>;
  delete currentSnapshot.createdAt;
  delete currentSnapshot.updatedAt;
  delete currentSnapshot.archivedAt;
  if (
    instance.source.employeeVersionId !== snapshot.source.employeeVersionId ||
    JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot)
  )
    throw new EmployeeInstanceError('instance_conflict');
  if (personaInput !== undefined) {
    const pin = EmployeePersonaPinSchema.parse(personaInput);
    if (
      pin.source.task &&
      (!taskProducer ||
        runtimePolicyDigest(pin.source.task) !==
          runtimePolicyDigest(taskProducer))
    )
      throw Error('employee_persona_snapshot_invalid');
    if (
      pin.source.instanceId !== snapshot.id ||
      pin.source.assignmentId !== snapshot.assignmentId ||
      pin.source.profileRevision !== snapshot.revision ||
      pin.source.ownerId !== snapshot.ownerId ||
      pin.source.organizationId !== context.organizationId ||
      pin.source.workspaceId !== context.workspaceId ||
      pin.source.employeeId !== currentAssignment.employee_id ||
      pin.source.engine.employeeVersionId !== snapshot.source.employeeVersionId
    )
      throw Error('employee_persona_snapshot_invalid');
    const scope = {
      organizationId: snapshot.organizationId,
      workspaceId: snapshot.workspaceId,
      employeeId: currentAssignment.employee_id,
    };
    const basis = pin.source.task
      ? undefined
      : await readEmployeePersonaVersion(
          {
            ...scope,
            role: 'basis',
            versionId: currentAssignment.employee_version_id,
          },
          tx,
        );
    const engine = await readEmployeePersonaVersion(
      {
        ...scope,
        role: 'engine',
        versionId: snapshot.source.employeeVersionId,
      },
      tx,
    );
    if (
      !engine ||
      (!pin.source.task && !basis) ||
      runtimePolicyDigest(pin.source.task ? engine.source : basis!.source) !==
        runtimePolicyDigest(pin.source.basis) ||
      runtimePolicyDigest(engine.source) !==
        runtimePolicyDigest(pin.source.engine)
    )
      throw new EmployeeInstanceError('instance_conflict');
    const eligibility =
      snapshot.kind === 'custom' || (await isBaseRiceInstance(snapshot, tx))
        ? 'full_identity'
        : 'expression_only';
    if (pin.source.profileEligibility !== eligibility)
      throw Error('employee_persona_snapshot_invalid');
  }
  const [session] =
    await tx`select id from allrice_chat_sessions where id=${sessionId}
    and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and owner_id=${actorId(context)}
    and employee_assignment_id=${snapshot.assignmentId} and coalesce(employee_instance_id,employee_assignment_id)=${snapshot.id}
    and archived_at is null for update`;
  if (!session) throw new DataAccessError('authorization_denied');
}

export async function lockEmployeeInstanceAdmissionIdentity(
  tx: Tx,
  context: Identity,
) {
  await authority(context, tx, 'update_user');
}
