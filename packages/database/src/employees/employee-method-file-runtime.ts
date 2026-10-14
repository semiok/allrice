import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  CloudCommandSchema,
  CloudExecutionProfileSchema,
  RuntimePolicyControlsSchema,
  WorkAutomationSchema,
  defaultWorkAutomation,
  runtimePolicyActionDecision,
  employeeMethodFileCase,
  EmployeeMethodFileStepSchema,
  EmployeeMethodFileAssertionSchema,
  evaluateEmployeeMethodFileOutput,
  runtimeContractEqual,
  runtimeFeatureEnabled,
  StorageObjectSchema,
  type ExecutionContext,
  type RequestContext,
  type CloudCommand,
  type EmployeeMethodFileStage,
  type RuntimeActionBinding,
  type StoragePort,
} from '@allrice/contracts';
import {
  DataAccessError,
  createStorageMetadata,
  markStorageReady,
} from '../data.ts';
import { lockWorkspaceStorageQuota } from '../core/storage-quota.ts';
import { getDatabase } from '../core/client.ts';
import {
  runtimePolicyDigest as digest,
  RuntimePolicyError,
} from '../runtime-policy.ts';
import {
  assertEmployeeMethodFileExecution,
  type EmployeeMethodTestBinding,
} from './employee-method-tests.ts';

type Identity = Pick<
  RequestContext,
  'organizationId' | 'workspaceId' | 'actor'
>;
type Step = {
  test_id: string;
  stage: EmployeeMethodFileStage;
  operation_id: string;
  payload: unknown;
  payload_digest: string;
  verdict: unknown | null;
  output_object_id: string | null;
  output_version_id: string | null;
};

/** Preflight reads do not acquire the runtime control lock after the content
 * lock. Actual operation admission takes the existing locks and checks again. */
export async function freezeMethodFileEnvironment(
  tx: TransactionSql,
  scope: Identity,
) {
  if (
    !runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED') ||
    !runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED')
  )
    throw new DataAccessError('authorization_denied');
  const [policy] = await tx`select controls from allrice_runtime_policy_controls
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}`;
  const [automation] =
    await tx`select settings from allrice_member_work_automation
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and user_id=${scope.actor.id}`;
  const controls = RuntimePolicyControlsSchema.safeParse(policy?.controls);
  if (
    !controls.success ||
    runtimePolicyActionDecision(
      controls.data,
      'cloud.process.execute',
      [],
      automation
        ? WorkAutomationSchema.parse(automation.settings)
        : defaultWorkAutomation,
    ).effect !== 'allow'
  )
    throw new DataAccessError('authorization_denied');
  const [grant] = await tx<
    { id: string; version: number; target_id: string; profile: unknown }[]
  >`
    select g.id,g.version,g.target_id,g.profile from allrice_cloud_execution_grants g
    join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
    where g.organization_id=${scope.organizationId} and g.workspace_id=${scope.workspaceId} and g.owner_id=${scope.actor.id}
      and g.enabled and g.revoked_at is null and t.kind='cloud_sandbox' and t.state='online'
      and t.capabilities ? 'process.execute'
      and (t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())
    order by g.created_at desc limit 1`;
  if (!grant) throw new DataAccessError('authorization_denied');
  return {
    manifest: employeeMethodFileCase,
    grant: {
      ...grant,
      profile: CloudExecutionProfileSchema.parse(grant.profile),
    },
  };
}

function failed(
  reason: 'wrong_stage' | 'invalid_output' | 'amount_mismatch',
  actual: number | null = null,
) {
  return EmployeeMethodFileAssertionSchema.parse({
    id: 'file-flow-cny-total',
    expected: 30000,
    actual,
    passed: false,
    reason,
  });
}
async function latchFailure(
  tx: TransactionSql,
  b: EmployeeMethodTestBinding,
  verdict: ReturnType<typeof failed>,
) {
  // The first observed business failure is never erased by a later successful
  // tool, cancellation, model failure or final answer.
  await tx`update allrice_employee_method_tests set assertion=${tx.json(verdict)}
    where test_id=${b.test_id} and (assertion is null or assertion->>'passed'='true' or assertion->>'reason'='execution_failed')`;
}

