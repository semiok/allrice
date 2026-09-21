import {
  DevelopmentArtifactRefSchema,
  DevelopmentPathsSchema,
  RuntimeExecutionScopeSchema,
  composeDevelopmentChangesets,
  developmentPathsOverlap,
  type DevelopmentArtifactRef,
  type RuntimeExecutionScope,
  type RuntimeScope,
  type RuntimeTaskRef,
  type StoragePort,
} from '@allrice/contracts';
import { z } from 'zod';
import type { AssistantWorkerLease } from './assistant-runtime.ts';
import type { getDatabase } from './core/client.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
import { runtimeLedgerInputDigest as digest } from './runtime-ledger/ledger.ts';
import {
  readArtifact,
  readArtifactBytes,
  parseChangesetBytes,
} from './artifact-review.ts';

type Tx = RuntimeLedgerTransaction;
export interface DevelopmentCaller {
  scope: RuntimeScope;
  rootRunId: string;
  /** Trusted native caller identity, never a model argument. */
  runId: string;
  worker: AssistantWorkerLease;
}
interface Head {
  seed_artifact_id: string;
  seed_digest: string;
  head_artifact_id: string;
  head_digest: string;
  execution: RuntimeExecutionScope;
  revision: number;
}
interface Assignment {
  id: string;
  run_id: string;
  assigned_by_run_id: string;
  base_artifact_id: string;
  base_digest: string;
  execution: RuntimeExecutionScope;
  paths: string[];
  request_digest: string;
  released_at: Date | null;
}
function fail(code: string): never {
  throw Error(`development_${code}`);
}
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
const ref = (artifactId: string, checksum: string) => ({
  artifactId,
  digest: checksum,
});
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function sameDestination(a: RuntimeExecutionScope, b: RuntimeExecutionScope) {
  return same({ ...a, workCopy: null }, { ...b, workCopy: null });
}

/** Internal foundation composed by createAssistantRuntime. It has no HTTP or
 * model entrypoint and performs NO filesystem writes, approvals or execution.
 * Each call shares the existing root lock, lease, ancestry and authority checks. */
