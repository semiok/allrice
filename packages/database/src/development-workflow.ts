import { createHash } from 'node:crypto';
import {
  DevelopmentCommandSchema,
  RuntimeOperationSnapshotSchema,
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandResultSchema,
  composeDevelopmentChangesets,
  runtimeContractEqual,
  type ChangesetDocument,
  type ExecutionContext,
  type StoragePort,
  type RuntimeTaskRef,
  type WorkbenchArtifact,
  type DevelopmentArtifactRef,
} from '@allrice/contracts';
import { z } from 'zod';
import type { getDatabase } from './core/client.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';
import type {
  DevelopmentCaller,
  DevelopmentHead,
  DevelopmentAssignment,
  createDevelopmentCooperation,
} from './development-cooperation.ts';
import {
  publishWorkbenchArtifact,
  parseChangesetBytes,
} from './artifact-review.ts';
import { localCommandCandidateEvidence } from './local-command-candidate.ts';

type Tx = RuntimeLedgerTransaction;
type Ref = DevelopmentArtifactRef;
const hash = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ref = (h: DevelopmentHead): Ref => ({
  artifactId: h.head_artifact_id,
  digest: h.head_digest,
});
function fail(reason: string): never {
  throw Error(`development_${reason}`);
}
type Options = {
  database: ReturnType<typeof getDatabase>;
  core: Pick<
    ReturnType<typeof createDevelopmentCooperation>,
    'initialize' | 'assign' | 'propose' | 'merge'
  >;
  authorize: (
    tx: Tx,
    caller: DevelopmentCaller,
    tool: string,
    completed?: boolean,
  ) => Promise<RuntimeTaskRef>;
  head: (tx: Tx, root: string) => Promise<DevelopmentHead>;
  assignment: (
    tx: Tx,
    root: string,
    id: string,
  ) => Promise<DevelopmentAssignment>;
  artifact: (
    tx: Tx,
    task: RuntimeTaskRef,
    source: Ref,
    storage: StoragePort,
    author?: string,
    latest?: boolean,
  ) => Promise<{ value: WorkbenchArtifact; document: ChangesetDocument }>;
};

/** A bounded workflow over the existing runtime, storage and command ledger.
 * No agent loop, direct file writes, approval synthesis or model-rated tests. */
