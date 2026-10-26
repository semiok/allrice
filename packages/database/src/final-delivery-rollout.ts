import type postgres from 'postgres';
import { readChatNativeRootOrigin } from './conversation/native-session-binding.ts';
import { nativeRootDigest } from './conversation/native-root-origin.ts';

/** Called inside the existing conversation admission transaction, before the
 * new Run snapshot is inserted. Checked final delivery is the protocol of every
 * release on the restricted profile, so an eligible chat with a business origin
 * always gets it. The frozen artifactId is the origin's, provenance only: any
 * same-generation primary executes it (MET-221). No live process inventory,
 * version heuristic, added root/Job lock, historical rewrite, or fallback after
 * execution failure. */
export async function selectCheckedFinalDeliveryArtifact(
  tx: postgres.TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
  },
): Promise<string | undefined> {
  await tx`select id from allrice_chat_sessions where id=${input.sessionId} and organization_id=${input.organizationId} and workspace_id=${input.workspaceId} and owner_id=${input.ownerId} for share`;
  const origin = await readChatNativeRootOrigin(tx, input);
  if (!origin) return; // Explicit old business birth, never current primary.
  // A pin's artifact is its first writer, which may be a later release than
  // the origin's; only scope, generation, profile and origin must agree.
  const [conflict] = await tx`select 1 from allrice_native_session_bindings
    where context_kind='chat' and context_id=${input.sessionId} and (
      organization_id<>${input.organizationId} or workspace_id<>${input.workspaceId}
      or owner_id<>${input.ownerId} or storage_context_key<>${input.sessionId}
      or distribution_generation<>${origin.distributionGeneration} or profile_id<>'restricted'
      or binding_basis<>'business_root_origin' or origin_reader_approval_digest is not null
      or root_origin_digest is distinct from ${nativeRootDigest(origin)}) limit 1`;
  if (conflict) throw Error('FINAL_DELIVERY_NATIVE_ORIGIN_CONFLICT');
  return origin.artifactId;
}