export function createDevelopmentCooperation(options: {
  database: ReturnType<typeof getDatabase>;
  authorize: (
    tx: Tx,
    caller: DevelopmentCaller,
    tool: string,
    completed?: boolean,
  ) => Promise<RuntimeTaskRef>;
}) {
  const db = options.database;
  async function head(tx: Tx, rootRunId: string) {
    const [row] = await tx<
      Head[]
    >`select * from allrice_development_heads where root_run_id=${rootRunId} for update`;
    if (!row) fail('not_found');
    return row;
  }
  async function assignment(tx: Tx, rootRunId: string, id: string) {
    z.uuid().parse(id);
    const [row] = await tx<
      Assignment[]
    >`select * from allrice_development_assignments where root_run_id=${rootRunId} and id=${id}`;
    if (!row) fail('not_found');
    return row;
  }
  async function artifact(
    tx: Tx,
    task: RuntimeTaskRef,
    source: DevelopmentArtifactRef,
    storage: StoragePort,
    author?: string,
    latest = true,
  ) {
    DevelopmentArtifactRefSchema.parse(source);
    // Resolve the owner/session from the real root, not caller/model metadata.
    const [owner] = await tx<{ owner_id: string }[]>`
      select r.owner_id from allrice_runs r
      join allrice_chat_sessions s on s.id=${task.chatSessionId} and s.owner_id=r.owner_id and s.organization_id=r.organization_id and s.workspace_id=r.workspace_id
      join allrice_users u on u.id=r.owner_id and u.status='active'
      join allrice_organizations o on o.id=r.organization_id and o.archived_at is null
      join allrice_workspaces w on w.id=r.workspace_id and w.organization_id=r.organization_id and w.archived_at is null
      where r.id=${task.rootRunId} and r.organization_id=${task.scope.organizationId} and r.workspace_id=${task.scope.workspaceId} and s.archived_at is null
      and exists(select 1 from allrice_memberships m where m.user_id=r.owner_id and m.organization_id=r.organization_id and (m.workspace_id is null or m.workspace_id=r.workspace_id) and m.active and m.role in ('member','admin'))`;
    if (!owner || !task.chatSessionId) fail('forbidden');
    // Publishing a newer version locks its parent version. Hold this version
    // before checking latest so adoption cannot race that publication/deletion.
    await tx`select v.id from allrice_deliverable_versions v
      join allrice_storage_objects o on o.id=v.object_id
      where v.id=${source.artifactId} and v.organization_id=${task.scope.organizationId}
        and v.workspace_id=${task.scope.workspaceId} and v.owner_id=${owner.owner_id}
      for share of v,o`;
    const value = await readArtifact(
      tx,
      {
        actor: { type: 'user', id: owner.owner_id },
        organizationId: task.scope.organizationId,
        workspaceId: task.scope.workspaceId,
      },
      task.chatSessionId,
      source.artifactId,
    );
    if (
      value.kind !== 'changeset' ||
      !value.execution ||
      !value.object.immutable ||
      value.object.checksum !== source.digest ||
      (latest && value.stale)
    )
      fail('artifact_mismatch');
    const [provenance] = await tx`
      select a.version_id from allrice_workbench_artifacts a
      join allrice_assistant_instances i on i.run_id=a.run_id and i.root_run_id=${task.rootRunId}
      where a.version_id=${value.id} and a.run_id=${value.provenance.runId}
      and (${author ?? null}::uuid is null or a.run_id=${author ?? null}::uuid) for share of a`;
    if (!provenance) fail('artifact_mismatch');
    const document = parseChangesetBytes(
      await readArtifactBytes(storage, value.object),
    );
    if (!same(document.execution, value.execution)) fail('artifact_mismatch');
    DevelopmentPathsSchema.parse(document.files.map((f) => f.path));
    return { value, document };
  }
  const rootOnly = (caller: DevelopmentCaller) => {
    if (caller.runId !== caller.rootRunId) fail('forbidden');
  };
  return {
    async initialize(
      input: DevelopmentCaller & { seed: DevelopmentArtifactRef },
      storage: StoragePort,
    ) {
      rootOnly(input);
      return db.begin(async (tx) => {
        const task = await options.authorize(
          tx,
          input,
          'workspace.export.create',
        );
        const [old] = await tx<
          Head[]
        >`select * from allrice_development_heads where root_run_id=${input.rootRunId}`;
        const seed = await artifact(
          tx,
          task,
          input.seed,
          storage,
          input.rootRunId,
          !old,
        );
        if (old) {
          if (
            old.seed_artifact_id !== input.seed.artifactId ||
            old.seed_digest !== input.seed.digest
          )
            fail('conflict');
          await options.authorize(tx, input, 'workspace.export.create');
          return {
            head: ref(old.head_artifact_id, old.head_digest),
            revision: old.revision,
          };
        }
        await tx`insert into allrice_development_heads(root_run_id,seed_artifact_id,seed_digest,head_artifact_id,head_digest,execution)
          values(${input.rootRunId},${input.seed.artifactId},${input.seed.digest},${input.seed.artifactId},${input.seed.digest},${json(tx, seed.document.execution)})`;
        await options.authorize(tx, input, 'workspace.export.create');
        return { head: input.seed, revision: 0 };
      });
    },
    async assign(
      input: DevelopmentCaller & {
        assignmentId: string;
        ownerRunId: string;
        expectedHead: DevelopmentArtifactRef;
        execution: RuntimeExecutionScope;
        paths: string[];
      },
    ) {
      z.uuid().parse(input.assignmentId);
      z.uuid().parse(input.ownerRunId);
      const expected = DevelopmentArtifactRefSchema.parse(input.expectedHead);
      const execution = RuntimeExecutionScopeSchema.parse(input.execution);
      const paths = DevelopmentPathsSchema.parse(input.paths).sort();
      const requestDigest = digest({
        assignedBy: input.runId,
        owner: input.ownerRunId,
        expected,
        execution,
        paths,
      });
      return db.begin(async (tx) => {
        await options.authorize(tx, input, 'assistant.delegate');
        const owner = await options.authorize(
          tx,
          { ...input, runId: input.ownerRunId },
          'workspace.export.create',
        );
        // A parent assigns only itself or its direct child, never a sibling.
        if (
          input.ownerRunId !== input.runId &&
          owner.parentRunId !== input.runId
        )
          fail('forbidden');
        const current = await head(tx, input.rootRunId);
        const [old] = await tx<
          Assignment[]
        >`select * from allrice_development_assignments where id=${input.assignmentId}`;
        if (old) {
          if (
            old.request_digest !== requestDigest ||
            !sameDestination(old.execution, current.execution)
          )
            fail('conflict');
          await options.authorize(tx, input, 'assistant.delegate');
          return { assignmentId: old.id, active: old.released_at === null };
        }
        if (!same(ref(current.head_artifact_id, current.head_digest), expected))
          fail('head_conflict');
        if (
          !sameDestination(execution, current.execution) ||
          (execution.workCopy.kind === 'in_place' &&
            !same(execution.workCopy, current.execution.workCopy)) ||
          execution.workCopy.kind === 'remote_service'
        )
          fail('target_mismatch');
        const claims = await tx<
          Assignment[]
        >`select * from allrice_development_assignments where root_run_id=${input.rootRunId} and released_at is null`;
        // Copy kind cannot be changed to evade ownership of the same copy ID.
        if (
          claims.some(
            (c) =>
              c.execution.workCopy.id === execution.workCopy.id &&
              c.paths.some((p) =>
                paths.some((q) => developmentPathsOverlap(p, q)),
              ),
          )
        )
          fail('path_conflict');
        await tx`insert into allrice_development_assignments(id,root_run_id,run_id,assigned_by_run_id,base_artifact_id,base_digest,execution,paths,request_digest)
          values(${input.assignmentId},${input.rootRunId},${input.ownerRunId},${input.runId},${expected.artifactId},${expected.digest},${json(tx, execution)},${json(tx, paths)},${requestDigest})`;
        await options.authorize(tx, input, 'assistant.delegate');
        return { assignmentId: input.assignmentId, active: true };
      });
    },
    async propose(
      input: DevelopmentCaller & {
        assignmentId: string;
        proposal: DevelopmentArtifactRef;
      },
      storage: StoragePort,
    ) {
      DevelopmentArtifactRefSchema.parse(input.proposal);
      return db.begin(async (tx) => {
        const task = await options.authorize(
          tx,
          input,
          'workspace.export.create',
        );
        const claim = await assignment(tx, input.rootRunId, input.assignmentId);
        if (claim.run_id !== input.runId || claim.released_at)
          fail('forbidden');
        const base = await artifact(
          tx,
          task,
          ref(claim.base_artifact_id, claim.base_digest),
          storage,
          input.rootRunId,
          false,
        );
        const proposed = await artifact(
          tx,
          task,
          input.proposal,
          storage,
          input.runId,
        );
        if (
          !same(proposed.document.execution, claim.execution) ||
          proposed.document.files.some((f) => !claim.paths.includes(f.path))
        )
          fail('scope_mismatch');
        composeDevelopmentChangesets(base.document, [proposed.document]);
        const [old] = await tx<
          { assignment_id: string; digest: string }[]
        >`select assignment_id,digest from allrice_development_proposals where artifact_id=${input.proposal.artifactId}`;
        if (
          old &&
          (old.assignment_id !== claim.id ||
            old.digest !== input.proposal.digest)
        )
          fail('conflict');
        if (!old)
          await tx`insert into allrice_development_proposals(artifact_id,root_run_id,assignment_id,digest) values(${input.proposal.artifactId},${input.rootRunId},${claim.id},${input.proposal.digest})`;
        await options.authorize(tx, input, 'workspace.export.create');
        return input.proposal;
      });
    },
    /** Validate and adopt an ALREADY registered new Changeset version. Publishing
     * uses the existing storage/quota transaction BEFORE this root transaction;
     * no root->storage-quota lock inversion, and no second content ledger. */
    async merge(
      input: DevelopmentCaller & {
        requestId: string;
        expectedHead: DevelopmentArtifactRef;
        proposals: DevelopmentArtifactRef[];
        result: DevelopmentArtifactRef;
      },
      storage: StoragePort,
    ) {
      rootOnly(input);
      z.uuid().parse(input.requestId);
      DevelopmentArtifactRefSchema.parse(input.expectedHead);
      DevelopmentArtifactRefSchema.parse(input.result);
      const proposals = z
        .array(DevelopmentArtifactRefSchema)
        .min(1)
        .max(16)
        .parse(input.proposals)
        .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
      if (new Set(proposals.map((p) => p.artifactId)).size !== proposals.length)
        fail('conflict');
      const requestDigest = digest({
        expected: input.expectedHead,
        proposals,
        result: input.result,
      });
      return db.begin(async (tx) => {
        const task = await options.authorize(
          tx,
          input,
          'workspace.export.create',
        );
        const current = await head(tx, input.rootRunId);
        const [old] = await tx<
          { root_run_id: string; request_digest: string; revision: number }[]
        >`select * from allrice_development_merges where request_id=${input.requestId}`;
        if (old) {
          if (
            old.root_run_id !== input.rootRunId ||
            old.request_digest !== requestDigest
          )
            fail('conflict');
          await options.authorize(tx, input, 'workspace.export.create');
          return {
            head: input.result,
            revision: old.revision,
            verification: 'unverified' as const,
          };
        }
        if (
          !same(
            ref(current.head_artifact_id, current.head_digest),
            input.expectedHead,
          ) ||
          input.result.artifactId === current.head_artifact_id
        )
          fail('head_conflict');
        // A newly published child of the head necessarily makes the head stale.
        const previous = await artifact(
          tx,
          task,
          input.expectedHead,
          storage,
          input.rootRunId,
          false,
        );
        const documents = [];
        const assignments = new Set<string>();
        for (const source of proposals) {
          const [registered] = await tx<
            { assignment_id: string; digest: string }[]
          >`select p.assignment_id,p.digest from allrice_development_proposals p where p.artifact_id=${source.artifactId} and p.root_run_id=${input.rootRunId} and not exists(select 1 from allrice_development_merge_sources s where s.artifact_id=p.artifact_id)`;
          if (!registered || registered.digest !== source.digest)
            fail('proposal_mismatch');
          const claim = await assignment(
            tx,
            input.rootRunId,
            registered.assignment_id,
          );
          if (claim.released_at || assignments.has(claim.id)) fail('conflict');
          await options.authorize(
            tx,
            { ...input, runId: claim.run_id },
            'workspace.export.create',
            true,
          );
          const proposal = await artifact(
            tx,
            task,
            source,
            storage,
            claim.run_id,
          );
          if (!same(proposal.document.execution, claim.execution))
            fail('target_mismatch');
          documents.push(proposal.document);
          assignments.add(claim.id);
        }
        const composed = composeDevelopmentChangesets(
          previous.document,
          documents,
        );
        const result = await artifact(
          tx,
          task,
          input.result,
          storage,
          input.rootRunId,
        );
        const normalizedResult = {
          ...result.document,
          files: [...result.document.files].sort((a, b) =>
            a.path.localeCompare(b.path, 'en'),
          ),
        };
        if (
          !same(composed, normalizedResult) ||
          result.value.version.seriesId !== previous.value.version.seriesId ||
          result.value.version.version <= previous.value.version.version
        )
          fail('result_mismatch');
        // Rejected/stale candidates may already exist in the artifact series.
        // A corrected descendant can be adopted, but only with freshly computed
        // content from the still-current head; no rejected content is inherited.
        const [lineage] = await tx`
          with recursive ancestors as (
            select id,parent_version_id,0 as depth from allrice_deliverable_versions where id=${result.value.id}
            union all select p.id,p.parent_version_id,c.depth+1 from allrice_deliverable_versions p join ancestors c on p.id=c.parent_version_id
              where c.depth<64 and p.series_id=${previous.value.version.seriesId}
                and p.organization_id=${task.scope.organizationId} and p.workspace_id=${task.scope.workspaceId}
                and p.owner_id=${previous.value.version.ownerId} and p.session_id=${task.chatSessionId}
          ) select id from ancestors where id=${previous.value.id} and depth>0`;
        if (!lineage) fail('result_mismatch');
        const revision = current.revision + 1;
        await tx`insert into allrice_development_merges(request_id,root_run_id,request_digest,previous_artifact_id,result_artifact_id,result_digest,revision) values(${input.requestId},${input.rootRunId},${requestDigest},${previous.value.id},${result.value.id},${input.result.digest},${revision})`;
        for (const source of proposals)
          await tx`insert into allrice_development_merge_sources(request_id,artifact_id) values(${input.requestId},${source.artifactId})`;
        for (const id of assignments)
          await tx`update allrice_development_assignments set released_at=clock_timestamp() where root_run_id=${input.rootRunId} and id=${id}`;
        await tx`update allrice_development_heads set head_artifact_id=${input.result.artifactId},head_digest=${input.result.digest},revision=${revision} where root_run_id=${input.rootRunId}`;
        await options.authorize(tx, input, 'workspace.export.create');
        return {
          head: input.result,
          revision,
          verification: 'unverified' as const,
        };
      });
    },
  };
}