export async function currentMethodFileGrant(
  tx: TransactionSql,
  b: EmployeeMethodTestBinding,
  requireOnline = true,
) {
  const frozen = b.candidate_snapshot.fileEnvironment!.grant;
  const [g] = await tx`select g.id from allrice_cloud_execution_grants g
    join allrice_execution_targets t on t.id=g.target_id and t.organization_id=g.organization_id and t.workspace_id=g.workspace_id
    where g.id=${frozen.id} and g.owner_id=${b.owner_id} and g.organization_id=${b.organization_id} and g.workspace_id=${b.workspace_id}
      and g.version=${frozen.version} and g.profile=${tx.json(frozen.profile)} and g.target_id=${frozen.target_id}
      and g.enabled and g.revoked_at is null and t.kind='cloud_sandbox'
      and (not ${requireOnline} or t.state='online') and t.state<>'revoked'
      and t.capabilities ? 'process.execute'
      and (not ${requireOnline} or t.metadata->>'healthManaged' is distinct from 'true' or t.last_heartbeat_at between clock_timestamp()-interval '120 seconds' and clock_timestamp())`;
  if (!g) throw new RuntimePolicyError('cloud_grant_unavailable');
  return frozen;
}

/** Model supplies only a stage and script. Fixed files/limits never come from
 * tool arguments. Commit a wrong-order verdict before returning the error. */
