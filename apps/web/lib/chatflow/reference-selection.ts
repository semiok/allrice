import { ReferenceSelectionErrorSchema } from '@allrice/contracts';

export const referenceSelectionMessage = '引用失败，文件可能被调整权限或移除';

export class ReferenceSelectionUnavailableError extends Error {
  constructor(readonly referenceRevisionIds: string[]) {
    super(referenceSelectionMessage);
  }
}

/** This one DTO identifies failed pins; other conflicts keep their existing handling. */
export async function checkReferenceSelectionFailure(
  response: Response,
  requestedRevisionIds: readonly string[],
) {
  if (response.status !== 409 || !requestedRevisionIds.length) return;
  const parsed = ReferenceSelectionErrorSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
  if (!parsed.success) return;
  const ids = parsed.data.error.referenceRevisionIds;
  if (
    new Set(ids).size === ids.length &&
    ids.every((id) => requestedRevisionIds.includes(id))
  )
    throw new ReferenceSelectionUnavailableError(ids);
}
