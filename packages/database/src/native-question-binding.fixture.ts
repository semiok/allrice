import type postgres from 'postgres';
import {
  acquireConversationRuntime,
  bindConversationThread,
} from './conversation/conversation-runtime.ts';
import { nativeBindingDescriptor } from './native-session-binding.fixture.ts';

/** Synthetic Host identity for isolated SQL projection tests. The full employee
 * Worker regression separately exercises the real approved native binder. */
export async function bindNativeQuestionFixture(
  db: ReturnType<typeof postgres>,
  runId: string,
  nativeSessionId?: string,
) {
  const [scope] = await db`select current_schema() name`;
  if (!/^p25_[a-f0-9]+$/.test(scope!.name))
    throw Error('isolated schema required');
  const [e] =
    await db`select e.*,j.id job_id,j.worker_id,greatest(j.attempt,1) attempt
    from allrice_employee_runs e join allrice_jobs j on j.run_id=e.run_id where e.run_id=${runId}`;
  const ownership = {
    organizationId: e!.organization_id,
    workspaceId: e!.workspace_id,
    ownerId: e!.owner_id,
    sessionId: e!.session_id,
    runId,
    workerId: e!.worker_id,
  };
  const [current] =
    await db`select config_checksum from allrice_conversation_runtimes where session_id=${e!.session_id}`;
  await acquireConversationRuntime({
    ...ownership,
    configChecksum: current?.config_checksum ?? `sha256:${'a'.repeat(64)}`,
    compactThresholdTokens: 10000,
  });
  const d = nativeBindingDescriptor({
    ...ownership,
    contextKey: e!.session_id,
  });
  const threadId = nativeSessionId ?? d.nativeSessionId;
  await bindConversationThread({ ...ownership, threadId });
  await db`insert into allrice_native_session_bindings
    (native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
      storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,
      first_run_id,first_job_id,first_attempt,binding_basis,root_origin_digest)
    values(${threadId},${e!.organization_id},${e!.workspace_id},${e!.owner_id},'chat',${e!.session_id},
      ${d.storageContextKey},${d.storageNamespace},${d.artifactId},${d.artifactManifestDigest},${d.distributionGeneration},${d.profileId},
      ${runId},${e!.job_id},${e!.attempt},'business_root_origin',${`sha256:${'a'.repeat(64)}`})
    on conflict(native_session_id) do nothing`;
}
