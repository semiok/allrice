import { createHash } from 'node:crypto';
import {
  UuidSchema,
  ChecksumSchema,
  OfficeDeliveryReceiptSchema,
  OfficeFirstDeliveryPolicySchema,
  officeMediaTypes,
  assessOfficeFormulaCaches,
  type OfficeFirstDeliveryPolicy,
} from '@allrice/contracts';

import { HandlerError, isConfirmedToolFailure } from '../errors.js';
import type { HarnessToolCall } from '../harness/adapter.js';

type Revision = { key: string; parentObjectId: string; digest: string };
type OfficeVersion = {
  seriesId: string;
  format: 'xlsx';
  version: number;
  objectId: string;
  versionId: string;
  checksum: string;
};

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
export function documentDeliveryGuard(
  officePolicy?: OfficeFirstDeliveryPolicy,
  runId?: string,
) {
  if (officePolicy !== undefined)
    OfficeFirstDeliveryPolicySchema.parse(officePolicy);
  if (runId !== undefined) UuidSchema.parse(runId);
  // Only this Run's bound Broker receipts enter the map. Never evict a parent
  // and then infer its series from a model argument or a same-named file.
  const officeObjects = new Map<string, OfficeVersion>();
  const officeHeads = new Map<
    string,
    {
      version: number;
      objectId: string;
      versionId: string;
      checksum: string;
      hasFormulas: boolean;
      receipt: unknown;
      label: string;
    }
  >();
  const officeUnknown = new Set<string>();
  function observeOffice(
    call: HarnessToolCall,
    result: unknown,
  ): OfficeVersion | undefined {
    if (
      !officePolicy ||
      call.name !== 'workspace.export.create' ||
      call.arguments.format !== 'xlsx'
    )
      return;
    let row: Record<string, unknown>;
    try {
      if (
        !result ||
        typeof result !== 'object' ||
        !('modelContent' in result) ||
        typeof result.modelContent !== 'string' ||
        result.modelContent.length > 1_000_000
      )
        throw Error('unbound_office_reply');
      row = JSON.parse(result.modelContent);
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        row.mediaType !== officeMediaTypes.xlsx ||
        !UuidSchema.safeParse(row.seriesId).success ||
        !UuidSchema.safeParse(row.objectId).success ||
        !UuidSchema.safeParse(row.artifactId).success ||
        !ChecksumSchema.safeParse(row.digest).success ||
        !Number.isSafeInteger(row.version) ||
        Number(row.version) < 1
      )
        throw Error('unbound_office_reply');
    } catch {
      officeUnknown.add(call.id);
      return;
    }
    const id = row.seriesId as string,
      current = officeHeads.get(id);
    const bound = OfficeDeliveryReceiptSchema.safeParse(row);
    if (
      bound.success &&
      bound.data.savedValues &&
      bound.data.savedValues.checksum !== row.digest
    ) {
      officeUnknown.add(call.id);
      return;
    }
    if (!current && officeHeads.size >= 1000) {
      officeUnknown.add(call.id);
      return;
    }
    let observed: OfficeVersion | undefined;
    if (
      bound.success &&
      bound.data.savedValues &&
      row.artifactKind === 'document'
    ) {
      observed = {
        seriesId: id.toLowerCase(),
        format: 'xlsx',
        version: Number(row.version),
        objectId: (row.objectId as string).toLowerCase(),
        versionId: (row.artifactId as string).toLowerCase(),
        checksum: row.digest as string,
      };
      const known = officeObjects.get(observed.objectId);
      if (
        (known &&
          (known.seriesId !== observed.seriesId ||
            known.version !== observed.version ||
            known.versionId !== observed.versionId ||
            known.checksum !== observed.checksum)) ||
        (!known && officeObjects.size >= 1000)
      ) {
        officeUnknown.add(call.id);
        return;
      }
      officeObjects.set(observed.objectId, observed);
    }
    const assessment = assessOfficeFormulaCaches(row);
    const hasFormulas =
      (current?.hasFormulas ?? false) || assessment.hasFormulas;
    if (current && Number(row.version) <= current.version) {
      if (
        Number(row.version) === current.version &&
        (row.objectId !== current.objectId ||
          row.artifactId !== current.versionId ||
          row.digest !== current.checksum)
      )
        officeUnknown.add(call.id);
      current.hasFormulas = hasFormulas;
      return;
    }
    officeHeads.set(id, {
      version: Number(row.version),
      objectId: row.objectId as string,
      versionId: row.artifactId as string,
      checksum: row.digest as string,
      hasFormulas,
      receipt: row,
      label:
        typeof row.fileName === 'string' ? row.fileName.slice(0, 120) : 'XLSX',
    });
    // A replay/late old head returned above. Constants and incomplete caches
    // cannot prove that a failed formula correction has been delivered.
    return observed &&
      assessOfficeFormulaCaches(row, hasFormulas).status === 'satisfied'
      ? observed
      : undefined;
  }
  const pending = new Map<
    number,
    {
      label: string;
      target: string;
      revision?: Revision;
      office?: { parent: OfficeVersion; observedAfter: number };
    }
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
      const officeParent =
        format === 'xlsx' && UuidSchema.safeParse(parent).success
          ? officeObjects.get((parent as string).toLowerCase())
          : undefined;
      const order = ++sequence;
      try {
        const result = await execute();
        const office = observeOffice(call, result);
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
              (confirmed && entry.revision?.key === revision.key) ||
              (office &&
                entry.office &&
                order > entry.office.observedAfter &&
                office.seriesId === entry.office.parent.seriesId &&
                office.format === entry.office.parent.format &&
                office.version > entry.office.parent.version)
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
            ...(officeParent &&
            runId &&
            error instanceof HandlerError &&
            error.code === 'TOOL_PUBLICATION_PARENT_INVALID' &&
            isConfirmedToolFailure(error, {
              runId,
              callId: call.id,
              toolName: call.name,
            })
              ? { office: { parent: officeParent, observedAfter: sequence } }
              : {}),
          });
        throw error;
      }
    },
    assertComplete() {
      const missing = [
        ...new Set([...pending.values()].map(({ label }) => label)),
        ...[...officeHeads.values()]
          .filter(
            (head) =>
              assessOfficeFormulaCaches(head.receipt, head.hasFormulas)
                .status === 'incomplete',
          )
          .map((head) => head.label),
        ...(officeUnknown.size ? ['XLSX 的真实文件回执未确认'] : []),
      ];
      if (missing.length)
        throw new HandlerError(
          'DOCUMENT_DELIVERY_INCOMPLETE',
          officePolicy && pending.size === 0 && officeUnknown.size === 0
            ? `本轮 ${missing.join('、')} 的公式缓存检查未完成，已保留文件和历史版本供检查，不能认定已完整交付。`
            : `本轮 ${missing.join('、')} 文件未收到成功交付回执，已有内容和历史文件已保留。`,
          false,
        );
    },
  };
}
