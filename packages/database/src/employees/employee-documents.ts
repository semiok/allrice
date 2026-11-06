import type { TransactionSql } from 'postgres';
import {
  selectEmployeeDocumentMemories,
  selectEmployeeUserFacts,
  renderEmployeeMemoryDocument,
  renderEmployeeUserDocument,
  renderEmployeePersonaDocument,
  EmployeePersonaPinSchema,
  EmployeeRunPersonaSourceSchema,
  isBaseRiceInstanceDefinition,
  type EmployeeInstanceSnapshot,
  type EmployeeExecutionSnapshot,
  type EmployeeDocuments,
  type EmployeeUserFacts,
  type MemoryContextItem,
} from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import { employeeMemoryReadPredicate } from '../workspace/employee-memory-read.ts';
import {
  getEmployeeInstance,
  readEmployeePersonaVersion,
} from './employee-instances.ts';
import { employeePersonaPlatformSystemPrompt } from '../platform-employees/runtime-package.ts';

type Sql = ReturnType<typeof getDatabase> | TransactionSql;
type PersonaVersion = NonNullable<
  Awaited<ReturnType<typeof readEmployeePersonaVersion>>
>;
function personaEligibility(
  instance: EmployeeInstanceSnapshot,
  engine: PersonaVersion,
) {
  return instance.kind === 'custom' ||
    (engine.platformKey === 'rice' &&
      engine.definition.key === 'rice' &&
      isBaseRiceInstanceDefinition(instance, {
        key: engine.manifest.key,
        versionId: engine.source.employeeVersionId,
        definition: engine.manifest,
      }))
    ? ('full_identity' as const)
    : ('expression_only' as const);
}
function renderRunPersona(
  instance: EmployeeInstanceSnapshot,
  employeeId: string,
  basis: PersonaVersion,
  engine: PersonaVersion,
) {
  const source = EmployeeRunPersonaSourceSchema.parse({
    kind: 'employee_run',
    organizationId: instance.organizationId,
    workspaceId: instance.workspaceId,
    employeeId,
    assignmentId: instance.assignmentId,
    instanceId: instance.id,
    ownerId: instance.ownerId,
    profileRevision: instance.revision,
    profileEligibility: personaEligibility(instance, engine),
    basis: basis.source,
    engine: engine.source,
  });
  const persona = renderEmployeePersonaDocument(
    {
      name: basis.definition.name,
      description: basis.definition.description,
      appearance: basis.definition.appearance,
      identity: basis.definition.identity,
    },
    source,
    instance.profile,
  );
  const systemPrompt = employeePersonaPlatformSystemPrompt(engine.definition);
  return {
    persona,
    systemPrompt,
    pin: EmployeePersonaPinSchema.parse({
      schemaVersion: 1,
      source,
      personaDigest: runtimePolicyDigest(persona),
      systemDigest: runtimePolicyDigest(systemPrompt),
    }),
  };
}

/** The caller's ordinary-human flag and original admission grant eligibility.
 * A legitimate absent source is unmigrated; validation errors never fall back. */
async function freezeRunPersona(
  sql: Sql,
  instance: EmployeeInstanceSnapshot,
  employeeId: string,
) {
  const scope = {
    organizationId: instance.organizationId,
    workspaceId: instance.workspaceId,
    employeeId,
  };
  const current = await getEmployeeInstance(
    {
      actor: { type: 'user', id: instance.ownerId },
      organizationId: instance.organizationId,
      workspaceId: instance.workspaceId,
    },
    instance.id,
    sql,
  );
  const basis = await readEmployeePersonaVersion(
    {
      ...scope,
      role: 'basis',
      versionId: current.source.employeeVersionId,
      expectedSource: current.source,
    },
    sql,
  );
  const engine = await readEmployeePersonaVersion(
    {
      ...scope,
      role: 'engine',
      versionId: instance.source.employeeVersionId,
      expectedSource: instance.source,
    },
    sql,
  );
  // Exact missing mappings (including the verified null producer) retain the
  // existing whole path. Do not half-migrate or catch a failed proof here.
  if (!basis || !engine) return undefined;
  return renderRunPersona(instance, employeeId, basis, engine);
}

/** Resolve only immutable frozen versions and the already-frozen profile.
 * Current assignment/default/profile edits must not re-render this Run. */
