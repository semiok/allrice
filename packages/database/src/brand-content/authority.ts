import type {
  BrandContentScope,
  BrandContentFileRef,
  BrandContentVersionRef,
  BrandContentImage,
} from '@allrice/contracts';
import { getStoredFile } from '../data.ts';
import { readContentPrincipal } from '../content-maintenance.ts';
import { getEmployeeInstance } from '../employees/employee-instances.ts';
import { assertWorkbenchSession, readArtifact } from '../artifact-review.ts';
import { brandContentFail as fail } from './rules.ts';
import type {
  Scope,
  Tx,
  BrandContentAuthority,
  BrandContentIdentity,
} from './types.ts';

export async function requireBrandContentScope(
  tx: Tx,
  context: BrandContentIdentity,
  input: BrandContentScope,
  write: boolean,
  authority: BrandContentAuthority = 'user',
  lock = true,
): Promise<Scope> {
  if (
    context.actor.type !== 'user' ||
    (authority === 'user' && !context.sessionId) ||
    (context.workspaceId && context.workspaceId !== input.workspaceId)
  )
    fail('authority_denied');
  const scoped = { ...context, workspaceId: input.workspaceId };
  // Internal callers first admit their real Run/lease (or scheduler occurrence).
  // A continuing job does not borrow or require an active browser login token.
  const identity =
    authority === 'user' ? scoped : { ...scoped, sessionId: undefined };
  const principal = await readContentPrincipal(identity, tx, lock);
  if (!principal || (write && !principal.writable)) fail('authority_denied');
  const instance = await getEmployeeInstance(identity, input.instanceId, tx);
  const [assignment] = await tx`select a.id from allrice_employee_assignments a
    join allrice_employee_instances i on i.assignment_id=a.id
    where a.id=${instance.assignmentId} and i.id=${input.instanceId}
      and a.organization_id=${context.organizationId} and a.workspace_id=${input.workspaceId}
      and a.user_id=${context.actor.id} and i.owner_id=${context.actor.id} and a.active
      and i.archived_at is null ${lock ? tx`for share of a,i` : tx``}`;
  if (!assignment) fail('authority_denied');
  return {
    organizationId: context.organizationId,
    workspaceId: input.workspaceId,
    ownerId: context.actor.id,
    instanceId: input.instanceId,
  };
}
export function brandContentPrincipal(
  context: BrandContentIdentity,
  scope: Scope,
) {
  return { ...context, workspaceId: scope.workspaceId };
}
export async function assertBrandContentSession(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  sessionId: string,
  write = false,
  lock = true,
) {
  await assertWorkbenchSession(
    tx,
    brandContentPrincipal(context, scope),
    sessionId,
    write,
    lock ? 'share' : false,
  );
  const [session] = await tx`select id from allrice_chat_sessions
    where id=${sessionId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and coalesce(employee_instance_id,employee_assignment_id)=${scope.instanceId}`;
  if (!session) fail('source_unavailable');
}
/** Use existing file and artifact readers, then narrow to this private owner
 * and instance. A company snapshot is never a shortcut into private files. */
export async function assertBrandContentFile(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  file: BrandContentFileRef,
  image = false,
  lock = true,
) {
  const [locked] = await tx`select id from allrice_storage_objects
    where id=${file.objectId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and state='ready' and deleted_at is null
      and (retention_until is null or retention_until>clock_timestamp()) ${lock ? tx`for share` : tx``}`;
  if (!locked) fail('source_unavailable');
  const stored = await getStoredFile(
    brandContentPrincipal(context, scope),
    file.objectId,
    tx,
  );
  if (
    stored.object.ownerId !== scope.ownerId ||
    stored.object.workspaceId !== scope.workspaceId
  )
    fail('source_unavailable');
  if (stored.object.checksum !== file.checksum) fail('source_changed');
  if (
    image &&
    !['image/png', 'image/jpeg', 'image/webp'].includes(stored.object.mediaType)
  )
    fail('source_reference_invalid');
  const [version] = await tx<
    {
      id: string;
      session_id: string | null;
      platform_test_run_id: string | null;
    }[]
  >`
    select id,session_id,platform_test_run_id from allrice_deliverable_versions
    where object_id=${file.objectId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} ${lock ? tx`for share` : tx``}`;
  if (version) {
    if (
      !version.session_id ||
      version.platform_test_run_id ||
      (file.versionId && version.id !== file.versionId)
    )
      fail('source_unavailable');
    await assertBrandContentSession(
      tx,
      context,
      scope,
      version.session_id,
      false,
      lock,
    );
    const artifact = await readArtifact(
      tx,
      brandContentPrincipal(context, scope),
      version.session_id,
      version.id,
    );
    if (
      artifact.object.id !== file.objectId ||
      artifact.object.checksum !== file.checksum ||
      !artifact.object.immutable ||
      artifact.provenance.kind === 'project_snapshot'
    )
      fail('source_unavailable');
  } else if (file.versionId || stored.category !== 'uploads')
    fail('source_unavailable');
  return stored;
}
export async function assertBrandContentDocument(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  sessionId: string,
  file: BrandContentVersionRef,
  requireLatest = false,
  lock = true,
) {
  await assertBrandContentSession(tx, context, scope, sessionId, false, lock);
  await assertBrandContentFile(tx, context, scope, file, false, lock);
  const artifact = await readArtifact(
    tx,
    brandContentPrincipal(context, scope),
    sessionId,
    file.versionId,
  );
  if (
    artifact.object.id !== file.objectId ||
    artifact.object.checksum !== file.checksum ||
    !artifact.object.immutable ||
    !['document', 'file'].includes(artifact.kind) ||
    !['markdown', 'text', 'html', 'json', 'docx', 'pdf'].includes(
      artifact.version.format,
    ) ||
    artifact.version.platformTestRunId ||
    (requireLatest && artifact.stale)
  )
    fail('source_unavailable');
  return artifact;
}
export async function assertBrandContentImages(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  images: BrandContentImage[],
  lock = true,
) {
  for (const image of images) {
    await assertBrandContentFile(tx, context, scope, image.file, true, lock);
    if (image.sourceKind === 'generated') {
      const [operation] = await tx<
        { result: { modelContent?: string }; session_id: string }[]
      >`
        select result,session_id from allrice_image_operations where id=${image.operationId!}
          and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
          and owner_id=${scope.ownerId} and status='succeeded' ${lock ? tx`for share` : tx``}`;
      if (!operation) fail('source_unavailable');
      await assertBrandContentSession(
        tx,
        context,
        scope,
        operation.session_id,
        false,
        lock,
      );
      let receipt: { objectId?: string; checksum?: string };
      try {
        receipt = JSON.parse(operation.result.modelContent ?? 'null');
      } catch {
        fail('source_unavailable');
      }
      if (
        !receipt ||
        receipt.objectId !== image.file.objectId ||
        receipt.checksum !== image.file.checksum
      )
        fail('source_changed');
    }
  }
}
