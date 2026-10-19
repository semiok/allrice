import { z } from 'zod';
import type postgres from 'postgres';
import { readChatNativeRootOrigin } from './conversation/native-session-binding.ts';
import { nativeRootDigest } from './conversation/native-root-origin.ts';

const artifactId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Deployment approval of exact, protocol-tested content IDs. This is a feature
 * rollout allowlist, not another artifact registry or permission to launch code.
 * Existing approved legacy selection still runs through the ordinary binder. */
export function checkedFinalDeliveryArtifacts(): readonly string[] {
  const raw = process.env.ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS;
  if (!raw) return [];
  const ids = z.array(artifactId).max(6).parse(JSON.parse(raw));
  if (new Set(ids).size !== ids.length)
    throw Error('FINAL_DELIVERY_APPROVAL_DUPLICATE');
  return ids;
}

/** Called inside the existing conversation admission transaction, before the
 * new Run snapshot is inserted. No live process inventory, version heuristic,
 * added root/Job lock, historical rewrite, or fallback after execution failure. */
export async function selectCheckedFinalDeliveryArtifact(
  tx: postgres.TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
  },
): Promise<string | undefined> {
  const approved = checkedFinalDeliveryArtifacts();
  if (!approved.length) return;
  const origin = await readChatNativeRootOrigin(tx, input);
  if (!origin) return; // Explicit old business birth, never current primary.
  const [conflict] = await tx`select 1 from allrice_native_session_bindings
    where context_kind='chat' and context_id=${input.sessionId} and (
      organization_id<>${input.organizationId} or workspace_id<>${input.workspaceId}
      or owner_id<>${input.ownerId} or storage_context_key<>${input.sessionId}
      or artifact_id<>${origin.artifactId} or artifact_manifest_digest<>${origin.artifactId}
      or distribution_generation<>${origin.distributionGeneration} or profile_id<>'restricted'
      or binding_basis<>'business_root_origin' or root_origin_digest is distinct from ${nativeRootDigest(origin)}) limit 1`;
  if (conflict) throw Error('FINAL_DELIVERY_NATIVE_ORIGIN_CONFLICT');
  // An older exact pin stays on its original protocol. Before any execution,
  // the existing binder/verified artifact registry must still approve its ID.
  return approved.includes(origin.artifactId) ? origin.artifactId : undefined;
}
