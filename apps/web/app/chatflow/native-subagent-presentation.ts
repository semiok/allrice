import type { NativeSubagentSummary } from '@allrice/contracts';

export type NativeSubagentRead = NativeSubagentSummary | null | 'error';
export const nativeSubagentActivityUnknown = (
  read: NativeSubagentRead | undefined,
) =>
  read === null ||
  (typeof read === 'object' &&
    read.descendants.some(
      (entry) =>
        entry.parentId === read.rootId &&
        (entry.kind === 'diagnostic' || entry.running === null),
    ));
