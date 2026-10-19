import type postgres from 'postgres';
import { z } from 'zod';
import {
  ChecksumSchema,
  ReferenceSelectionsSchema,
  RuntimeTaskRefSchema,
  UuidSchema,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import { assertWorkbenchSession, readArtifact } from './artifact-review.ts';
import { assertReferenceSelections } from './reference-runtime.ts';
import { businessDeliverablePredicate } from './organization-dashboard.ts';
import {
  finalDeliveryRootIsLocked,
  finalDeliveryUnavailable,
} from './final-delivery-commit.ts';

const originSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    version: z.number().int().positive(),
    checksum: ChecksumSchema,
    sessionId: UuidSchema,
    runId: UuidSchema.optional(),
  })
  .strict();
type Identity = Readonly<{
  objectId: string;
  versionId: string;
  checksum: string;
}>;
type Pin = {
  versionId: string;
  checksum: string;
  reviewKind?: 'plan_review' | 'version_feedback';
  origin?: z.infer<typeof originSchema>;
};

/** @internal Host-selected producer. Called at BOTH ends of the checked
 * reader, inside its existing root/Job/current-authority transaction. It never
 * opens a transaction, grants access, emits read receipts or guesses an ID.
 * Only immutable current-Run review input and frozen Knowledge revision pins
 * are covered. Other input surfaces require their own authorized producer.
 */
