import type { ArtifactPreview } from '../../lib/chatflow/workbench-model';
import styles from './workbench.module.css';

/** Shared delivery/material presentation; native renderers keep their behavior. */
export function documentPreviewPresentation(
  preview: ArtifactPreview | null,
  source: boolean,
) {
  if (!preview || source) return '';
  if (preview.kind === 'text')
    return preview.mediaType === 'text/markdown'
      ? `${styles.previewCanvas} ${styles.previewMarkdown}`
      : '';
  if (preview.kind === 'image')
    return `${styles.previewCanvas} ${styles.previewImage}`;
  if (preview.kind === 'spreadsheet')
    return `${styles.previewCanvas} ${styles.previewSpreadsheet}`;
  if (preview.kind === 'pdf' || preview.kind === 'office')
    return styles.previewCanvas;
  return '';
}