export async function assertFrozenEmployeePersona(
  sql: Sql,
  snapshot: Extract<EmployeeExecutionSnapshot, { schemaVersion: 2 }>,
  prompt: {
    systemPrompt: string;
    employeeDocuments?: EmployeeDocuments;
    personalIdentity?: unknown;
  },
  run: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    assignmentId: string;
    employeeVersionId: string;
  },
) {
  const pin = EmployeePersonaPinSchema.parse(snapshot.persona);
  const instance = snapshot.instance;
  const source = pin.source;
  if (
    !instance ||
    source.organizationId !== run.organizationId ||
    source.workspaceId !== run.workspaceId ||
    source.ownerId !== run.ownerId ||
    source.assignmentId !== run.assignmentId ||
    source.engine.employeeVersionId !== run.employeeVersionId ||
    source.instanceId !== instance.id ||
    source.assignmentId !== instance.assignmentId ||
    source.assignmentId !== snapshot.assignment.id ||
    source.ownerId !== instance.ownerId ||
    source.organizationId !== instance.organizationId ||
    source.workspaceId !== instance.workspaceId ||
    source.profileRevision !== instance.revision ||
    source.employeeId !== snapshot.employee.id ||
    source.engine.employeeVersionId !== snapshot.employee.versionId ||
    source.engine.configChecksum !== snapshot.employee.definitionChecksum ||
    source.engine.employeeVersionId !== instance.source.employeeVersionId ||
    source.organizationId !== snapshot.tenantContext.organizationId ||
    source.workspaceId !== snapshot.tenantContext.workspaceId ||
    source.ownerId !== snapshot.tenantContext.actorId ||
    source.ownerId !== snapshot.assignment.userId ||
    prompt.personalIdentity !== undefined
  )
    throw Error('employee_persona_snapshot_invalid');
  const scope = {
    organizationId: instance.organizationId,
    workspaceId: instance.workspaceId,
    employeeId: snapshot.employee.id,
  };
  const basis = await readEmployeePersonaVersion(
    { ...scope, role: 'basis', versionId: source.basis.employeeVersionId },
    sql,
  );
  const engine = await readEmployeePersonaVersion(
    {
      ...scope,
      role: 'engine',
      versionId: source.engine.employeeVersionId,
      expectedSource: instance.source,
    },
    sql,
  );
  if (!basis || !engine) throw Error('employee_persona_source_unavailable');
  const expected = renderRunPersona(
    instance,
    snapshot.employee.id,
    basis,
    engine,
  );
  if (
    runtimePolicyDigest(expected.pin) !== runtimePolicyDigest(pin) ||
    runtimePolicyDigest(snapshot.employee.definition) !==
      source.engine.manifestDigest ||
    prompt.employeeDocuments?.persona !== expected.persona ||
    prompt.systemPrompt !== expected.systemPrompt
  )
    throw Error('employee_persona_snapshot_invalid');
}

/** Stable locator, not a capability. Every read must find an issued pin in the
 * current Run and recheck current organization/owner/instance/confirmation. */
export function confirmedMemoryHandle(item: MemoryContextItem) {
  return `experience:${runtimePolicyDigest({
    id: item.id,
    revision: item.revision,
    content: item.content,
  })}`;
}

export function employeeMemoryDocument(
  items: readonly MemoryContextItem[],
  total: number,
) {
  return renderEmployeeMemoryDocument(
    items,
    total,
    runtimePolicyDigest({ items, eligibleCount: total }),
  );
}

/** Called only after the ordinary chat admission's current principal/instance
 * gate, in its existing binding transaction. No query or vector ranking. */
export async function freezeEmployeeDocuments(
  sql: ReturnType<typeof getDatabase> | TransactionSql,
  scope: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    instanceId: string;
  },
  facts: EmployeeUserFacts,
  sourceTool: boolean,
  personaInput?: { instance: EmployeeInstanceSnapshot; employeeId: string },
) {
  const persona = personaInput
    ? await freezeRunPersona(
        sql,
        personaInput.instance,
        personaInput.employeeId,
      )
    : undefined;
  const rows = await sql<{ id: string; revision: number; content: string }[]>`
    select m.id,m.revision,m.content from allrice_memories m
    where ${employeeMemoryReadPredicate(sql, scope)}
    order by case when jsonb_typeof(m.metadata->'memoryPinOrder')='number'
      then (m.metadata->>'memoryPinOrder')::numeric end asc nulls last,
      m.updated_at desc,m.id`;
  const selected = selectEmployeeDocumentMemories(
    rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      content: row.content,
      sourceHandle: confirmedMemoryHandle(row),
    })),
    rows.length,
  );
  // Selection reserves locator bytes even without the tool, so the owner's
  // default preview selects exactly the same IDs. Never advertise an unusable
  // handle; the ledger charges the actual smaller document when stripped.
  const memories: MemoryContextItem[] = selected.map((item) =>
    sourceTool
      ? item
      : {
          id: item.id,
          revision: item.revision,
          content: item.content,
        },
  );
  const user = selectEmployeeUserFacts(facts);
  return {
    eligibleCount: rows.length,
    memories,
    ...(persona
      ? { persona: persona.pin, systemPrompt: persona.systemPrompt }
      : {}),
    employeeDocuments: {
      ...(persona ? { persona: persona.persona } : {}),
      user: renderEmployeeUserDocument(
        user.facts,
        user.omitted,
        runtimePolicyDigest(user),
      ),
      memory: employeeMemoryDocument(memories, rows.length),
    },
  };
}