export async function prepareMethodFileStep(
  input: {
    context: ExecutionContext;
    arguments: unknown;
    operationId: string;
    leaseToken: string;
    jobAttempt: number;
    storage: StoragePort;
  },
  database = getDatabase(),
) {
  const args = EmployeeMethodFileStepSchema.parse(input.arguments);
  const result = await database.begin(async (tx) => {
    await lockWorkspaceStorageQuota(
      tx,
      input.context.organizationId,
      input.context.workspaceId!,
    );
    const { b, run } = await assertEmployeeMethodFileExecution(
      tx,
      input.context,
    );
    if (
      run.lease_token !== input.leaseToken ||
      run.attempt !== input.jobAttempt
    )
      throw new RuntimePolicyError('cloud_worker_lease_changed');
    const grant = await currentMethodFileGrant(tx, b);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`method-file:${b.test_id}`},0))`;
    const [latest] =
      await tx`select assertion from allrice_employee_method_tests where test_id=${b.test_id}`;
    if (
      latest?.assertion &&
      EmployeeMethodFileAssertionSchema.parse(latest.assertion).passed === false
    )
      return { error: 'method_test_already_failed' } as const;
    const [existing] = await tx<
      Step[]
    >`select * from allrice_employee_method_file_steps where test_id=${b.test_id} and stage=${args.stage}`;
    if (existing) {
      const payload = CloudCommandSchema.parse(existing.payload);
      if (
        payload.arguments.script !== args.script ||
        digest(payload) !== existing.payload_digest ||
        existing.operation_id !== input.operationId
      )
        return { error: 'method_test_step_already_recorded' } as const;
      return { b, run, grant, payload };
    }
    const inputs: CloudCommand['arguments']['inputs'] = [];
    if (args.stage === 'normalize') {
      const object = await materializeFixture(
        tx,
        b,
        input.context,
        input.storage,
      );
      inputs.push({
        path: employeeMethodFileCase.input.path,
        objectId: object.id,
        checksum: object.checksum,
      });
    } else {
      const [previous] = await tx<
        Step[]
      >`select * from allrice_employee_method_file_steps where test_id=${b.test_id} and stage='normalize'`;
      if (
        !previous?.output_object_id ||
        !previous.output_version_id ||
        !EmployeeMethodFileAssertionSchema.safeParse(previous.verdict).data
          ?.passed
      ) {
        await latchFailure(tx, b, failed('wrong_stage'));
        return { error: 'method_test_wrong_stage' } as const;
      }
      const object = await readMethodFileObject(tx, b, previous);
      inputs.push({
        path: employeeMethodFileCase.outputs.normalize.path,
        objectId: object.id,
        checksum: object.checksum,
      });
    }
    const fixed = employeeMethodFileCase.runtime;
    const payload = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      backend: fixed.backend,
      imageDigest: fixed.imageDigest,
      runtime: fixed.runtime,
      network: fixed.network,
      arguments: {
        language: fixed.language,
        script: args.script,
        inputs,
        outputs: [employeeMethodFileCase.outputs[args.stage]],
        limits: fixed.limits,
      },
    });
    await tx`insert into allrice_employee_method_file_steps(test_id,stage,operation_id,payload,payload_digest)
      values(${b.test_id},${args.stage},${input.operationId},${tx.json(payload)},${digest(payload)})`;
    return { b, run, grant, payload };
  });
  if ('error' in result)
    throw new RuntimePolicyError(result.error ?? 'method_test_step_failed');
  return result;
}

/** Ordinary cloud operations return undefined. A method Run must match its
 * exact persisted stage; it may never fall through to ordinary file scope. */
export async function methodFileProof(
  tx: TransactionSql,
  context: Pick<
    ExecutionContext,
    'organizationId' | 'workspaceId' | 'runId' | 'jobId' | 'worker'
  > & {
    policySnapshot: Pick<
      ExecutionContext['policySnapshot'],
      'id' | 'subjectId'
    >;
  },
  payload: CloudCommand,
  operationId?: string,
  binding?: RuntimeActionBinding,
) {
  const [method] =
    await tx`select id from allrice_runs where id=${context.runId} and execution_spec ? 'employeeMethodSnapshotDigest'`;
  if (!method) return undefined;
  const { b, run } = await assertEmployeeMethodFileExecution(tx, context);
  const grant = await currentMethodFileGrant(tx, b);
  const [step] = await tx<
    Step[]
  >`select * from allrice_employee_method_file_steps
    where test_id=${b.test_id} and payload_digest=${digest(payload)}
      and (${operationId ?? null}::uuid is null or operation_id=${operationId ?? null}::uuid)`;
  if (
    !step ||
    !runtimeContractEqual(step.payload, payload) ||
    (binding &&
      (binding.task.chatSessionId !== null ||
        binding.task.rootRunId !== b.run_id ||
        binding.task.parentRunId !== null ||
        binding.attempt.generation !== 0 ||
        binding.execution.grantId !== grant.id ||
        binding.execution.grantVersion !== grant.version ||
        binding.task.frozenConfiguration.employeeVersionId !==
          b.employee_version_id))
  )
    throw new RuntimePolicyError('cloud_input_changed');
  // Recompute the complete envelope, not just the stored hash. No model may
  // insert another object, output, language, limit, image or outbound access.
  const inputs: CloudCommand['arguments']['inputs'] = [];
  if (step.stage === 'normalize') {
    const object = await readFixture(tx, b);
    inputs.push({
      path: employeeMethodFileCase.input.path,
      objectId: object.id,
      checksum: object.checksum,
    });
  } else {
    const [previous] = await tx<
      Step[]
    >`select * from allrice_employee_method_file_steps where test_id=${b.test_id} and stage='normalize'`;
    if (
      !previous ||
      !EmployeeMethodFileAssertionSchema.safeParse(previous.verdict).data
        ?.passed
    )
      throw new RuntimePolicyError('cloud_input_changed');
    const object = await readMethodFileObject(tx, b, previous);
    inputs.push({
      path: employeeMethodFileCase.outputs.normalize.path,
      objectId: object.id,
      checksum: object.checksum,
    });
  }
  const fixed = employeeMethodFileCase.runtime;
  const expected = CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    backend: fixed.backend,
    imageDigest: fixed.imageDigest,
    runtime: fixed.runtime,
    network: fixed.network,
    arguments: {
      script: payload.arguments.script,
      language: fixed.language,
      inputs,
      outputs: [employeeMethodFileCase.outputs[step.stage]],
      limits: fixed.limits,
    },
  });
  if (!runtimeContractEqual(expected, payload))
    throw new RuntimePolicyError('cloud_input_changed');
  return { b, run, step };
}

async function readMethodFileObject(
  tx: TransactionSql,
  b: EmployeeMethodTestBinding,
  step: Step,
) {
  const [row] = await tx`select o.* from allrice_storage_objects o
    join allrice_deliverable_versions v on v.id=${step.output_version_id} and v.object_id=o.id
      and v.platform_test_run_id=${b.test_id} and v.session_id is null
    join allrice_workbench_artifacts a on a.version_id=v.id and a.run_id=${b.run_id}
    where o.id=${step.output_object_id} and o.organization_id=${b.organization_id} and o.workspace_id=${b.workspace_id}
      and o.owner_id=${b.owner_id} and o.visibility='private' and o.immutable and o.state='ready' and o.deleted_at is null for share of o`;
  if (!row) throw new RuntimePolicyError('cloud_input_not_authorized');
  return StorageObjectSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    key: row.object_key,
    checksum: row.checksum,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    retentionUntil: row.retention_until?.toISOString() ?? null,
    deletedAt: null,
    immutable: true,
  });
}

export async function methodFileInputs(
  tx: TransactionSql,
  proof: NonNullable<Awaited<ReturnType<typeof methodFileProof>>>,
) {
  if (proof.step.stage === 'normalize') {
    return { object: await readFixture(tx, proof.b) };
  }
  const [previous] = await tx<
    Step[]
  >`select * from allrice_employee_method_file_steps where test_id=${proof.b.test_id} and stage='normalize'`;
  if (!previous) throw new RuntimePolicyError('cloud_input_not_authorized');
  return { object: await readMethodFileObject(tx, proof.b, previous) };
}

export async function recordMethodFilePublication(
  tx: TransactionSql,
  proof: NonNullable<Awaited<ReturnType<typeof methodFileProof>>>,
  artifact: { object: { id: string; checksum: string }; versionId: string },
  bytes: Uint8Array,
) {
  if (
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
    artifact.object.checksum
  )
    throw new RuntimePolicyError('cloud_artifact_invalid');
  const checked = evaluateEmployeeMethodFileOutput(
    proof.step.stage,
    Buffer.from(bytes).toString('utf8'),
  );
  const verdict = EmployeeMethodFileAssertionSchema.parse({
    ...checked,
    id: 'file-flow-cny-total',
    expected: 30000,
  });
  await tx`update allrice_employee_method_file_steps set output_object_id=${artifact.object.id},
    output_version_id=${artifact.versionId},verdict=${tx.json(verdict)}
    where test_id=${proof.b.test_id} and stage=${proof.step.stage} and output_object_id is null`;
  if (!verdict.passed) await latchFailure(tx, proof.b, verdict);
  else if (proof.step.stage === 'summarize')
    await tx`update allrice_employee_method_tests set assertion=${tx.json(verdict)} where test_id=${proof.b.test_id} and assertion is null`;
}

/** Additional exact proof for the existing artifact publisher; never changes
 * ordinary platform-template revision status requirements. */
export async function assertMethodFilePublication(
  tx: TransactionSql,
  context: ExecutionContext,
  testId: string,
  operationId: string,
  objectId: string,
) {
  const [stored] =
    await tx`select i.payload,a.outcome from allrice_cloud_execution_inputs i
    join allrice_cloud_execution_attempts a on a.operation_id=i.operation_id where i.operation_id=${operationId}`;
  if (
    !stored ||
    stored.outcome?.reason !== 'completed' ||
    !stored.outcome?.stopped
  )
    throw new DataAccessError('authorization_denied');
  const proof = await methodFileProof(
    tx,
    context,
    CloudCommandSchema.parse(stored.payload),
    operationId,
  );
  const h = createHash('sha256')
    .update(
      `${operationId}:artifact:${employeeMethodFileCase.outputs[proof?.step.stage ?? 'normalize'].path}`,
    )
    .digest('hex');
  const expectedId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  if (!proof || proof.b.test_id !== testId || objectId !== expectedId)
    throw new DataAccessError('authorization_denied');
}

function fixtureIdentity(b: EmployeeMethodTestBinding) {
  const h = createHash('sha256')
    .update(`method-file-input:${b.test_id}`)
    .digest('hex');
  return {
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
    checksum: `sha256:${createHash('sha256').update(employeeMethodFileCase.input.text).digest('hex')}`,
  };
}
async function readFixture(tx: TransactionSql, b: EmployeeMethodTestBinding) {
  const expected = fixtureIdentity(b);
  const [row] =
    await tx`select * from allrice_storage_objects where id=${expected.id}
    and organization_id=${b.organization_id} and workspace_id=${b.workspace_id} and owner_id=${b.owner_id}
    and visibility='private' and immutable and state='ready' and deleted_at is null
    and checksum=${expected.checksum} and size_bytes=${Buffer.byteLength(employeeMethodFileCase.input.text)} for share`;
  if (!row) throw new RuntimePolicyError('cloud_input_changed');
  return StorageObjectSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    key: row.object_key,
    checksum: row.checksum,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    retentionUntil: row.retention_until?.toISOString() ?? null,
    deletedAt: null,
    immutable: true,
  });
}
async function materializeFixture(
  tx: TransactionSql,
  b: EmployeeMethodTestBinding,
  context: ExecutionContext,
  storage: StoragePort,
) {
  const expected = fixtureIdentity(b);
  const [existing] =
    await tx`select id from allrice_storage_objects where id=${expected.id}`;
  if (existing) return readFixture(tx, b);
  const principal = {
    organizationId: b.organization_id,
    workspaceId: b.workspace_id,
    actor: { type: 'user' as const, id: b.owner_id },
    requestId: b.test_id,
    memberships: context.policySnapshot.memberships,
  };
  const file = await createStorageMetadata(
    principal,
    {
      ...expected,
      workspaceId: b.workspace_id,
      category: 'artifacts',
      mediaType: employeeMethodFileCase.input.mediaType,
      sizeBytes: Buffer.byteLength(employeeMethodFileCase.input.text),
      visibility: 'private',
      retentionUntil: null,
      immutable: true,
    },
    tx,
  );
  await storage.put(
    file.object,
    new Blob([employeeMethodFileCase.input.text]).stream(),
  );
  await assertEmployeeMethodFileExecution(tx, context);
  await markStorageReady(principal, file.object.id, tx);
  return readFixture(tx, b);
}

/** Only the first caller may enter the executor. An active duplicate is a
 * read, not recovery: recovery would stop its still-running physical command. */
export async function claimMethodFileExecution(
  context: ExecutionContext,
  operationId: string,
  database = getDatabase(),
) {
  return database.begin(async (tx) => {
    const [step] = await tx<
      Step[]
    >`select * from allrice_employee_method_file_steps where operation_id=${operationId}`;
    if (!step) throw new DataAccessError('authorization_denied');
    const proof = await methodFileProof(
      tx,
      context,
      CloudCommandSchema.parse(step.payload),
      operationId,
    );
    if (!proof) throw new DataAccessError('authorization_denied');
    const claimed =
      await tx`update allrice_employee_method_file_steps set execution_started_at=clock_timestamp()
      where operation_id=${operationId} and execution_started_at is null returning operation_id`;
    return claimed.length === 1;
  });
}

export async function methodFileExecutionUnverified(
  context: ExecutionContext,
  testId: string,
  database = getDatabase(),
) {
  const rows =
    await database`select s.operation_id from allrice_employee_method_file_steps s
    join allrice_employee_method_tests m on m.test_id=s.test_id
    left join allrice_cloud_execution_attempts a on a.operation_id=s.operation_id
    where m.test_id=${testId} and m.run_id=${context.runId} and m.organization_id=${context.organizationId}
      and m.workspace_id=${context.workspaceId} and m.owner_id=${context.policySnapshot.subjectId}
      and (s.execution_started_at is null or a.outcome is null or a.outcome->>'reason'<>'completed' or a.outcome->>'stopped' is distinct from 'true')`;
  return rows.length > 0;
}
