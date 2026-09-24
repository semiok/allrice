import { runtimeFeatureEnabled } from '@allrice/contracts';
import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  commandCandidateManifest,
  runtimeContractEqual,
  type RuntimeLocalCommand,
  type RuntimeExecutionScope,
} from '@allrice/contracts';
import {
  readArtifact,
  parseChangesetBytes,
  type WorkbenchPrincipal,
} from './artifact-review.ts';
import { RuntimePolicyError } from './runtime-policy.ts';

export function localCommandCandidateEvidence(command: RuntimeLocalCommand) {
  const candidate = command.arguments.candidate;
  if (!candidate) return undefined;
  return {
    artifactId: candidate.artifactId,
    checksum: candidate.checksum,
    inputDigest: `sha256:${createHash('sha256')
      .update(
        JSON.stringify(
          commandCandidateManifest(command.arguments.files, candidate.content),
        ),
      )
      .digest('hex')}`,
  };
}

/** Called after the session authority lock, before approval/dispatch/renewal.
 * Serializes with artifact publication without reversing its session lock order. */
export async function assertLocalCommandCandidate(
  tx: TransactionSql,
  principal: WorkbenchPrincipal,
  sessionId: string,
  command: RuntimeLocalCommand,
  execution: RuntimeExecutionScope,
  assistant?: { rootRunId: string; runId: string },
) {
  const candidate = command.arguments.candidate;
  if (!candidate) {
    if (assistant) {
      // Cold reconstruction and dispatch must reject old/unversioned tester
      // requests too. This check shares the existing session authority lock.
      const [assigned] = await tx`select id from allrice_development_verifiers
        where root_run_id=${assistant.rootRunId} and run_id=${assistant.runId} and role='test' limit 1`;
      if (assigned) throw new RuntimePolicyError('assistant_authority_changed');
    }
    return;
  }
  if (!runtimeFeatureEnabled('ALLRICE_WORKBENCH_ENABLED'))
    throw new RuntimePolicyError('bridge_authority_changed');
  const [version] = await tx`select v.id from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id
    where v.id=${candidate.artifactId} and v.organization_id=${principal.organizationId}
      and v.workspace_id=${principal.workspaceId!} and v.owner_id=${principal.actor.id}
      and v.session_id=${sessionId} for share of v,o`;
  if (!version) throw new RuntimePolicyError('bridge_authority_changed');
  if (assistant) {
    // Persisted exact-version task, not a model-supplied author/copy reference.
    // The existing operation authority separately checks actual tester lineage,
    // lease, tool rights and cancellation at approval/dispatch/renewal.
    const [assigned] = await tx`select v.id from allrice_development_verifiers v
      join allrice_development_heads h on h.root_run_id=v.root_run_id and h.head_artifact_id=v.artifact_id and h.head_digest=v.digest
      join allrice_workbench_artifacts a on a.version_id=v.artifact_id and a.run_id=h.root_run_id
      where v.root_run_id=${assistant.rootRunId} and v.run_id=${assistant.runId} and v.role='test'
        and v.artifact_id=${candidate.artifactId} and v.digest=${candidate.checksum}
        and a.organization_id=${principal.organizationId} and a.workspace_id=${principal.workspaceId!} and a.owner_id=${principal.actor.id}`;
    if (!assigned) throw new RuntimePolicyError('assistant_authority_changed');
  }
  // These are immutable bytes already read from scoped object storage. Validate
  // again on cold reconstruction; never trust an artifact ID beside other bytes.
  const bytes = Buffer.from(candidate.content);
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const document = parseChangesetBytes(bytes);
  const artifact = await readArtifact(
    tx,
    principal,
    sessionId,
    candidate.artifactId,
  );
  const target = {
    ...execution,
    workCopy: { id: execution.grantId, kind: 'in_place' },
  };
  if (
    artifact.kind !== 'changeset' ||
    artifact.stale ||
    !artifact.object.immutable ||
    checksum !== candidate.checksum ||
    artifact.object.checksum !== checksum ||
    artifact.object.sizeBytes !== bytes.length ||
    !runtimeContractEqual(artifact.execution, target) ||
    !runtimeContractEqual(document.execution, target)
  )
    throw new RuntimePolicyError('bridge_authority_changed');
  localCommandCandidateEvidence(command);
}