export async function executeDevelopmentWorkflow(
  input: DevelopmentCaller & {
    context: ExecutionContext;
    requestId: string;
    arguments: unknown;
  },
  storage: StoragePort,
  o: Options,
  transaction?: Tx,
): Promise<unknown> {
  if (
    process.env.ALLRICE_WORKBENCH_ENABLED !== '1' ||
    process.env.ALLRICE_CHANGESET_ENABLED !== '1'
  )
    fail('disabled');
  const args = DevelopmentCommandSchema.parse(input.arguments);
  if (transaction && args.action !== 'assign') fail('invalid_action');
  const assignmentTransaction = <T>(
    callback: (tx: Tx) => Promise<T>,
  ): Promise<T> =>
    transaction
      ? callback(transaction)
      : (o.database.begin(callback) as Promise<T>);
  z.uuid().parse(input.requestId);
  if (
    input.context.runId !== input.rootRunId ||
    input.context.jobId !== input.worker.jobId ||
    input.context.worker.id !== input.worker.workerId ||
    input.context.organizationId !== input.scope.organizationId ||
    input.context.workspaceId !== input.scope.workspaceId
  )
    fail('forbidden');
  const rootOnly = () => {
    if (input.runId !== input.rootRunId) fail('forbidden');
  };
  const admit = (tx: Tx, runId = input.runId, completed = false) =>
    o.authorize(tx, { ...input, runId }, 'assistant.development', completed);
  const current = async (tx: Tx, source: Ref) => {
    const h = await o.head(tx, input.rootRunId);
    if (!runtimeContractEqual(ref(h), source)) fail('head_conflict');
    return h;
  };
  const assigned = async (
    tx: Tx,
    source: Ref,
    role: 'test' | 'review',
    runId = input.runId,
  ) => {
    const [v] = await tx`select id from allrice_development_verifiers
      where root_run_id=${input.rootRunId} and run_id=${runId} and artifact_id=${source.artifactId}
        and digest=${source.digest} and role=${role}`;
    if (!v) fail('verification_assignment_required');
  };
  const load = (
    tx: Tx,
    task: RuntimeTaskRef,
    source: Ref,
    author?: string,
    latest = true,
  ) => o.artifact(tx, task, source, storage, author, latest);
  // Independent means neither root author, nor ANY accepted contributor to the
  // cumulative head. A later merge cannot launder an earlier author's identity.
  const independent = async (tx: Tx, runId: string) => {
    if (runId === input.rootRunId) fail('independent_reviewer_required');
    const [author] = await tx`select 1 from allrice_development_merges m
      join allrice_development_merge_sources s on s.request_id=m.request_id
      join allrice_development_proposals p on p.artifact_id=s.artifact_id
      join allrice_development_assignments a on a.id=p.assignment_id
      where m.root_run_id=${input.rootRunId} and a.run_id=${runId} limit 1`;
    if (author) fail('independent_reviewer_required');
  };
  async function testEvidence(
    tx: Tx,
    source: Ref,
    operationId: string,
    requireSuccess: boolean,
  ) {
    const [row] = await tx<{ snapshot: unknown; bridge_payload: unknown }[]>`
      select snapshot,bridge_payload from allrice_runtime_operations
      where id=${operationId} and root_run_id=${input.rootRunId}
        and organization_id=${input.scope.organizationId} and workspace_id=${input.scope.workspaceId} for share`;
    if (!row) return fail('test_evidence_required');
    const op = RuntimeOperationSnapshotSchema.parse(row.snapshot);
    const command = RuntimeLocalCommandSchema.parse(row.bridge_payload);
    const candidate = command.arguments.candidate;
    if (
      !op.agentInstanceId ||
      !candidate ||
      candidate.artifactId !== source.artifactId ||
      candidate.checksum !== source.digest ||
      op.binding.action !== 'local.process.execute' ||
      !['succeeded', 'failed'].includes(op.status)
    )
      fail('test_evidence_required');
    await assigned(tx, source, 'test', op.agentInstanceId!);
    await admit(tx, op.agentInstanceId!, true);
    const [receipt] = await tx<
      { output: unknown }[]
    >`select payload->'evidence'->'output' as output
      from allrice_runtime_operation_receipts where operation_id=${operationId} and disposition='applied'
        and payload->'signal'->>'type'='operation.outcome'
        and payload->'signal'->'result'->'evidence'->>'id'=${op.result?.evidence.id ?? null}
      order by received_at desc limit 1`;
    const result = RuntimeLocalCommandResultSchema.safeParse(receipt?.output);
    if (
      !result.success ||
      !runtimeContractEqual(
        result.data.candidate,
        localCommandCandidateEvidence(command),
      ) ||
      result.data.imageDigest !== command.arguments.imageDigest ||
      (requireSuccess &&
        (op.status !== 'succeeded' ||
          result.data.exitCode !== 0 ||
          result.data.reason !== 'exited'))
    )
      fail('test_evidence_required');
    return {
      testerRunId: op.agentInstanceId!,
      operationId,
      status: op.status,
      result: result.data,
    };
  }
  async function publication(tx: Tx) {
    const task = await admit(tx);
    if (
      input.context.policySnapshot.subjectId !== input.context.delegatedBy.id ||
      task.chatSessionId === null
    )
      fail('forbidden');
    if (args.action === 'publish') {
      const claim = await o.assignment(tx, input.rootRunId, args.assignmentId);
      if (claim.run_id !== input.runId || claim.released_at) fail('forbidden');
      const base = await load(
        tx,
        task,
        { artifactId: claim.base_artifact_id, digest: claim.base_digest },
        input.rootRunId,
        false,
      );
      const side = (text: string | null) =>
        text === null ? null : { text, checksum: hash(text) };
      const document: ChangesetDocument = {
        ...base.document,
        execution: claim.execution,
        files: args.proposal.files.map((f) => ({
          path: f.path,
          before: side(f.before),
          after: side(f.after),
        })),
      };
      if (document.files.some((f) => !claim.paths.includes(f.path)))
        fail('scope_mismatch');
      composeDevelopmentChangesets(base.document, [document]);
      const [existing] =
        await tx`select version_id from allrice_workbench_artifacts where run_id=${input.runId}
        and request_id=${`development:${input.requestId}`} and organization_id=${input.scope.organizationId} and workspace_id=${input.scope.workspaceId}`;
      let parent: WorkbenchArtifact | undefined;
      if (args.previous) {
        const [p] =
          await tx`select artifact_id from allrice_development_proposals where artifact_id=${args.previous.artifactId}
          and root_run_id=${input.rootRunId} and assignment_id=${claim.id} and digest=${args.previous.digest}`;
        if (!p) fail('proposal_mismatch');
        parent = (await load(tx, task, args.previous, input.runId, !existing))
          .value;
      } else if (!existing) {
        const [p] =
          await tx`select artifact_id from allrice_development_proposals where assignment_id=${claim.id} limit 1`;
        if (p) fail('previous_version_required');
      }
      return { task, document, parentObjectId: parent?.object.id };
    }
    if (args.action !== 'merge') return fail('invalid_action');
    rootOnly();
    await current(tx, args.expectedHead);
    const base = await load(
      tx,
      task,
      args.expectedHead,
      input.rootRunId,
      false,
    );
    const documents: ChangesetDocument[] = [];
    const claims = new Set<string>();
    for (const source of args.proposals) {
      const [p] = await tx<
        { assignment_id: string }[]
      >`select assignment_id from allrice_development_proposals p
        where artifact_id=${source.artifactId} and root_run_id=${input.rootRunId} and digest=${source.digest}
        and not exists(select 1 from allrice_development_merge_sources s where s.artifact_id=p.artifact_id)`;
      if (!p || claims.has(p.assignment_id)) fail('proposal_mismatch');
      const claim = await o.assignment(tx, input.rootRunId, p.assignment_id);
      if (claim.released_at) fail('proposal_mismatch');
      await admit(tx, claim.run_id, true);
      documents.push((await load(tx, task, source, claim.run_id)).document);
      claims.add(claim.id);
    }
    // A rejected publication may be newer than the adopted head. Start the
    // content from the authoritative head, but append to the actual series tip.
    const [published] = await tx<
      { parent_object_id: string }[]
    >`select p.object_id as parent_object_id from allrice_workbench_artifacts a
      join allrice_deliverable_versions v on v.id=a.version_id join allrice_deliverable_versions p on p.id=v.parent_version_id
      where a.run_id=${input.runId} and a.request_id=${`development:${input.requestId}`} and a.organization_id=${input.scope.organizationId} and a.workspace_id=${input.scope.workspaceId}`;
    const latest = base.value.stale
      ? await load(
          tx,
          task,
          {
            artifactId: base.value.latestVersionId,
            digest: (
              await tx<
                { checksum: string }[]
              >`select o.checksum from allrice_deliverable_versions v join allrice_storage_objects o on o.id=v.object_id where v.id=${base.value.latestVersionId}`
            )[0]!.checksum,
          },
          input.rootRunId,
        )
      : base;
    return {
      task,
      document: composeDevelopmentChangesets(base.document, documents),
      parentObjectId: published?.parent_object_id ?? latest.value.object.id,
    };
  }
  if (args.action === 'initialize') {
    await o.database.begin((tx) => admit(tx));
    return o.core.initialize({ ...input, seed: args.seed }, storage);
  }
  if (args.action === 'assign') {
    if (args.role === 'edit') {
      if (!args.paths) fail('scope_required');
      const h = await assignmentTransaction(async (tx) => {
        await admit(tx);
        return current(tx, args.expectedHead);
      });
      return o.core.assign(
        {
          ...input,
          assignmentId: input.requestId,
          ownerRunId: args.ownerRunId,
          expectedHead: args.expectedHead,
          paths: args.paths!,
          execution: {
            ...h.execution,
            workCopy: { id: input.requestId, kind: 'local_copy' },
          },
        },
        transaction,
      );
    }
    rootOnly();
    if (args.paths) fail('invalid_action');
    return assignmentTransaction(async (tx) => {
      const task = await admit(tx);
      await current(tx, args.expectedHead);
      await load(tx, task, args.expectedHead, input.rootRunId);
      const owner = await admit(tx, args.ownerRunId);
      if (owner.parentRunId !== input.rootRunId) fail('forbidden');
      if (args.role === 'review') await independent(tx, args.ownerRunId);
      const [old] =
        await tx`select * from allrice_development_verifiers where id=${input.requestId}`;
      if (
        old &&
        (old.root_run_id !== input.rootRunId ||
          old.run_id !== args.ownerRunId ||
          old.artifact_id !== args.expectedHead.artifactId ||
          old.digest !== args.expectedHead.digest ||
          old.role !== args.role)
      )
        fail('conflict');
      if (!old)
        await tx`insert into allrice_development_verifiers(id,root_run_id,run_id,artifact_id,digest,role)
        values(${input.requestId},${input.rootRunId},${args.ownerRunId},${args.expectedHead.artifactId},${args.expectedHead.digest},${args.role}) on conflict(root_run_id,run_id,artifact_id,role) do nothing`;
      await admit(tx);
      return { assigned: true, role: args.role, candidate: args.expectedHead };
    });
  }
  if (args.action === 'inspect')
    return o.database.begin(async (tx) => {
      const task = await admit(tx);
      if (args.assignmentId) {
        if (args.candidate) fail('invalid_action');
        const claim = await o.assignment(
          tx,
          input.rootRunId,
          args.assignmentId,
        );
        if (
          claim.released_at ||
          (claim.run_id !== input.runId && input.runId !== input.rootRunId)
        )
          fail('forbidden');
        const base = await load(
          tx,
          task,
          { artifactId: claim.base_artifact_id, digest: claim.base_digest },
          input.rootRunId,
          false,
        );
        return {
          assignmentId: claim.id,
          paths: claim.paths,
          base: {
            artifactId: claim.base_artifact_id,
            digest: claim.base_digest,
          },
          files: base.document.files.filter((f) =>
            claim.paths.includes(f.path),
          ),
        };
      }
      const source = args.candidate ?? ref(await o.head(tx, input.rootRunId));
      await current(tx, source);
      if (input.runId !== input.rootRunId) {
        const [v] =
          await tx`select id from allrice_development_verifiers where root_run_id=${input.rootRunId} and run_id=${input.runId}
        and artifact_id=${source.artifactId} and digest=${source.digest}`;
        if (!v) fail('verification_assignment_required');
      }
      const a = await load(tx, task, source, input.rootRunId);
      const tests = await tx<
        {
          id: string;
          agent: string;
          status: string;
          command: unknown;
          output: unknown;
        }[]
      >`
        select op.id,op.initial_snapshot->>'agentInstanceId' as agent,op.snapshot->>'status' as status,
          jsonb_build_object('executable',op.bridge_payload->'arguments'->'executable','args',op.bridge_payload->'arguments'->'args') as command,
          receipt.payload->'evidence'->'output' as output
        from allrice_runtime_operations op
        join allrice_development_verifiers v on v.run_id::text=op.initial_snapshot->>'agentInstanceId'
          and v.root_run_id=op.root_run_id and v.artifact_id=${source.artifactId} and v.digest=${source.digest} and v.role='test'
        left join lateral (select payload from allrice_runtime_operation_receipts r where r.operation_id=op.id and disposition='applied'
          and payload->'signal'->>'type'='operation.outcome' order by received_at desc limit 1) receipt on true
        where op.root_run_id=${input.rootRunId} and op.organization_id=${input.scope.organizationId} and op.workspace_id=${input.scope.workspaceId}
          and op.bridge_payload->'arguments'->'candidate'->>'artifactId'=${source.artifactId}
          and op.bridge_payload->'arguments'->'candidate'->>'checksum'=${source.digest}
        order by op.created_at desc,op.id limit 8`;
      return {
        candidate: source,
        document: a.document,
        baselineFiles: a.document.files
          .filter((f) => f.before)
          .map((f) => ({ path: f.path, sha256: f.before!.checksum })),
        tests: tests.map((t) => {
          const parsed = RuntimeLocalCommandResultSchema.safeParse(t.output);
          return {
            operationId: t.id,
            testerRunId: t.agent,
            status: t.status,
            command: t.command,
            result: parsed.success
              ? {
                  ...parsed.data,
                  stdout: parsed.data.stdout.slice(0, 4000),
                  stderr: parsed.data.stderr.slice(0, 4000),
                  truncated:
                    parsed.data.truncated ||
                    parsed.data.stdout.length > 4000 ||
                    parsed.data.stderr.length > 4000,
                }
              : null,
          };
        }),
        reviews:
          await tx`select id,reviewer_run_id,operation_id,verdict,summary from allrice_development_reviews where root_run_id=${input.rootRunId} and artifact_id=${source.artifactId} order by created_at,id`,
      };
    });
  if (args.action === 'publish' || args.action === 'merge') {
    if (args.action === 'merge') {
      rootOnly();
      const old = await o.database.begin(async (tx) => {
        await admit(tx);
        return tx<
          { result_artifact_id: string; result_digest: string }[]
        >`select result_artifact_id,result_digest from allrice_development_merges where request_id=${input.requestId} and root_run_id=${input.rootRunId}`;
      });
      if (old[0])
        return o.core.merge(
          {
            ...input,
            requestId: input.requestId,
            expectedHead: args.expectedHead,
            proposals: args.proposals,
            result: {
              artifactId: old[0].result_artifact_id,
              digest: old[0].result_digest,
            },
          },
          storage,
        );
    }
    const prepared = await o.database.begin(publication);
    const bytes = Buffer.from(JSON.stringify(prepared.document));
    parseChangesetBytes(bytes);
    const value = await publishWorkbenchArtifact(
      {
        context: input.context,
        sessionId: prepared.task.chatSessionId!,
        callId: `development:${input.requestId}`,
        kind: 'changeset',
        fileName: 'development-candidate.json',
        format: 'json',
        mediaType: 'application/json',
        bytes,
        ...(prepared.parentObjectId
          ? { parentObjectId: prepared.parentObjectId }
          : {}),
        changeSummary:
          args.action === 'merge'
            ? '协作合成候选；尚未完成同版本测试与独立审查。'
            : '子助手修改提案；尚未采用或写入本地。',
      },
      storage,
      o.database,
      {
        runId: input.runId,
        admit: async (tx) => {
          const fresh = await publication(tx);
          if (!runtimeContractEqual(fresh.document, prepared.document))
            fail('head_conflict');
        },
      },
    );
    const source = { artifactId: value.id, digest: value.object.checksum! };
    if (args.action === 'publish')
      return o.core.propose(
        { ...input, assignmentId: args.assignmentId, proposal: source },
        storage,
      );
    return o.core.merge(
      {
        ...input,
        requestId: input.requestId,
        expectedHead: args.expectedHead,
        proposals: args.proposals,
        result: source,
      },
      storage,
    );
  }
  const verify = async (tx: Tx) => {
    const task = await admit(tx);
    await current(tx, args.candidate);
    await load(tx, task, args.candidate, input.rootRunId);
    if (args.action === 'review') {
      await assigned(tx, args.candidate, 'review');
      await independent(tx, input.runId);
      const test = await testEvidence(
        tx,
        args.candidate,
        args.operationId,
        args.verdict === 'accept',
      );
      if (test.testerRunId === input.runId)
        fail('independent_reviewer_required');
      const [old] =
        await tx`select * from allrice_development_reviews where id=${input.requestId}`;
      if (
        old &&
        (old.root_run_id !== input.rootRunId ||
          old.reviewer_run_id !== input.runId ||
          old.artifact_id !== args.candidate.artifactId ||
          old.digest !== args.candidate.digest ||
          old.operation_id !== args.operationId ||
          old.verdict !== args.verdict ||
          old.summary !== args.summary)
      )
        fail('conflict');
      if (!old)
        await tx`insert into allrice_development_reviews(id,root_run_id,reviewer_run_id,artifact_id,digest,operation_id,verdict,summary)
        values(${input.requestId},${input.rootRunId},${input.runId},${args.candidate.artifactId},${args.candidate.digest},${args.operationId},${args.verdict},${args.summary})`;
      await admit(tx);
      return {
        reviewId: input.requestId,
        reviewerRunId: input.runId,
        candidate: args.candidate,
        verdict: args.verdict,
        test,
        notice:
          'Review is an attributed assistant judgment, not a guarantee of correctness or filesystem approval.',
      };
    }
    rootOnly();
    const [review] = await tx<
      {
        reviewer_run_id: string;
        operation_id: string;
        verdict: string;
        summary: string;
      }[]
    >`
      select * from allrice_development_reviews where id=${args.reviewId} and root_run_id=${input.rootRunId}
        and artifact_id=${args.candidate.artifactId} and digest=${args.candidate.digest}`;
    if (!review || review.verdict !== 'accept')
      fail('accepted_review_required');
    // A rejection of this exact version is never silently outvoted by another
    // assistant. Correct the version and obtain fresh test/review evidence.
    const [rejected] =
      await tx`select id from allrice_development_reviews where root_run_id=${input.rootRunId} and artifact_id=${args.candidate.artifactId} and verdict='revise' limit 1`;
    if (rejected) fail('revision_required');
    await admit(tx, review.reviewer_run_id, true);
    await independent(tx, review.reviewer_run_id);
    const test = await testEvidence(
      tx,
      args.candidate,
      review.operation_id,
      true,
    );
    if (test.testerRunId === review.reviewer_run_id)
      fail('independent_reviewer_required');
    await admit(tx);
    return {
      candidate: args.candidate,
      verification: 'tested_and_reviewed',
      test,
      review: {
        id: args.reviewId,
        runId: review.reviewer_run_id,
        summary: review.summary,
      },
      applied: false,
      notice:
        'Only this exact candidate is tested/reviewed. Local application still requires its own approval and baseline check.',
    };
  };
  const result = await o.database.begin(verify);
  // Review and final delivery are visible in the existing Artifact workbench,
  // with exact references and explicit provenance, not a new hidden ledger.
  const artifact = await publishWorkbenchArtifact(
    {
      context: input.context,
      sessionId: (await o.database.begin((tx) => admit(tx))).chatSessionId!,
      callId: `development-${args.action}:${input.requestId}`,
      kind: 'document',
      fileName: `development-${args.action}.json`,
      format: 'json',
      mediaType: 'application/json',
      bytes: Buffer.from(JSON.stringify(result, null, 2)),
      changeSummary:
        args.action === 'review'
          ? '独立助手审查意见；含准确候选与实际测试回执引用。'
          : '主 Rice 同版本测试/审查交付记录；不代表已写入本地目录。',
    },
    storage,
    o.database,
    {
      runId: input.runId,
      admit: async (tx) => {
        await verify(tx);
      },
      registered:
        args.action === 'deliver'
          ? async (tx, artifactId) => {
              await tx`insert into allrice_development_deliveries(artifact_id,root_run_id,candidate_id,digest,review_id)
          values(${artifactId},${input.rootRunId},${args.candidate.artifactId},${args.candidate.digest},${args.reviewId})`;
            }
          : undefined,
    },
  );
  return {
    ...result,
    artifact: { artifactId: artifact.id, digest: artifact.object.checksum! },
  };
}
