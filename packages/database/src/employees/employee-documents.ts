import type { TransactionSql } from 'postgres';
import {
  selectEmployeeDocumentMemories,
  selectEmployeeUserFacts,
  renderEmployeeMemoryDocument,
  renderEmployeeUserDocument,
  renderEmployeePersonaDocument,
  EmployeePersonaPinSchema,
  EmployeeRunPersonaSourceSchema,
  EmployeePersonaTaskSchema,
  isBaseRiceInstanceDefinition,
  type EmployeeInstanceSnapshot,
  type EmployeeExecutionSnapshot,
  type EmployeeDocuments,
  type EmployeeUserFacts,
  type MemoryContextItem,
  type EmployeePersonaTask,
} from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import { employeeMemoryReadPredicate } from '../workspace/employee-memory-read.ts';
import {
  getEmployeeInstance,
  readEmployeePersonaVersion,
} from './employee-instances.ts';
import { employeePersonaSourceSystemPrompt } from '../platform-employees/runtime-package.ts';

type Sql = ReturnType<typeof getDatabase> | TransactionSql;
type PersonaVersion = NonNullable<
  Awaited<ReturnType<typeof readEmployeePersonaVersion>>
>;
function personaEligibility(
  instance: EmployeeInstanceSnapshot,
  engine: PersonaVersion,
) {
  return instance.kind === 'custom' ||
    ('platformKey' in engine &&
      engine.platformKey === 'rice' &&
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
  task?: EmployeePersonaTask,
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
    ...(task ? { task } : {}),
  });
  const persona = renderEmployeePersonaDocument(
    basis.material.foundation,
    source,
    instance.profile,
  );
  const systemPrompt = employeePersonaSourceSystemPrompt(engine.material);
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

/** Shared identity projection; it grants no human facts or memory eligibility.
 * A legitimate absent source is unmigrated; validation errors never fall back. */
async function freezeRunPersona(
  sql: Sql,
  instance: EmployeeInstanceSnapshot,
  employeeId: string,
  task?: EmployeePersonaTask,
) {
  const scope = {
    organizationId: instance.organizationId,
    workspaceId: instance.workspaceId,
    employeeId,
    forRunInput: true,
  };
  const current = task
    ? undefined
    : await getEmployeeInstance(
        {
          actor: { type: 'user', id: instance.ownerId },
          organizationId: instance.organizationId,
          workspaceId: instance.workspaceId,
        },
        instance.id,
        sql,
      );
  const basis = current
    ? await readEmployeePersonaVersion(
        {
          ...scope,
          role: 'basis',
          versionId: current.source.employeeVersionId,
          expectedSource: current.source,
        },
        sql,
      )
    : undefined;
  const engine = await readEmployeePersonaVersion(
    {
      ...scope,
      role: 'engine',
      versionId: instance.source.employeeVersionId,
      expectedSource: instance.source,
    },
    sql,
  );
  // Only exact historical material absence retains the unmigrated path.
  // New definition-only versions prove their own immutable tenant source.
  if (!engine || (!task && !basis)) return undefined;
  return renderRunPersona(
    instance,
    employeeId,
    task ? engine : basis!,
    engine,
    task,
  );
}

/** Reuse verified identity without querying owner memories. Scheduled producers
 * may carry only their existing organizational facts; repair/review stay empty. */
export async function freezeEmployeePersonaDocuments(
  sql: Sql,
  instance: EmployeeInstanceSnapshot,
  employeeId: string,
  task?: EmployeePersonaTask,
  facts: EmployeeUserFacts = {},
) {
  const projection = await freezeRunPersona(
    sql,
    instance,
    employeeId,
    task ? EmployeePersonaTaskSchema.parse(task) : undefined,
  );
  if (!projection) return undefined;
  // Internal recall already chose its facts and memories; never use the human
  // document query to widen that set. Department was not in its old input.
  const existingFacts = { ...facts };
  delete existingFacts.departmentName;
  const user = selectEmployeeUserFacts(task ? existingFacts : {});
  return {
    persona: projection.pin,
    systemPrompt: projection.systemPrompt,
    memories: [],
    employeeDocuments: {
      persona: projection.persona,
      user: renderEmployeeUserDocument(
        user.facts,
        user.omitted,
        runtimePolicyDigest(user),
      ),
      memory: '',
    },
  };
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
    sessionId?: string;
    userMessageId?: string;
  },
  evidence?:
    | { phase: 'enqueue'; task?: EmployeePersonaTask }
    | { phase: 'resolve'; runId: string },
) {
  const pin = EmployeePersonaPinSchema.parse(snapshot.persona);
  const instance = snapshot.instance;
  const source = pin.source;
  if (source.task) {
    if (
      source.task.sessionId !== run.sessionId ||
      source.task.userMessageId !== run.userMessageId ||
      !evidence
    )
      throw Error('employee_persona_snapshot_invalid');
    if (evidence.phase === 'enqueue') {
      if (
        !evidence.task ||
        runtimePolicyDigest(source.task) !== runtimePolicyDigest(evidence.task)
      )
        throw Error('employee_persona_snapshot_invalid');
    } else {
      const task = source.task;
      const [producer] =
        task.kind === 'folder_event'
          ? await sql`select 1 from allrice_automation_folder_events e
          join allrice_employee_runs er on er.run_id=${evidence.runId}
          join allrice_messages m on m.id=er.user_message_id and m.session_id=er.session_id
          where e.id=${task.id} and e.organization_id=${run.organizationId}
            and e.workspace_id=${run.workspaceId} and e.owner_id=${run.ownerId}
            and e.reserved_session_id=${task.sessionId} and e.session_id=${task.sessionId}
            and (e.run_id is null or e.run_id=er.run_id)
            and er.session_id=${task.sessionId} and m.id=${task.userMessageId}
            and m.client_message_id=e.id and m.role='user'
            and er.organization_id=e.organization_id and er.workspace_id=e.workspace_id
            and er.owner_id=e.owner_id and m.organization_id=er.organization_id
            and m.workspace_id=er.workspace_id and m.owner_id=er.owner_id`
          : await sql`select 1 from allrice_automation_runs a
          join allrice_employee_runs er on er.run_id=a.run_id
          join allrice_messages m on m.id=er.user_message_id and m.session_id=er.session_id
          where a.run_id=${evidence.runId} and a.organization_id=${run.organizationId}
            and a.workspace_id=${run.workspaceId} and er.owner_id=${run.ownerId}
            and a.session_id=${task.sessionId} and er.session_id=a.session_id
            and m.id=${task.userMessageId} and m.role='user'
            and er.organization_id=a.organization_id and er.workspace_id=a.workspace_id
            and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id
            and m.owner_id=er.owner_id
            and ${
              task.kind === 'native_once'
                ? sql`a.native_once_occurrence_id=${task.id}`
                : task.kind === 'native_recurring'
                  ? sql`a.native_recurring_occurrence_id=${task.id}`
                  : sql`a.id=${task.id} and m.client_message_id=a.id
                    and a.manual_request_id is not null and a.manual_source='user'`
            }`;
      if (!producer) throw Error('employee_persona_source_unavailable');
    }
  }
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
  const basis = source.task
    ? undefined
    : await readEmployeePersonaVersion(
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
  if (!engine || (!source.task && !basis))
    throw Error('employee_persona_source_unavailable');
  const expected = renderRunPersona(
    instance,
    snapshot.employee.id,
    source.task ? engine : basis!,
    engine,
    source.task,
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
