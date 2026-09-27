import { randomUUID } from 'node:crypto';
import {
  SessionModelSnapshotSchema,
  resolveImageModel,
  withPlatformImageTools,
  type ExecutionContext,
  type ImageToolInput,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { runtimeLedgerInputDigest } from './runtime-ledger/ledger.ts';
import { requirePlatformAdmin } from './platform-authority.ts';

/** Both tenant scope and the frozen Run determine image authority. Never read
 * current platform defaults here: an admin update cannot change an active Run. */
export async function imageRunConfiguration(
  context: ExecutionContext,
  sessionId: string,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const [run] = await getDatabase()<
    { snapshot: unknown; tools: string[]; capabilities: string[] }[]
  >`
    select execution_snapshot->'modelSnapshot' as snapshot,
      execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' as tools,
      execution_snapshot->'capabilitySnapshot'->'grantedCapabilities' as capabilities
    from allrice_employee_runs
    where run_id=${context.runId} and organization_id=${context.organizationId}
      and workspace_id=${context.workspaceId} and session_id=${sessionId}
      and owner_id=${context.policySnapshot.subjectId}`;
  const snapshot = SessionModelSnapshotSchema.safeParse(run?.snapshot);
  if (
    !snapshot.success ||
    !snapshot.data.platformSettings ||
    !withPlatformImageTools(
      run?.tools ?? [],
      run?.capabilities ?? [],
      snapshot.data,
    ).includes('image.generate')
  )
    throw new DataAccessError('authorization_denied');
  return snapshot.data.platformSettings.configuration;
}

export async function claimImageOperation(input: {
  context: ExecutionContext;
  sessionId: string;
  callId: string;
  arguments: ImageToolInput;
  leaseToken: string;
}) {
  const { context } = input;
  const frozen = await imageRunConfiguration(context, input.sessionId);
  const configuration = {
    ...frozen,
    imageModel: resolveImageModel(frozen, input.arguments),
  };
  const digest = runtimeLedgerInputDigest({
    prompt: input.arguments.prompt,
    source: input.arguments.source ?? null,
    workModel: configuration.workModel,
    imageModel: configuration.imageModel,
  });
  const db = getDatabase();
  return db.begin(async (tx) => {
    const [job] =
      await tx`select id from allrice_jobs where id=${context.jobId} and run_id=${context.runId}
      and organization_id=${context.organizationId} and worker_id=${context.worker.id}
      and lease_token::text=${input.leaseToken} and status='running' and lease_expires_at>clock_timestamp()
      and timeout_at>clock_timestamp() and cancel_requested_at is null for share`;
    if (!job) throw new DataAccessError('authorization_denied');
    await tx`select pg_advisory_xact_lock(hashtextextended(${`image:${context.runId}`},0))`;
    const [existing] = await tx<
      { id: string; input_digest: string; status: string; result: unknown }[]
    >`
      select id,input_digest,status,result from allrice_image_operations where run_id=${context.runId}
        and (call_id=${input.callId} or input_digest=${digest})`;
    if (existing) {
      if (existing.input_digest !== digest)
        throw new DataAccessError('grant_invalid');
      return {
        id: existing.id,
        execute: false,
        status: existing.status,
        result: existing.result,
        configuration,
      };
    }
    const id = randomUUID();
    await tx`insert into allrice_image_operations(id,organization_id,workspace_id,owner_id,run_id,session_id,call_id,input_digest,operation,work_model,image_model,source_object_id,source_checksum,status)
      values (${id},${context.organizationId},${context.workspaceId!},${context.policySnapshot.subjectId},${context.runId},${input.sessionId},${input.callId},${digest},
        ${input.arguments.source ? 'edit' : 'generate'},${configuration.workModel},${configuration.imageModel},${input.arguments.source?.objectId ?? null},${input.arguments.source?.checksum ?? null},'running')`;
    return {
      id,
      execute: true,
      status: 'running',
      result: null,
      configuration,
    };
  });
}

export async function recordImageReceipt(input: {
  context: ExecutionContext;
  operationId: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number | null;
    outputTokens: number;
  } | null;
  requestId: string | null;
}) {
  await getDatabase()`update allrice_image_operations set usage=${input.usage ? getDatabase().json(input.usage) : null},provider_request_id=${input.requestId}
    where id=${input.operationId} and run_id=${input.context.runId} and organization_id=${input.context.organizationId} and workspace_id=${input.context.workspaceId!} and status='running'`;
}

export async function finishImageOperation(input: {
  context: ExecutionContext;
  operationId: string;
  status: 'succeeded' | 'failed' | 'unknown';
  result?: { modelContent: string; summary: string; itemCount?: number };
  errorCode?: string;
}) {
  const db = getDatabase();
  await db`update allrice_image_operations set status=${input.status},result=${input.result ? db.json(input.result) : null},error_code=${input.errorCode ?? null},completed_at=now()
    where id=${input.operationId} and run_id=${input.context.runId} and organization_id=${input.context.organizationId} and workspace_id=${input.context.workspaceId!} and status='running'`;
}

export async function listImageOperations(context: RequestContext) {
  await requirePlatformAdmin(context);
  return getDatabase()`select i.id,i.operation,case when i.status='running' and not exists (select 1 from allrice_jobs j where j.run_id=i.run_id and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp()) then 'unknown' else i.status end as status,i.work_model as "workModel",i.image_model as "imageModel",i.usage,
    i.error_code as "errorCode",i.created_at as "createdAt",i.completed_at as "completedAt",o.name as "organizationName",i.run_id as "runId"
    from allrice_image_operations i join allrice_organizations o on o.id=i.organization_id order by i.created_at desc limit 50`;
}
