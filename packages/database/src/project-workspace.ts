import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ExecutionContextSchema,
  ProjectWorkspaceCommandSchema,
  authorizeExecution,
  runtimeContractEqual,
  projectSourceLimits,
  runtimeFeatureEnabled,
  type ExecutionContext,
  type RuntimeContentRef,
  type ProjectVersionRef,
  type StoragePort,
  type ProjectSnapshot,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  assertPublishingRun,
  assertWorkbenchSession,
  readArtifact,
  readArtifactBytes,
  publishWorkbenchArtifact,
} from './artifact-review.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import {
  projectFail as fail,
  projectSourceFile,
  makeProjectSnapshot,
  parseProjectSnapshotBytes,
  projectFileText,
  applyProjectProposal,
} from './project-source.ts';
export { ProjectWorkspaceError } from './project-source.ts';
type Database = ReturnType<typeof getDatabase>;
type Input = {
  context: ExecutionContext;
  sessionId: string;
  callId: string;
  worker: { attempt: number; leaseToken: string };
  arguments: unknown;
};
type Head = {
  head_artifact_id: string;
  head_checksum: string;
  revision: number;
};
const artifactRef = (id: string, checksum: string): RuntimeContentRef => ({
  kind: 'artifact',
  id,
  checksum,
});
/** Stable per trusted call, so retrying open never creates a different project. */
function newProjectId(input: Input) {
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        input.context.organizationId,
        input.context.workspaceId,
        input.context.runId,
        input.callId,
      ]),
    )
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Single-agent source checkpoints only. Source storage is independent of
 * containers, dependency caches, Changeset review and host folder grants. */
