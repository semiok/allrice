'use client';

import type { DeliverableVersion } from '@allrice/contracts';

import type { WorkspaceFile } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './dsh-saas.module.css';

interface DeliverableVersionHistoryDialogProps {
  file: WorkspaceFile | null;
  loading: boolean;
  versions: DeliverableVersion[];
  onClose: () => void;
}

export function DeliverableVersionHistoryDialog({
  file,
  loading,
  versions,
  onClose,
}: DeliverableVersionHistoryDialogProps) {
  if (!file) return null;

  return (
    <DshDialog
      ariaLabel={`${file.fileName} 的版本历史`}
      eyebrow="Rice 交付物"
      onClose={onClose}
      title="版本历史"
    >
      <div className={styles.versionHistory}>
        <header>
          <strong>{file.fileName}</strong>
          <small>每次修改都会生成不可变的新版本，旧版本可以随时下载。</small>
        </header>
        {loading ? <p>正在加载版本历史…</p> : null}
        {versions.map((version) => (
          <article key={version.id}>
            <div>
              <strong>v{version.version}</strong>
              <span>{version.fileName}</span>
              <small>
                {new Date(version.createdAt).toLocaleString('zh-CN')}
                {version.changeSummary ? ` · ${version.changeSummary}` : ''}
              </small>
            </div>
            <a
              href={`/api/v1/files/${version.objectId}/download?name=${encodeURIComponent(version.fileName)}`}
            >
              下载
            </a>
          </article>
        ))}
        {!loading && versions.length === 0 ? (
          <p>还没有可用的历史版本。</p>
        ) : null}
      </div>
    </DshDialog>
  );
}
