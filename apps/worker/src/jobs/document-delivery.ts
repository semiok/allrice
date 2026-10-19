import { createHash } from 'node:crypto';
import { UuidSchema } from '@allrice/contracts';

import { HandlerError } from '../errors.js';
import type { HarnessToolCall } from '../harness/adapter.js';

type Revision = { key: string; parentObjectId: string; digest: string };

function textRevision(call: HarnessToolCall): Revision | undefined {
  const args = call.arguments;
  if (
    !UuidSchema.safeParse(args.parentObjectId).success ||
    typeof args.fileName !== 'string' ||
    typeof args.content !== 'string' ||
    !['text', 'markdown', 'html', 'json'].includes(String(args.format)) ||
    (args.artifactKind !== undefined && args.artifactKind !== 'document') ||
    args.python !== undefined ||
    args.office !== undefined ||
    args.officePdf !== undefined
  )
    return;
  const parentObjectId = (args.parentObjectId as string).toLowerCase();
  const digest = `sha256:${createHash('sha256').update(args.content).digest('hex')}`;
  return {
    key: JSON.stringify([args.fileName, parentObjectId, digest]),
    parentObjectId,
    digest,
  };
}

function confirmsRevision(result: unknown, revision: Revision): boolean {
  if (!result || typeof result !== 'object' || !('modelContent' in result))
    return false;
  if (typeof result.modelContent !== 'string') return false;
  try {
    // This is the trusted Broker result, never the model's proposed arguments
    // or a same-named file from a different series/Run. The publisher has already
    // checked the exact parent, authorization, head version and stored bytes.
    const receipt = JSON.parse(result.modelContent) as Record<string, unknown>;
    return (
      receipt !== null &&
      typeof receipt === 'object' &&
      UuidSchema.safeParse(receipt.objectId).success &&
      UuidSchema.safeParse(receipt.seriesId).success &&
      typeof receipt.parentObjectId === 'string' &&
      receipt.parentObjectId.toLowerCase() === revision.parentObjectId &&
      receipt.digest === revision.digest &&
      Number.isInteger(receipt.version) &&
      Number(receipt.version) >= 2
    );
  } catch {
    return false;
  }
}

/** Tracks actual export receipts, not the model's prose or an older download. */
export function documentDeliveryGuard() {
  const pending = new Map<
    number,
    { label: string; target: string; revision?: Revision }
  >();
  const successfulTargets = new Map<string, number>();
  const confirmedRevisions = new Set<string>();
  let sequence = 0;
  return {
    async execute<T>(
      call: HarnessToolCall,
      execute: () => Promise<T>,
    ): Promise<T> {
      const format =
        call.name === 'workspace.export.create' &&
        typeof call.arguments.format === 'string'
          ? call.arguments.format
          : null;
      const file = format
        ? `${String(call.arguments.fileName ?? format)} (${format})`
        : null;
      const parent = call.arguments.parentObjectId;
      const target = file
        ? JSON.stringify([
            file,
            UuidSchema.safeParse(parent).success
              ? (parent as string).toLowerCase()
              : (parent ?? null),
          ])
        : null;
      const revision = file ? textRevision(call) : undefined;
      const order = ++sequence;
      try {
        const result = await execute();
        if (target && file) {
          successfulTargets.set(
            target,
            Math.max(order, successfulTargets.get(target) ?? 0),
          );
          const confirmed = revision && confirmsRevision(result, revision);
          if (confirmed) {
            confirmedRevisions.add(revision.key);
          }
          for (const [failedOrder, entry] of pending) {
            // A later successful correction can fulfill an earlier attempt of
            // the same target. A late old response cannot hide a newer failure.
            // Across formats, only exact bytes/parent with a real receipt match.
            if (
              (entry.target === target && failedOrder <= order) ||
              (confirmed && entry.revision?.key === revision.key)
            )
              pending.delete(failedOrder);
          }
        }
        return result;
      } catch (error) {
        if (
          target &&
          file &&
          (successfulTargets.get(target) ?? 0) < order &&
          !(revision && confirmedRevisions.has(revision.key))
        )
          pending.set(order, {
            label: file,
            target,
            revision,
          });
        throw error;
      }
    },
    assertComplete() {
      const missing = [
        ...new Set([...pending.values()].map(({ label }) => label)),
      ];
      if (missing.length)
        throw new HandlerError(
          'DOCUMENT_DELIVERY_INCOMPLETE',
          `本轮 ${missing.join('、')} 文件未收到成功交付回执，已有内容和历史文件已保留。`,
          false,
        );
    },
  };
}
