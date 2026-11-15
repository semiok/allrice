'use client';

import type { ChatCitation } from '@allrice/contracts';
import {
  FileTypeIcon,
  ReferenceChip,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { InlineProcessFields } from './work-process-material';
import css from './reference-sources.module.css';

export type ReadReferenceCitation = Extract<
  ChatCitation,
  { type: 'reference' }
>;
export const referenceCitationAddress = (id: string) => `citation:${id}`;

/** A receipt describes only the content returned by its particular read. */
export function referenceSourceFacts(citation: ReadReferenceCitation) {
  const locator = citation.locator;
  const member = locator.kind === 'archive_directory' ? null : locator.member;
  const kind =
    locator.kind === 'archive_directory'
      ? 'ZIP 目录'
      : locator.kind === 'archive_member_text'
        ? 'ZIP 内文件 · 正文'
        : member
          ? 'ZIP 内文件 · 图片'
          : '图片资料';
  const reading =
    locator.kind === 'archive_directory'
      ? locator.totalEntries === 0
        ? '空目录，共 0 项；尚未读取包内文件内容。'
        : `目录第 ${locator.startEntryIndex + 1}–${locator.endEntryIndex} 项，共 ${locator.totalEntries} 项；尚未读取包内文件内容。`
      : locator.kind === 'archive_member_text'
        ? `正文第 ${locator.start + 1}–${locator.end} 字符`
        : member
          ? '仅本张图片，不代表包内其他文件已读取。'
          : '本张图片';
  return {
    kind,
    reading,
    path: member?.path,
    name: citation.reference.fileName,
  };
}

export function ReferenceCitationSources({
  citations,
  onOpen,
}: {
  citations: readonly ChatCitation[];
  onOpen?: (citation: ReadReferenceCitation) => void;
}) {
  const references = citations.filter(
    (c): c is ReadReferenceCitation => c.type === 'reference',
  );
  if (!references.length) return null;
  return (
    <div className={css.sources} aria-label="参考资料来源">
      {references.map((citation) => {
        const source = referenceSourceFacts(citation);
        return (
          <div className={css.source} key={citation.id}>
            <ReferenceChip
              appearance="file"
              label={`[${citation.referenceLabel}] ${source.path ?? source.name}`}
              title={
                source.path ? `${source.name} / ${source.path}` : source.name
              }
              onActivate={onOpen ? () => onOpen(citation) : undefined}
            />
            <div className={css.caption}>
              {source.kind}
              {source.path && ` · ${source.name}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Historical attribution only. A citation is not authority to fetch an image,
 * preview, archive member or fresh publication metadata, including after revoke. */
export function ReferenceSourcePanel({
  citation,
  onBack,
}: {
  citation: ReadReferenceCitation;
  onBack?: () => void;
}) {
  const source = referenceSourceFacts(citation);
  return (
    <section className={css.panel} aria-label="引用来源">
      <header className={css.heading}>引用来源</header>
      {onBack && (
        <button type="button" className={css.back} onClick={onBack}>
          ‹ 企业资料
        </button>
      )}
      <div className={css.body}>
        <div className={css.title}>
          <FileTypeIcon path={source.name} size={32} />
          <h2>{source.name}</h2>
        </div>
        <Tag tone="outline">{source.kind}</Tag>
        {source.path && (
          <div className={css.member}>
            <span>包内文件</span>
            <strong>{source.path}</strong>
          </div>
        )}
        <InlineProcessFields
          rows={[
            ['来源', `[${citation.referenceLabel}] 企业资料`],
            ['资料', source.name],
            ...(source.path ? [['文件', source.path] as const] : []),
            ['读取', source.reading],
          ]}
        />
        {citation.locator.kind === 'archive_directory' && (
          <p className={css.caption}>目录读取不代表包内正文或图片已读取。</p>
        )}
      </div>
    </section>
  );
}
