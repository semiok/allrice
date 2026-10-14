'use client';
import type { ReferenceRevision } from '@allrice/contracts';
import css from './session-reference.module.css';

export type ReferenceDraft = Pick<
  ReferenceRevision,
  'sourceId' | 'revisionId' | 'revision' | 'fileName'
>;
export function ReferenceChips({
  references,
  disabled,
  onRemove,
  onOpen,
}: {
  references: ReferenceDraft[];
  disabled?: boolean;
  onRemove?: (id: string) => void;
  onOpen?: (reference: ReferenceDraft) => void;
}) {
  if (!references.length) return null;
  return (
    <div className={css.chips} aria-label="本次参考资料">
      {references.map((r) => (
        <span className={css.chip} key={r.revisionId}>
          <span aria-hidden="true">▤</span>
          {onOpen ? (
            <button type="button" disabled={disabled} onClick={() => onOpen(r)}>
              {r.fileName} · v{r.revision}
            </button>
          ) : (
            <span title={r.fileName}>
              {r.fileName} · v{r.revision}
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除资料 ${r.fileName} v${r.revision}`}
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
