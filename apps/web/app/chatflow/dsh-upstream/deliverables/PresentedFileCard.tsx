/** Pinned DSH card; Allrice replaces desktop Host actions with scoped web actions. */
import type { ReactNode } from 'react'
import { FileTypeIcon, fileExtension } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './Deliverables.module.css'

function cardDescription(description: string | undefined, fallback: string): string {
  const trimmed = description?.replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/u, '').trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

/**
 * Render independent file actions without nesting buttons inside a clickable card.
 * @param props - Allrice file metadata, Sidebar preview and authenticated browser actions.
 * @returns the file card and its anchored action menu.
 */
export function PresentedFileCard({ file, onPreview, actions }: {
  file: { path: string; description?: string }
  onPreview: () => void
  actions: ReactNode
}) {
  const name = file.path
  const metadata = fileExtension(name).toUpperCase() || '文件'
  const status = cardDescription(file.description, metadata)
  return <div className={css.file} data-presented-file>
    <button type="button" className={css.cardPreview} title={file.path}
      aria-label={`侧栏预览 ${file.path}`} onClick={onPreview} />
    <span className={css.fileIcon}><FileTypeIcon path={file.path} size={20} /></span>
    <div className={css.fileBody}>
      <div className={css.details}>
        <span className={css.fileName}>{name}</span>
        <span className={css.description} data-presented-description>
          <span className={css.secondaryText}>
            {status}
          </span>
          <span className={css.previewHint}>侧栏预览</span>
        </span>
      </div>
      <div className={css.actions}>{actions}</div>
    </div>
  </div>
}