export async function readFinalDeliveryReferences(input: {
  transaction: postgres.TransactionSql;
  task: RuntimeTaskRef;
}): Promise<readonly Identity[]> {
  const tx = input.transaction;
  const task = RuntimeTaskRefSchema.parse(input.task);
  if (
    task.runId !== task.rootRunId ||
    task.parentRunId !== null ||
    !task.chatSessionId ||
    !finalDeliveryRootIsLocked(tx, task.rootRunId)
  )
    return finalDeliveryUnavailable();
  const [root] = await tx<
    { owner_id: string; session_id: string; prompt_snapshot: unknown }[]
  >`select r.owner_id,e.session_id,e.prompt_snapshot from allrice_runs r
    join allrice_employee_runs e on e.run_id=r.id and e.organization_id=r.organization_id
      and e.workspace_id=r.workspace_id and e.owner_id=r.owner_id
    where r.id=${task.rootRunId} and r.organization_id=${task.scope.organizationId}
      and r.workspace_id=${task.scope.workspaceId} and r.state='running'
      and e.session_id=${task.chatSessionId} for share of r,e`;
  if (!root) return finalDeliveryUnavailable();
  const principal = {
    actor: { type: 'user' as const, id: root.owner_id },
    organizationId: task.scope.organizationId,
    workspaceId: task.scope.workspaceId,
  };
  const prompt = root.prompt_snapshot;
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt))
    return finalDeliveryUnavailable();
  // Missing is legacy empty input; explicit null or malformed is NOT empty.
  const raw = Object.hasOwn(prompt, 'referenceSelections')
    ? (prompt as Record<string, unknown>).referenceSelections
    : [];
  const parsed = ReferenceSelectionsSchema.safeParse(raw);
  if (
    !parsed.success ||
    new Set(parsed.data.map((s) => s.revisionId.toLowerCase())).size !==
      parsed.data.length
  )
    return finalDeliveryUnavailable();

  const pins: Pin[] = [];
  // The production writer inserts this alongside a newly created Run, before
  // that Run can be leased/configured. The receipt is UPDATE/DELETE immutable.
  // No Session/history scan or latest-version assertion is made at completion.
  const reviews = await tx<
    {
      organization_id: string;
      workspace_id: string;
      session_id: string;
      actor_id: string;
      artifact_id: string;
      checksum: string;
      kind: 'plan_review' | 'version_feedback';
      feedback_id: string | null;
    }[]
  >`select organization_id,workspace_id,session_id,actor_id,artifact_id,checksum,kind,feedback_id
    from allrice_review_continuations where run_id=${task.rootRunId}
    order by response_id limit 2 for share`;
  if (reviews.length > 1) return finalDeliveryUnavailable();
  for (const review of reviews) {
    if (
      review.organization_id !== principal.organizationId ||
      review.workspace_id !== principal.workspaceId ||
      review.session_id !== root.session_id ||
      review.actor_id !== root.owner_id
    )
      return finalDeliveryUnavailable();
    if (review.kind === 'version_feedback') {
      const [feedback] = await tx`select id from allrice_artifact_feedback
        where id=${review.feedback_id} and organization_id=${principal.organizationId}
          and workspace_id=${principal.workspaceId} and actor_id=${root.owner_id}
          and artifact_id=${review.artifact_id} and checksum=${review.checksum}
          and state in ('submitted','addressed') for share`;
      if (!feedback) return finalDeliveryUnavailable();
    } else if (review.kind !== 'plan_review' || review.feedback_id !== null)
      return finalDeliveryUnavailable();
    pins.push({
      versionId: UuidSchema.parse(review.artifact_id),
      checksum: ChecksumSchema.parse(review.checksum),
      reviewKind: review.kind,
    });
  }

  // Uses the existing same-tx principal/source/legacy publication/revision/
  // processing/copy ACL and SHARE locks. The immutable pin is not permission.
  await assertReferenceSelections(principal, parsed.data, tx, true);
  for (const selection of [...parsed.data].sort((a, b) =>
    a.revisionId.localeCompare(b.revisionId),
  )) {
    const [revision] = await tx<
      {
        source_artifact_version_id: string | null;
        source_target_key: string | null;
        artifact_snapshot: unknown;
        copy_id: string;
        copy_checksum: string;
        retention_until: Date | null;
      }[]
    >`select r.source_artifact_version_id,r.source_target_key,r.artifact_snapshot,
      o.id copy_id,o.checksum copy_checksum,o.retention_until
      from allrice_knowledge_revisions r join allrice_storage_objects o on o.id=r.file_object_id
      where r.id=${selection.revisionId} and r.knowledge_source_id=${selection.sourceId}
        and r.status='published' and o.state='ready' and o.immutable and o.deleted_at is null
      for share of r,o`;
    // Production retained reference copies have no expiry. Reject unsupported
    // timed copies rather than introduce a deadline invisible to the frozen
    // queue guard's final post-SQL deadline check. All other revocations are
    // excluded by the existing locks through commit.
    if (
      !revision ||
      revision.copy_checksum !== selection.checksum ||
      revision.retention_until !== null
    )
      return finalDeliveryUnavailable();
    if (revision.source_artifact_version_id === null) {
      if (
        revision.source_target_key !== null ||
        revision.artifact_snapshot !== null
      )
        return finalDeliveryUnavailable();
      continue; // Ordinary uploaded input is valid, not a deliverable.
    }
    const frozen = originSchema.safeParse(revision.artifact_snapshot);
    const ownership = selection.ownership;
    const targetKey =
      ownership.scope === 'personal'
        ? 'personal:' + ownership.ownerId
        : ownership.scope === 'department'
          ? 'department:' + ownership.departmentId
          : ownership.scope === 'company'
            ? 'company:' + ownership.organizationId
            : null;
    if (
      !frozen.success ||
      !targetKey ||
      revision.source_target_key !== targetKey ||
      frozen.data.checksum !== selection.checksum
    )
      return finalDeliveryUnavailable();
    const [source] = await tx<
      {
        organization_id: string;
        workspace_id: string;
        owner_id: string;
        session_id: string | null;
        object_id: string;
        checksum: string;
        version: number;
        file_name: string;
        run_id: string | null;
      }[]
    >`select dv.organization_id,dv.workspace_id,dv.owner_id,dv.session_id,dv.object_id,
      dv.version,dv.file_name,o.checksum,a.run_id from allrice_deliverable_versions dv
      join allrice_storage_objects o on o.id=dv.object_id and o.organization_id=dv.organization_id
        and o.workspace_id=dv.workspace_id and o.owner_id=dv.owner_id
      left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id
        and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
      where dv.id=${UuidSchema.parse(revision.source_artifact_version_id)}`;
    // Validate the immutable source mapping even when it will remain foreign
    // input only. This exact metadata lookup is not original-file permission:
    // it neither reads bytes nor checks/changes foreign availability or ACL.
    if (
      !source ||
      source.session_id !== frozen.data.sessionId ||
      source.version !== frozen.data.version ||
      source.file_name !== frozen.data.fileName ||
      source.checksum !== frozen.data.checksum ||
      source.object_id === revision.copy_id ||
      (frozen.data.runId !== undefined && source.run_id !== frozen.data.runId)
    )
      return finalDeliveryUnavailable();
    // A readable Knowledge copy does not grant the uploader's original-file
    // access. Legitimate foreign inputs remain inputs and are never returned.
    if (
      source.organization_id !== principal.organizationId ||
      source.workspace_id !== principal.workspaceId ||
      source.owner_id !== root.owner_id ||
      source.session_id !== root.session_id
    )
      continue;
    pins.push({
      versionId: revision.source_artifact_version_id,
      checksum: selection.checksum,
      origin: frozen.data,
    });
  }

  await assertWorkbenchSession(tx, principal, root.session_id, true, 'share');
  const identities = new Map<string, Identity>();
  for (const pin of pins.sort((a, b) =>
    a.versionId.localeCompare(b.versionId),
  )) {
    const [valid] = await tx<{ object_id: string; checksum: string }[]>`
      select dv.object_id,o.checksum from allrice_deliverable_versions dv
      join allrice_storage_objects o on o.id=dv.object_id and o.organization_id=dv.organization_id
        and o.workspace_id=dv.workspace_id and o.owner_id=dv.owner_id
      left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id
        and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
      where dv.id=${pin.versionId} and dv.organization_id=${principal.organizationId}
        and dv.workspace_id=${principal.workspaceId} and dv.owner_id=${root.owner_id}
        and dv.session_id=${root.session_id} and dv.platform_test_run_id is null
        and o.state='ready' and o.immutable and o.deleted_at is null
        and (o.retention_until is null or o.retention_until>clock_timestamp())
        and ${businessDeliverablePredicate(tx)}
        and exists(select 1 from allrice_employee_runs er where er.organization_id=dv.organization_id
          and er.workspace_id=dv.workspace_id and er.owner_id=dv.owner_id and er.session_id=dv.session_id
          and (a.run_id is null or a.run_id=er.run_id)
          and not exists(select 1 from allrice_assistant_instances ai where ai.run_id=er.run_id and ai.run_id<>ai.root_run_id))
      for share of dv,o`;
    if (!valid || valid.checksum !== pin.checksum)
      return finalDeliveryUnavailable();
    const artifact = await readArtifact(
      tx,
      principal,
      root.session_id,
      pin.versionId,
    );
    if (
      artifact.object.id !== valid.object_id ||
      artifact.object.checksum !== pin.checksum ||
      (pin.reviewKind === 'plan_review' && artifact.kind !== 'plan') ||
      (pin.origin &&
        (artifact.version.version !== pin.origin.version ||
          artifact.version.fileName !== pin.origin.fileName ||
          (pin.origin.runId !== undefined &&
            artifact.provenance.runId !== pin.origin.runId)))
    )
      return finalDeliveryUnavailable();
    const identity = {
      objectId: valid.object_id,
      versionId: pin.versionId,
      checksum: pin.checksum,
    };
    const prior = identities.get(pin.versionId);
    if (
      prior &&
      (prior.objectId !== identity.objectId ||
        prior.checksum !== identity.checksum)
    )
      return finalDeliveryUnavailable();
    identities.set(pin.versionId, Object.freeze(identity));
  }
  return Object.freeze([...identities.values()]);
}
