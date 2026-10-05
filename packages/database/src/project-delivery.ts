import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import type { TransactionSql } from 'postgres';
import {
  BridgeDeviceSchema,
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandResultSchema,
  RuntimeOperationSnapshotSchema,
  localProjectResultMatchesPayload,
  runtimeContractEqual,
  type ExecutionContext,
  type StoragePort,
  type ProjectSnapshot,
  type ProjectVersionRef,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { createRuntimePolicyAdmission } from './runtime-policy.ts';
import { createGovernedBridgePolicyOptions } from './runtime-governed-bridge.ts';
import { publishWorkbenchArtifact } from './artifact-review.ts';
import { assertSavedProjectAuthority } from './saved-project-authority.ts';
import { assertProjectExecutionOrigin } from './project-execution.ts';
import { projectFail, projectFileText } from './project-source.ts';

const hash = (b: Uint8Array) =>
  'sha256:' + createHash('sha256').update(b).digest('hex');
/** The ZIP contains exact immutable source, never a mutated execution volume or dependencies. */
export function projectSourceArchive(source: ProjectSnapshot) {
  return zipSync(
    Object.fromEntries(
      source.files.map((f) => [f.path, Buffer.from(f.contentBase64, 'base64')]),
    ),
    { level: 6, mtime: new Date(1980, 0, 1) },
  );
}
export function projectSourceDiff(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
) {
  const previous = new Map(before.files.map((f) => [f.path, f])),
    current = new Map(after.files.map((f) => [f.path, f]));
  const lines: string[] = [];
  for (const path of [
    ...new Set([...previous.keys(), ...current.keys()]),
  ].sort()) {
    const a = previous.get(path),
      b = current.get(path);
    if (a?.sha256 === b?.sha256) continue;
    const label = (prefix: string) => JSON.stringify(prefix + path);
    lines.push(
      `diff --git ${label('a/')} ${label('b/')}`,
      `--- ${a ? label('a/') : '/dev/null'}`,
      `+++ ${b ? label('b/') : '/dev/null'}`,
    );
    try {
      const old = a ? projectFileText(a) : '',
        next = b ? projectFileText(b) : '';
      const parts = (s: string) =>
        s === ''
          ? []
          : s.split('\n').slice(0, s.endsWith('\n') ? -1 : undefined);
      const oldLines = parts(old),
        newLines = parts(next);
      lines.push(
        `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
      );
      for (const [prefix, text, entries] of [
        ['-', old, oldLines],
        ['+', next, newLines],
      ] as const) {
        lines.push(...entries.map((x) => prefix + x));
        if (text && !text.endsWith('\n'))
          lines.push('\\ No newline at end of file');
      }
    } catch {
      lines.push('Binary files differ');
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** Reuse the private immutable publisher after an applied, physically stopped
 * Bridge receipt. Neither browser/model bytes nor a caller-modified result are accepted. */
export async function publishLocalProjectArtifacts(
  input: { context: ExecutionContext; operationId: string },
  storage: StoragePort,
  db = getDatabase(),
) {
  const ctx = input.context;
  const read = async (tx: TransactionSql) => {
    const [row] = await tx<
      {
        snapshot: unknown;
        bridge_payload: unknown;
        device_id: string;
        receipt: { attempt: unknown; evidence?: { output?: unknown } };
      }[]
    >`
   select o.snapshot,o.bridge_payload,o.device_id,r.payload as receipt from allrice_runtime_operations o
   join lateral(select payload from allrice_runtime_operation_receipts where operation_id=o.id and disposition='applied'
     and payload->'signal'->>'type'='operation.outcome' and payload->'signal'->'result'->>'status'='succeeded' order by received_at desc limit 1)r on true
   where o.id=${input.operationId} and o.run_id=${ctx.runId} and o.organization_id=${ctx.organizationId} and o.workspace_id=${ctx.workspaceId}`;
    if (!row) projectFail('result_unconfirmed');
    const snapshot = RuntimeOperationSnapshotSchema.parse(row.snapshot),
      payload = RuntimeLocalCommandSchema.parse(row.bridge_payload),
      result = RuntimeLocalCommandResultSchema.parse(
        row.receipt.evidence?.output,
      );
    const source = payload.arguments.projectSource;
    if (
      !source ||
      snapshot.binding.execution.deviceId !== row.device_id ||
      snapshot.status !== 'succeeded' ||
      snapshot.cancelRequestId ||
      snapshot.binding.requestedBy.id !== ctx.policySnapshot.subjectId ||
      !runtimeContractEqual(row.receipt.attempt, snapshot.binding.attempt) ||
      !localProjectResultMatchesPayload(payload, result) ||
      result.reason !== 'exited' ||
      result.exitCode !== 0 ||
      !result.stopped
    )
      projectFail('result_unconfirmed');
    return { snapshot, payload, result, source };
  };
  const initial = await db.begin((tx) => read(tx));
  const artifacts = [];
  for (const [index, output] of (
    initial.payload.arguments.outputs ?? []
  ).entries()) {
    const physical = initial.result.artifacts?.find(
      (a) => a.path === output.path,
    );
    if (!physical) projectFail('output_missing');
    const bytes = Buffer.from(physical.contentBase64, 'base64');
    if (
      bytes.length !== physical.sizeBytes ||
      bytes.toString('base64') !== physical.contentBase64 ||
      hash(bytes) !== physical.checksum
    )
      projectFail('output_changed');
    const artifact = await publishWorkbenchArtifact(
      {
        context: ctx,
        sessionId: initial.snapshot.binding.task.chatSessionId!,
        callId: `project-output:${input.operationId}:${index}`,
        kind: 'document',
        fileName: output.fileName,
        format: output.format,
        bytes,
        mediaType:
          output.format === 'html'
            ? 'text/html'
            : output.format === 'json'
              ? 'application/json'
              : output.format === 'zip'
                ? 'application/zip'
                : 'text/plain',
        changeSummary: `项目版本 ${initial.source.project.snapshot.id}；源码 ${initial.source.snapshot.sourceDigest}；原始输出 ${output.path}`,
      },
      storage,
      db,
      {
        requiredTool: 'workspace.project',
        runId: ctx.runId,
        projectDelivery: {
          operationId: input.operationId,
          execution: initial.snapshot.binding.execution,
        },
        admit: async (tx) => {
          const current = await read(tx);
          if (!runtimeContractEqual(initial, current))
            projectFail('result_changed');
          const [root] =
            await tx`select root_run_id from allrice_runtime_roots where root_run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and cancel_request_id is null and deadline_at>clock_timestamp()`;
          if (!root) projectFail('run_unavailable');
          const [device] = await tx<
            { device: unknown }[]
          >`select json_build_object('id',id,'organizationId',organization_id,'workspaceId',workspace_id,'ownerId',owner_id,
          'name',name,'platform',platform,'protocolVersion',protocol_version,'capabilities',capabilities,'status','online',
          'lastSeenAt',last_seen_at,'createdAt',created_at,'revokedAt',revoked_at) as device from allrice_bridge_devices
          where id=${current.snapshot.binding.execution.deviceId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId} and owner_id=${ctx.policySnapshot.subjectId} and revoked_at is null`;
          if (!device) projectFail('run_unavailable');
          const admission = createRuntimePolicyAdmission(
            createGovernedBridgePolicyOptions(
              BridgeDeviceSchema.parse(device.device),
            ),
          );
          await admission({
            transaction: tx,
            binding: current.snapshot.binding,
            phase: 'heartbeat',
            now: new Date(),
          });
          await assertSavedProjectAuthority(
            tx,
            ctx,
            initial.snapshot.binding.task.chatSessionId!,
            initial.source.origin,
            initial.source.project,
          );
          await assertProjectExecutionOrigin(
            tx,
            initial.snapshot.binding,
            initial.payload.arguments,
            'local',
          );
        },
      },
    );
    artifacts.push({
      objectId: artifact.object.id,
      versionId: artifact.id,
      fileName: artifact.version.fileName,
      checksum: artifact.object.checksum,
    });
  }
  return artifacts;
}

/** A report cites exact source refs and actual terminal records, not an AI-written pass claim. */
export async function projectExecutionReport(
  ctx: Pick<ExecutionContext, 'runId' | 'organizationId' | 'workspaceId'> & {
    policySnapshot: { subjectId: string };
  },
  project: ProjectVersionRef,
  db: ReturnType<typeof getDatabase> | TransactionSql = getDatabase(),
) {
  const rows = await db<
    { id: string; snapshot: unknown; command: unknown; outcome: unknown }[]
  >`
  select o.id,o.snapshot,coalesce(o.bridge_payload->'arguments',i.payload->'arguments') as command,
   coalesce(ca.outcome,r.payload->'evidence'->'output') as outcome
  from allrice_runtime_operations o
  left join allrice_cloud_execution_inputs i on i.operation_id=o.id
  left join allrice_cloud_execution_attempts ca on ca.operation_id=o.id
  left join lateral(select payload from allrice_runtime_operation_receipts where operation_id=o.id and disposition='applied'
    and payload->'signal'->>'type' in ('operation.outcome','operation.stopped') order by received_at desc limit 1)r on true
  where o.run_id=${ctx.runId} and o.organization_id=${ctx.organizationId} and o.workspace_id=${ctx.workspaceId}
    and o.snapshot->'binding'->'requestedBy'->>'id'=${ctx.policySnapshot.subjectId}
    and coalesce(o.bridge_payload->'arguments',i.payload->'arguments')->'projectSource'->'project'->>'projectId'=${project.projectId}
  order by o.created_at,o.id limit 32`;
  return {
    version: 1,
    project,
    runId: ctx.runId,
    executions: rows.map((row) => {
      const s = RuntimeOperationSnapshotSchema.parse(row.snapshot);
      const a = row.command as {
          executable: string;
          args: string[];
          path: string;
          projectSource: {
            project: ProjectVersionRef;
            snapshot: ProjectSnapshot;
          };
        },
        result = row.outcome as {
          reason?: string;
          exitCode?: number;
          stopped?: boolean;
          output?: string;
          stdout?: string;
          stderr?: string;
        } | null;
      return {
        operationId: row.id,
        status: s.status,
        location: s.binding.execution.deviceId ? 'local' : 'cloud',
        project: a.projectSource.project,
        sourceDigest: a.projectSource.snapshot.sourceDigest,
        files: a.projectSource.snapshot.files.map(({ path, sha256 }) => ({
          path,
          sha256,
        })),
        command: { executable: a.executable, args: a.args, path: a.path },
        result: result
          ? {
              reason: result.reason,
              exitCode: result.exitCode,
              stopped: result.stopped,
              output: result.output ?? '',
              stdout: result.stdout ?? '',
              stderr: result.stderr ?? '',
              trusted: false,
            }
          : null,
      };
    }),
  };
}
