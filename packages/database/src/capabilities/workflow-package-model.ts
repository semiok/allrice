import { createHash } from 'node:crypto';
import {
  WorkflowDefinitionSchema,
  WorkflowPackageManifestSchema,
  WorkflowPackageSourceSchema,
  workflowPackageLimits,
  type EmployeeContentReference,
  type EmployeeRuntimeContent,
  type StorageObject,
  type StoragePort,
  type WorkflowDefinition,
  type WorkflowPackageManifest,
  type WorkflowPackageSyncStatus,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { employeeRuntimeScenes } from '../employees/employee-runtime-scenes.ts';

export class WorkflowPackageError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'conflict'
      | 'source_changed'
      | 'source_unavailable'
      | 'source_verification_required'
      | 'invalid_package',
  ) {
    super(code);
  }
}

export const workflowPackageBytesChecksum = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function workflowPackageChecksum(input: {
  workflowChecksum: string;
  manifest: WorkflowPackageManifest;
}) {
  return runtimePolicyDigest(input);
}

export function validateWorkflowPackageDefinition(
  definitionInput: unknown,
  manifestInput: unknown,
) {
  const definition = WorkflowDefinitionSchema.parse(definitionInput);
  const manifest = WorkflowPackageManifestSchema.parse(manifestInput);
  if (runtimePolicyDigest(definition) !== manifest.definitionChecksum)
    throw new WorkflowPackageError('source_changed');
  return { definition, manifest };
}

/** No scene selected means common only, never all scenes' runnable references. */
export function workflowPackageSelectedReferences(
  snapshot: EmployeeRuntimeContent,
  sceneId: string | null,
) {
  if (
    sceneId !== null &&
    !employeeRuntimeScenes(snapshot).some((scene) => scene.id === sceneId)
  )
    throw new WorkflowPackageError('not_found');
  const references = snapshot.layers.flatMap((layer) => [
    ...layer.common,
    ...(layer.scenes ?? [])
      .filter((scene) => scene.id === sceneId)
      .flatMap((scene) => scene.references),
  ]);
  const identities = new Map<string, string>();
  for (const reference of references) {
    if (!['procedure', 'workflow'].includes(reference.sourceKind)) continue;
    const identity = `${reference.sourceKind}:${reference.contentId}`;
    const digest = runtimePolicyDigest(reference);
    if (identities.has(identity) && identities.get(identity) !== digest)
      throw new WorkflowPackageError('source_changed');
    identities.set(identity, digest);
  }
  return [
    ...new Map(
      references.map((ref) => [runtimePolicyDigest(ref), ref]),
    ).values(),
  ];
}

export function workflowPackageMethodSync(
  manifest: WorkflowPackageManifest,
  references: readonly EmployeeContentReference[],
  sourceAvailable: boolean,
): WorkflowPackageSyncStatus {
  if (!sourceAvailable) return 'source_unavailable';
  return references.some(
    (ref) => runtimePolicyDigest(ref) === runtimePolicyDigest(manifest.method),
  )
    ? 'in_sync'
    : 'method_changed';
}

/** Verify the actual stored JSON package, including exact method and DAG bytes. */
export function validateWorkflowPackageSource(
  bytes: Uint8Array,
  manifest: WorkflowPackageManifest,
  definition: WorkflowDefinition,
  methodBody: string,
) {
  if (
    !manifest.source ||
    bytes.byteLength > workflowPackageLimits.sourceBytes ||
    workflowPackageBytesChecksum(bytes) !== manifest.source.checksum
  )
    throw new WorkflowPackageError('source_changed');
  let source;
  try {
    source = WorkflowPackageSourceSchema.parse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
  } catch {
    throw new WorkflowPackageError('invalid_package');
  }
  const files = new Map<string, Buffer>();
  const facts: { path: string; checksum: string }[] = [];
  let total = 0;
  for (const file of source.files) {
    const content = Buffer.from(file.contentBase64, 'base64');
    total += content.byteLength;
    if (
      content.toString('base64') !== file.contentBase64 ||
      content.byteLength > workflowPackageLimits.fileBytes ||
      total > workflowPackageLimits.totalBytes ||
      workflowPackageBytesChecksum(content) !== file.checksum ||
      files.has(file.path.toLowerCase())
    )
      throw new WorkflowPackageError('source_changed');
    files.set(file.path.toLowerCase(), content);
    facts.push({ path: file.path, checksum: file.checksum });
  }
  const ordered = (values: typeof facts) =>
    [...values].sort((a, b) => a.path.localeCompare(b.path));
  if (
    runtimePolicyDigest(ordered(facts)) !==
    runtimePolicyDigest(ordered(manifest.files))
  )
    throw new WorkflowPackageError('source_changed');
  const workflow = files.get('workflow.json');
  const method = files.get('method.md');
  if (!workflow || !method || !method.equals(Buffer.from(methodBody, 'utf8')))
    throw new WorkflowPackageError('source_changed');
  try {
    if (
      runtimePolicyDigest(
        WorkflowDefinitionSchema.parse(JSON.parse(workflow.toString('utf8'))),
      ) !== runtimePolicyDigest(definition)
    )
      throw new WorkflowPackageError('source_changed');
  } catch {
    throw new WorkflowPackageError('source_changed');
  }
  return source;
}

export async function readWorkflowPackageObject(
  storage: StoragePort,
  object: StorageObject,
  maximum: number,
) {
  if (object.sizeBytes > maximum)
    throw new WorkflowPackageError('invalid_package');
  const signal = AbortSignal.timeout(5000);
  const stream = await Promise.race([
    storage.get(object),
    new Promise<never>((_, reject) =>
      signal.addEventListener(
        'abort',
        () => reject(new WorkflowPackageError('source_unavailable')),
        { once: true },
      ),
    ),
  ]);
  const reader = stream.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum || length > object.sizeBytes)
        throw new WorkflowPackageError('invalid_package');
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.byteLength !== object.sizeBytes ||
    workflowPackageBytesChecksum(bytes) !== object.checksum
  )
    throw new WorkflowPackageError('source_changed');
  return bytes;
}
