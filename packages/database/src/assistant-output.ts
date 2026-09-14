import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ExecutionContextSchema,
  RuntimeTaskRefSchema,
  type ExecutionContext,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import type { AssistantWorkerLease } from './assistant-runtime.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { runtimeLedgerInputDigest } from './runtime-ledger/ledger.ts';
import { readArtifact, readArtifactBytes } from './artifact-review.ts';

const outputSchema = z
  .object({
    name: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u),
    content: z.string().min(1).max(131072),
  })
  .strict();
const workerSchema = z
  .object({
    jobId: z.uuid(),
    workerId: z.uuid(),
    leaseToken: z.uuid(),
    generation: z.number().int().nonnegative(),
    fence: z.number().int().positive().optional(),
  })
  .strict();
function fail(): never {
  throw Error('assistant_output_denied');
}

/** Internal report publication, not a public upload or general filesystem tool.
 * A saved model output is NOT proof that its facts or external actions are true.
 * Caller supplies the existing StoragePort; no credential/config discovery here.
 */
export async function publishAssistantOutput(
  input: {
    context: ExecutionContext;
    assistant: { runId: string; worker: AssistantWorkerLease };
    deliveryId: string;
    output: { name: string; content: string };
  },
  options: { storage: StoragePort; database?: ReturnType<typeof getDatabase> },
) {
  const context = ExecutionContextSchema.parse(input.context);
  const worker = workerSchema.parse(input.assistant.worker);
  const childRunId = z.uuid().parse(input.assistant.runId);
  const deliveryId = z.uuid().parse(input.deliveryId);
  const output = outputSchema.parse(input.output);
  if (
    process.env.ALLRICE_WORKBENCH_ENABLED !== '1' ||
    !context.workspaceId ||
    context.delegatedBy.type !== 'user' ||
    context.policySnapshot.subjectId !== context.delegatedBy.id ||
    context.policySnapshot.organizationId !== context.organizationId ||
    context.jobId !== worker.jobId ||
    context.worker.id !== worker.workerId ||
    childRunId === context.runId ||
    Buffer.byteLength(output.content, 'utf8') > 131072
  )
    fail();
  const db = options.database ?? getDatabase();
  const bytes = Buffer.from(
    JSON.stringify(
      {
        version: 1,
        kind: 'assistant_generated',
        independentlyVerified: false,
        rootRunId: context.runId,
        childRunId,
        deliveryId,
        name: output.name,
        content: output.content,
      },
      null,
      2,
    ),
  );
  const checksum =
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const requestId = `assistant-output:${deliveryId}`;
  const requestDigest = runtimePolicyDigest({ childRunId, deliveryId, output });
  const relativePath = `outputs/${deliveryId}/${output.name}.json`;
  let created: StorageObject | undefined;
  let bodyCompleted = false;
  let writeSettled = false;
  try {
    return await db.begin(async (tx) => {
      // All storage increments take quota BEFORE root/identity/session locks.
      await lockWorkspaceStorageQuota(
        tx,
        context.organizationId,
        context.workspaceId,
      );
      const [root] = await tx`
        select r.root_run_id from allrice_runtime_roots r
        where r.root_run_id=${context.runId} and r.organization_id=${context.organizationId}
          and r.workspace_id=${context.workspaceId!} for update`;
      if (!root) fail();
      const [authorityRoot] =
        await tx`select root_run_id from allrice_assistant_roots where root_run_id=${context.runId} for update`;
      const [child] =
        await tx`select run_id from allrice_assistant_instances where run_id=${childRunId} and root_run_id=${context.runId} for update`;
      if (!authorityRoot || !child) fail();
      async function admit() {
        if (process.env.ALLRICE_WORKBENCH_ENABLED !== '1') fail();
        const lineage = await tx<
          {
            status: string;
            cancel_requested_at: Date | null;
            run_id: string;
            allowed_tools: string[];
          }[]
        >`
          with recursive ancestors as (
            select * from allrice_assistant_instances where run_id=${childRunId} and root_run_id=${context.runId}
            union all select p.* from allrice_assistant_instances p join ancestors c on c.parent_run_id=p.run_id
              where p.root_run_id=${context.runId}
          ) select run_id,status,cancel_requested_at,allowed_tools from ancestors`;
        if (
          !lineage.some((row) => row.run_id === context.runId) ||
          !lineage
            .find((row) => row.run_id === childRunId)
            ?.allowed_tools.includes('assistant.report') ||
          lineage.some(
            (row) =>
              row.cancel_requested_at ||
              [
                'completed',
                'partial',
                'failed',
                'canceled',
                'cancel_requested',
                'unknown',
              ].includes(row.status),
          )
        )
          fail();
        const [row] = await tx<{ task: unknown; session_id: string }[]>`
          select l.task,e.session_id from allrice_assistant_roots a
          join allrice_runtime_run_links l on l.root_run_id=a.root_run_id and l.run_id=${childRunId}
          join allrice_runs r on r.id=a.root_run_id and r.organization_id=l.organization_id and r.workspace_id=l.workspace_id
          join allrice_employee_runs e on e.run_id=r.id and e.owner_id=r.owner_id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id
          join allrice_jobs j on j.id=a.worker_job_id and j.run_id=r.id and j.owner_id=r.owner_id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id
          where a.root_run_id=${context.runId} and r.owner_id=${context.delegatedBy.id}
            and r.policy_snapshot_id=${context.policySnapshot.id} and a.worker_job_id=${worker.jobId}
            and a.worker_id=${worker.workerId} and a.generation=${worker.generation} and a.fence=${worker.fence ?? 1}
            and a.worker_lease_digest=${runtimeLedgerInputDigest(worker.leaseToken)}
            and j.worker_id=${worker.workerId} and j.lease_token=${worker.leaseToken}
            and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp()
            and j.timeout_at>clock_timestamp() and a.revoked_at is null`;
        if (!row) fail();
        const task = RuntimeTaskRefSchema.parse(row.task);
        if (
          task.runId !== childRunId ||
          task.rootRunId !== context.runId ||
          task.chatSessionId !== row.session_id
        )
          fail();
        await assertAssistantAuthority({
          transaction: tx,
          task,
          tools: ['assistant.report'],
          phase: 'tool',
        });
        return row.session_id;
      }
      const sessionId = await admit();
      const [old] = await tx<
        { version_id: string; request_digest: string; checksum: string }[]
      >`
        select a.version_id,a.request_digest,o.checksum from allrice_workbench_artifacts a
        join allrice_deliverable_versions v on v.id=a.version_id and v.owner_id=a.owner_id and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
        join allrice_storage_objects o on o.id=v.object_id and o.owner_id=v.owner_id and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id
        where a.run_id=${childRunId} and a.request_id=${requestId} and a.organization_id=${context.organizationId}
          and a.workspace_id=${context.workspaceId!} and a.owner_id=${context.delegatedBy.id}
          and v.session_id=${sessionId} and o.state='ready' and o.immutable=true and o.deleted_at is null`;
      if (old) {
        if (old.request_digest !== requestDigest || old.checksum !== checksum)
          throw Error('assistant_output_conflict');
        const existing = await readArtifact(
          tx,
          {
            actor: context.delegatedBy,
            organizationId: context.organizationId,
            workspaceId: context.workspaceId,
          },
          sessionId,
          old.version_id,
        );
        await readArtifactBytes(options.storage, existing.object, bytes.length);
        await admit();
        return { artifactId: old.version_id, digest: checksum, relativePath };
      }
      created = {
        ...createToolBrokerExportObject({
          context,
          mediaType: 'application/json',
          sizeBytes: bytes.length,
          checksum,
        }),
        immutable: true,
      };
      let writeTimer: ReturnType<typeof setTimeout> | undefined;
      const write = options.storage
        .put(created, new Blob([Uint8Array.from(bytes)]).stream())
        .finally(() => {
          writeSettled = true;
        });
      try {
        await Promise.race([
          write,
          new Promise<never>((_, reject) => {
            writeTimer = setTimeout(
              () => reject(Error('assistant_output_storage_timeout')),
              5000,
            );
            writeTimer.unref();
          }),
        ]);
      } finally {
        clearTimeout(writeTimer);
      }
      // Existing bounded reader checks actual bytes/checksum and times out,
      // rather than trusting a declared checksum or holding locks indefinitely.
      await readArtifactBytes(options.storage, created, bytes.length);
      await admit();
      const version = await registerToolBrokerExport(
        {
          context,
          sessionId,
          fileName: `${output.name}.json`,
          format: 'json',
          object: created,
          changeSummary:
            '助手生成内容；仅核验存储与归属，不代表内容或外部动作已独立核实。',
        },
        tx,
      );
      await tx`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
        values(${version.id},${context.organizationId},${context.workspaceId!},${context.delegatedBy.id},${childRunId},'document',
        ${tx.json({ kind: 'model_proposal', runId: childRunId, operationId: null, stepId: deliveryId })},${requestId},${requestDigest})`;
      await admit();
      bodyCompleted = true;
      return { artifactId: version.id, digest: checksum, relativePath };
    });
  } catch (error) {
    // Only a callback failure before COMMIT is definitely unpublished. A body
    // that returned may have committed despite losing its ACK: absence from a
    // second connection is NOT proof of rollback. Preserve those bytes, and
    // pending writes whose cancellation this StoragePort cannot acknowledge.
    if (created && !bodyCompleted && writeSettled)
      await options.storage
        .delete({ ...created, immutable: false })
        .catch(() => {});
    throw error;
  }
}
