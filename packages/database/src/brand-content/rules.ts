import { createHash } from 'node:crypto';
import type {
  BrandContentAction,
  BrandContentImage,
  BrandContentVersionRef,
} from '@allrice/contracts';
import type { BrandContentAuthority } from './types.ts';

export class BrandContentError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'authority_denied'
      | 'version_conflict'
      | 'request_conflict'
      | 'invalid_state'
      | 'source_unavailable'
      | 'source_changed'
      | 'parent_mismatch'
      | 'source_reference_invalid'
      | 'workflow_pin_required'
      | 'receipt_invalid'
      | 'reminder_unconfirmed',
  ) {
    super(code);
  }
}
export function brandContentFail(code: BrandContentError['code']): never {
  throw new BrandContentError(code);
}
export function brandContentDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return input;
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}
export function normalizeBrandTopicTitle(title: string) {
  const result = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
  if (!result || result.length > 240)
    brandContentFail('source_reference_invalid');
  return result;
}
export function assertBrandContentAuthority(
  action: BrandContentAction,
  authority: BrandContentAuthority,
) {
  if (!['user', 'workflow', 'scheduler'].includes(authority))
    brandContentFail('authority_denied');
  if (action.operation === 'plan.reminder') {
    if (authority !== 'scheduler') brandContentFail('authority_denied');
  } else if (authority === 'scheduler') brandContentFail('authority_denied');
  if (
    ['topics.decide', 'article.review', 'receipt.record'].includes(
      action.operation,
    ) &&
    authority !== 'user'
  )
    brandContentFail('authority_denied');
  if (authority === 'workflow' && !action.workflow)
    brandContentFail('workflow_pin_required');
}
export function assertBrandRevision(actual: number, expected: number) {
  if (actual !== expected) brandContentFail('version_conflict');
}
export function mergeBrandContentImages(
  old: BrandContentImage[],
  patch: BrandContentImage[],
  remove: string[],
) {
  const slots = new Map(old.map((i) => [i.slotKey, i]));
  for (const slot of remove) {
    if (!slots.delete(slot)) brandContentFail('source_reference_invalid');
  }
  for (const image of patch) slots.set(image.slotKey, image);
  if (slots.size > 12) brandContentFail('source_reference_invalid');
  return [...slots.values()].sort((a, b) =>
    a.slotKey < b.slotKey ? -1 : a.slotKey > b.slotKey ? 1 : 0,
  );
}
export function brandContentBundleDigest(
  platform: string,
  content: BrandContentVersionRef,
  images: BrandContentImage[],
) {
  return brandContentDigest({
    platform,
    content,
    images: [...images].sort((a, b) =>
      a.slotKey < b.slotKey ? -1 : a.slotKey > b.slotKey ? 1 : 0,
    ),
  });
}
export function assertBrandContentParent(
  currentVersionId: string,
  suppliedParentId: string | undefined,
  document: { versionId: string; parentVersionId: string | null },
) {
  if (
    suppliedParentId !== currentVersionId ||
    document.parentVersionId !== currentVersionId ||
    document.versionId === currentVersionId
  )
    brandContentFail('parent_mismatch');
}
export function assertBrandContentApprovedBundle(
  article: { id: string; state: string; platform: string },
  bundle: { id: string; digest: string },
  review: {
    article_id: string;
    bundle_id: string;
    bundle_digest: string;
    decision: string;
  },
  input: { bundleDigest: string; platform: string },
) {
  if (
    article.state !== 'approved' ||
    bundle.digest !== input.bundleDigest ||
    review.bundle_id !== bundle.id ||
    review.article_id !== article.id ||
    review.decision !== 'approved' ||
    review.bundle_digest !== bundle.digest ||
    input.platform !== article.platform
  )
    brandContentFail('invalid_state');
}
