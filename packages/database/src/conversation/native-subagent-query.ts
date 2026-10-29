import { posix } from 'node:path';
import { z } from 'zod';
import type { RequestContext } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { authorizeSessionOwner } from '../workspace/service.ts';
import {
  NativeSessionDescriptorSchema,
  readChatNativeRootOrigin,
} from './native-session-binding.ts';
import { nativeRootDigest } from './native-root-origin.ts';

/** Read authority only: no lease admission, binding repair or execution. */
export async function getSessionNativeSubagentTarget(
  context: RequestContext,
  workspaceId: string,
  sessionId: string,
) {
  const session = await authorizeSessionOwner(context, workspaceId, sessionId);
  const scope = {
    organizationId: context.organizationId,
    workspaceId: session.workspaceId,
    ownerId: session.ownerId,
    sessionId: session.id,
  };
  const db = getDatabase();
  const origin = await readChatNativeRootOrigin(db, scope);
  const [pin] = await db`
    select b.*,c.thread_generation from allrice_conversation_runtimes c
    join allrice_native_session_bindings b on b.native_session_id=c.thread_id
      and b.organization_id=c.organization_id and b.workspace_id=c.workspace_id
      and b.owner_id=c.owner_id and b.context_kind='chat' and b.context_id=c.session_id
    where c.session_id=${scope.sessionId} and c.organization_id=${scope.organizationId}
      and c.workspace_id=${scope.workspaceId} and c.owner_id=${scope.ownerId}`;
  if (!origin || !pin) throw Error('NATIVE_QUERY_BINDING_UNAVAILABLE');
  const descriptor = NativeSessionDescriptorSchema.parse({
    nativeSessionId: pin.native_session_id,
    artifactId: pin.artifact_id,
    artifactManifestDigest: pin.artifact_manifest_digest,
    distributionGeneration: pin.distribution_generation,
    profileId: pin.profile_id,
    storageContextKey: pin.storage_context_key,
    storageNamespace: pin.storage_namespace,
  });
  const rootOriginDigest = nativeRootDigest(origin);
  if (
    pin.binding_basis !== 'business_root_origin' ||
    pin.root_origin_digest !== rootOriginDigest ||
    descriptor.artifactId !== descriptor.artifactManifestDigest ||
    descriptor.distributionGeneration !== origin.distributionGeneration ||
    descriptor.profileId !== 'restricted' ||
    descriptor.storageContextKey !== scope.sessionId ||
    descriptor.storageNamespace.includes('\0') ||
    !posix.isAbsolute(descriptor.storageNamespace) ||
    posix.normalize(descriptor.storageNamespace) !==
      descriptor.storageNamespace ||
    !descriptor.storageNamespace.endsWith(
      `/${scope.organizationId}/${scope.workspaceId}/${scope.ownerId}/${scope.sessionId}/sessions`,
    )
  )
    throw Error('NATIVE_QUERY_BINDING_UNAVAILABLE');
  return {
    ...scope,
    generation: z.number().int().nonnegative().parse(pin.thread_generation),
    rootOriginDigest,
    descriptor,
  };
}
export type NativeSubagentQueryTarget = Awaited<
  ReturnType<typeof getSessionNativeSubagentTarget>
>;
