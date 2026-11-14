'use client';
import type { ReferenceRevision } from '@allrice/contracts';
import css from './session-reference.module.css';

export type ReferenceDraft = Pick<
  ReferenceRevision,
  'sourceId' | 'revisionId' | 'revision' | 'fileName' | 'publication'
>;
export function ReferenceChips({
  references,
  disabled,
  unavailableRevisionIds = [],
  onRemove,
  onOpen,
}: {
  references: ReferenceDraft[];
  disabled?: boolean;
  unavailableRevisionIds?: readonly string[];
  onRemove?: (id: string) => void;
  onOpen?: (reference: ReferenceDraft) => void;
}) {
  if (!references.length) return null;
  return (
    <div className={css.chips} aria-label="本次参考资料">
      {references.map((r) => (
        <span
          className={`${css.chip} ${unavailableRevisionIds.includes(r.revisionId) ? css.unavailableChip : ''}`}
          key={r.revisionId}
          data-reference-revision-id={r.revisionId}
          data-reference-unavailable={
            unavailableRevisionIds.includes(r.revisionId) || undefined
          }
          aria-invalid={
            unavailableRevisionIds.includes(r.revisionId) || undefined
          }
        >
          <span aria-hidden="true">▤</span>
          {onOpen &&
          !r.publication &&
          !unavailableRevisionIds.includes(r.revisionId) ? (
            <button type="button" disabled={disabled} onClick={() => onOpen(r)}>
              {r.fileName}
              {!r.publication && ` · v${r.revision}`}
            </button>
          ) : (
            <span title={r.fileName}>
              {r.fileName}
              {!r.publication && ` · v${r.revision}`}
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除资料 ${r.fileName}${r.publication ? '' : ` v${r.revision}`}`}
              onClick={() => onRemove(r.revisionId)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
