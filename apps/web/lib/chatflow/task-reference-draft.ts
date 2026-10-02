import type { TaskNextStepReference } from '@allrice/contracts';
import type { PendingAttachment } from '../../app/chatflow/chatflow-types';

/** These are already-owned, already-linked Session files, confirmed by GET.
 * Only draft chips are added. The original send path checks authorization. */
export function appendTaskReferences(
  current: PendingAttachment[],
  references: TaskNextStepReference[],
): PendingAttachment[] {
  const ids = new Set(current.map((a) => a.persistedId ?? a.id));
  const added = [
    ...new Map(references.map((r) => [r.objectId, r])).values(),
  ].filter((r) => !ids.has(r.objectId));
  if (current.length + added.length > 20)
    throw Error('每条消息最多添加 20 个附件。');
  if (
    [...current, ...added].reduce((total, a) => total + a.sizeBytes, 0) >
    200 * 1024 * 1024
  )
    throw Error('每条消息的附件总大小不能超过 200 MB。');
  return [
    ...current,
    ...added.map((r) => ({
      id: r.objectId,
      persistedId: r.objectId,
      fileName: r.fileName,
      mediaType: r.mediaType,
      sizeBytes: r.sizeBytes,
      visibility: r.visibility,
      status: 'ready' as const,
    })),
  ];
}