export async function executeProjectWorkspace(
  input: Input,
  storage: StoragePort,
  db: Database = getDatabase(),
) {
  const ctx = ExecutionContextSchema.parse(input.context),
    args = ProjectWorkspaceCommandSchema.parse(input.arguments);
  if (!runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED')) fail('disabled');
  z.uuid().parse(input.sessionId);
  z.object({ attempt: z.number().int().nonnegative(), leaseToken: z.uuid() })
    .strict()
    .parse(input.worker);
  if (
    !ctx.workspaceId ||
    !input.callId ||
    input.callId.length > 200 ||
    ctx.policySnapshot.subjectId !== ctx.delegatedBy.id
  )
    fail('forbidden');
  const principal = {
    actor: { type: 'user' as const, id: ctx.policySnapshot.subjectId },
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
  };
  async function admit(tx: TransactionSql) {
    if (Date.parse(ctx.policySnapshot.expiresAt) <= Date.now())
      fail('forbidden');
    await lockWorkspaceStorageQuota(tx, ctx.organizationId, ctx.workspaceId);
    const [root] =
      await tx`select root_run_id from allrice_runtime_roots where root_run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and cancel_requested_at is null and deadline_at>clock_timestamp() for update`;
    if (!root) fail('run_unavailable');
    const [lease] = await tx`select j.id from allrice_jobs j
      join allrice_runtime_run_links l on l.run_id=j.run_id and l.root_run_id=j.run_id
      where j.id=${ctx.jobId} and j.run_id=${ctx.runId} and j.organization_id=${ctx.organizationId} and j.workspace_id=${ctx.workspaceId!}
        and j.owner_id=${ctx.policySnapshot.subjectId} and j.worker_id=${ctx.worker.id} and j.attempt=${input.worker.attempt} and j.lease_token=${input.worker.leaseToken}
        and j.status='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp() and j.timeout_at>clock_timestamp() for share of j,l`;
    if (!lease) fail('run_unavailable');
    await assertPublishingRun(tx, ctx, input.sessionId, 'workspace.project');
    const [employee] = await tx`select a.id from allrice_employee_runs r
      join allrice_employee_assignments a on a.id=r.employee_assignment_id and a.organization_id=r.organization_id and a.workspace_id=r.workspace_id and a.user_id=r.owner_id and a.active
      join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id and e.status='active'
      join allrice_employee_versions v on v.id=r.employee_version_id and v.employee_id=e.id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
      join allrice_policy_snapshots p on p.id=${ctx.policySnapshot.id} and p.organization_id=r.organization_id and p.subject_id=r.owner_id and p.expires_at>clock_timestamp()
      where r.run_id=${ctx.runId} and r.session_id=${input.sessionId} and r.organization_id=${ctx.organizationId} and r.workspace_id=${ctx.workspaceId!} and r.owner_id=${ctx.policySnapshot.subjectId}
        and not exists(select 1 from allrice_platform_employee_tenant_assignments d where d.tenant_employee_id=e.id and d.organization_id=e.organization_id and d.workspace_id=e.workspace_id and not d.active)
      for share of r,a,e,v,p`;
    if (!employee) fail('run_unavailable');
    await assertWorkbenchSession(tx, principal, input.sessionId, true);
  }
  async function head(tx: TransactionSql, projectId: string) {
    const [row] = await tx<
      Head[]
    >`select head_artifact_id,head_checksum,revision from allrice_project_workspace_heads
      where root_run_id=${ctx.runId} and project_id=${projectId} and organization_id=${ctx.organizationId}
        and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId} for update`;
    return row;
  }
  async function load(tx: TransactionSql, source: RuntimeContentRef) {
    const [row] = await tx<
      {
        id: string;
        session_id: string;
        object_id: string;
        series_id: string;
        version: number;
      }[]
    >`select id,session_id,object_id,series_id,version from allrice_deliverable_versions
      where organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId}
        and (${source.kind === 'storage_object'} and object_id=${source.id} or ${source.kind !== 'storage_object'} and id=${source.id}) for share`;
    if (!row) fail('snapshot_not_found');
    await assertWorkbenchSession(tx, principal, row.session_id);
    const artifact = await readArtifact(tx, principal, row.session_id, row.id);
    if (
      !authorizeExecution(
        {
          type: 'storage_object',
          id: artifact.object.id,
          organizationId: artifact.object.organizationId,
          workspaceId: artifact.object.workspaceId,
          ownerId: artifact.object.ownerId,
          visibility: 'private',
          archivedAt: null,
        },
        'resource:read',
        ctx,
      ).allowed
    )
      fail('forbidden');
    if (
      artifact.kind !== 'document' ||
      artifact.object.mediaType !== 'application/json' ||
      !artifact.object.immutable ||
      artifact.object.checksum !== source.checksum
    )
      fail('source_changed');
    if (
      source.kind === 'deliverable_version' &&
      (source.objectId !== row.object_id ||
        source.seriesId !== row.series_id ||
        source.version !== row.version)
    )
      fail('source_changed');
    const document = parseProjectSnapshotBytes(
      await readArtifactBytes(
        storage,
        artifact.object,
        projectSourceLimits.snapshotBytes,
      ),
    );
    return { artifact, document };
  }
  async function loadedProject(tx: TransactionSql, ref: ProjectVersionRef) {
    if (!(await head(tx, ref.projectId))) fail('project_not_open');
    const loaded = await load(tx, ref.snapshot);
    if (loaded.document.projectId !== ref.projectId) fail('project_mismatch');
    return loaded;
  }
  if (
    args.action === 'list' ||
    args.action === 'read' ||
    args.action === 'search'
  ) {
    return db.begin(async (tx) => {
      await admit(tx);
      const { document } = await loadedProject(tx, args.project);
      await admit(tx);
      if (args.action === 'list')
        return {
          project: args.project,
          sourceDigest: document.sourceDigest,
          files: document.files.map(({ path, sha256, sizeBytes }) => ({
            path,
            sha256,
            sizeBytes,
          })),
        };
      if (args.action === 'read') {
        const file = document.files.find((f) => f.path === args.path);
        if (!file) fail('file_not_found');
        const text = projectFileText(file);
        return {
          project: args.project,
          path: file.path,
          checksum: file.sha256,
          text: text.slice(args.offset, args.offset + args.limit),
          offset: args.offset,
          nextOffset:
            args.offset + args.limit < text.length
              ? args.offset + args.limit
              : null,
        };
      }
      const matches: { path: string; line: number; text: string }[] = [];
      let count = 0;
      for (const file of document.files) {
        let text: string;
        try {
          text = projectFileText(file);
        } catch {
          continue;
        }
        for (const [index, line] of text.split('\n').entries())
          if (line.includes(args.query)) {
            if (count >= args.offset && matches.length < args.limit)
              matches.push({
                path: file.path,
                line: index + 1,
                text: line.slice(0, 500),
              });
            count++;
          }
      }
      return {
        project: args.project,
        matches,
        nextOffset:
          args.offset + matches.length < count
            ? args.offset + matches.length
            : null,
      };
    });
  }
  const prepared = await db.begin(async (tx) => {
    await admit(tx);
    if (args.action === 'apply') {
      const loaded = await loadedProject(tx, args.expectedHead);
      return {
        document: applyProjectProposal(
          loaded.document,
          args.proposal,
          args.expectedHead.snapshot,
        ),
        parentObjectId: loaded.artifact.object.id,
        source: args.expectedHead.snapshot,
        expectedArtifact: artifactRef(
          loaded.artifact.id,
          loaded.artifact.object.checksum!,
        ),
      };
    }
    if (args.source) {
      const { document } = await load(tx, args.source);
      // Restoring an exact historical version starts a new series. It is not
      // an update to another session's parent version.
      return {
        document: makeProjectSnapshot(document.projectId, document.files, {
          source: args.source,
          ...(document.inputs ? { inputs: document.inputs } : {}),
        }),
        source: args.source,
      };
    }
    const files: ProjectSnapshot['files'] = [],
      inputs: RuntimeContentRef[] = [];
    for (const file of args.files ?? []) {
      if ('text' in file) {
        if (file.text.includes('\0')) fail('binary_file');
        files.push(
          projectSourceFile(file.path, Buffer.from(file.text, 'utf8')),
        );
      } else {
        const source = await getToolBrokerFile(ctx, file.objectId, tx);
        if (source.object.checksum !== file.checksum) fail('source_changed');
        const bytes = await readArtifactBytes(
          storage,
          source.object,
          projectSourceLimits.fileBytes,
        );
        files.push(projectSourceFile(file.path, bytes));
        inputs.push({
          kind: 'storage_object',
          id: file.objectId,
          checksum: file.checksum,
        });
      }
    }
    return {
      document: makeProjectSnapshot(
        newProjectId(input),
        files,
        inputs.length ? { inputs } : {},
      ),
    };
  });
  const document = prepared.document,
    projectId = document.projectId;
  const artifact = await publishWorkbenchArtifact(
    {
      context: ctx,
      sessionId: input.sessionId,
      callId: input.callId,
      kind: 'document',
      fileName: `project-${projectId}.json`,
      format: 'json',
      mediaType: 'application/json',
      bytes: Buffer.from(JSON.stringify(document)),
      ...('parentObjectId' in prepared
        ? { parentObjectId: prepared.parentObjectId }
        : {}),
      changeSummary:
        args.action === 'apply'
          ? '保存项目源码修改；未执行构建或写回原目录。'
          : '保存完整项目源码及锁文件；未执行构建。',
    },
    storage,
    db,
    {
      requiredTool: 'workspace.project',
      runId: ctx.runId,
      admit: async (tx) => {
        await admit(tx);
        const [replay] =
          await tx`select version_id from allrice_workbench_artifacts where run_id=${ctx.runId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and request_id=${input.callId}`;
        if (replay) return; // The common publisher checks the full byte/request digest.
        const current = await head(tx, projectId);
        if (args.action === 'apply') {
          if (
            !current ||
            !('expectedArtifact' in prepared) ||
            !runtimeContractEqual(
              artifactRef(current.head_artifact_id, current.head_checksum),
              prepared.expectedArtifact,
            )
          )
            fail('head_conflict');
        } else if (current) fail('already_open');
        if ('source' in prepared && prepared.source)
          await load(tx, prepared.source);
        if (args.action === 'open' && !args.source)
          for (const source of document.inputs ?? []) {
            await tx`select id from allrice_storage_objects where id=${source.id} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} for share`;
            if (
              (await getToolBrokerFile(ctx, source.id, tx)).object.checksum !==
              source.checksum
            )
              fail('source_changed');
          }
      },
      registered: async (tx, id) => {
        const [row] = await tx<
          { checksum: string }[]
        >`select o.checksum from allrice_deliverable_versions v join allrice_storage_objects o on o.id=v.object_id where v.id=${id}`;
        if (!row) fail('publication_unavailable');
        if (args.action === 'apply') {
          const updated =
            await tx`update allrice_project_workspace_heads set head_artifact_id=${id},head_checksum=${row.checksum},revision=revision+1,updated_at=clock_timestamp()
        where root_run_id=${ctx.runId} and project_id=${projectId} and organization_id=${ctx.organizationId} and workspace_id=${ctx.workspaceId!} and owner_id=${ctx.policySnapshot.subjectId} and head_artifact_id=${('expectedArtifact' in prepared ? prepared.expectedArtifact?.id : null) ?? null} and head_checksum=${args.expectedHead.snapshot.checksum} returning project_id`;
          if (updated.length !== 1) fail('head_conflict');
        } else
          await tx`insert into allrice_project_workspace_heads(organization_id,workspace_id,owner_id,root_run_id,project_id,head_artifact_id,head_checksum)
        values(${ctx.organizationId},${ctx.workspaceId!},${ctx.policySnapshot.subjectId},${ctx.runId},${projectId},${id},${row.checksum})`;
        await admit(tx);
      },
    },
  );
  return {
    project: {
      projectId,
      snapshot: artifactRef(artifact.id, artifact.object.checksum!),
    } satisfies ProjectVersionRef,
    sourceDigest: document.sourceDigest,
    version: artifact.version.version,
    objectId: artifact.object.id,
    fileCount: document.files.length,
    downloadUrl: `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(artifact.version.fileName)}`,
    saved: true,
    executed: false,
  };
}
