'use client';

import { useState } from 'react';
import {
  IconChevronDownOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { WorkbenchArtifact } from '@allrice/contracts';
import { artifactKindLabel } from '../../lib/chatflow/workbench-model';
import { PresentedFileCard } from './dsh-upstream/deliverables/PresentedFileCard';
import styles from './workbench.module.css';

/** Native DSH presentation; file access remains the existing authenticated API. */
export function DeliveryCard({
  artifact,
  onOpen,
}: {
  artifact: WorkbenchArtifact;
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = artifact.version.fileName;
  return (
    <PresentedFileCard
      file={{
        path: name,
        description:
          artifact.version.changeSummary ||
          `${artifactKindLabel(artifact)} · v${artifact.version.version}`,
      }}
      onPreview={() => onOpen(artifact.id)}
      actions={
        <div className={styles.deliveryActions}>
          <button
            type="button"
            aria-label={`打开 ${name}`}
            onClick={() => onOpen(artifact.id)}
          >
            打开
          </button>
          <Menu
            open={open}
            anchor={
              <button
                type="button"
                aria-label={`${name} 打开方式`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                <IconChevronDownOutlineRegular size={12} />
              </button>
            }
            items={[
              { id: 'preview', label: '侧栏预览' },
              { id: 'download', label: '下载文件' },
            ]}
            onSelect={(id) => {
              setOpen(false);
              if (id === 'preview') onOpen(artifact.id);
              if (id === 'download') {
                const link = document.createElement('a');
                link.href = `/api/v1/files/${artifact.object.id}/download?name=${encodeURIComponent(name)}`;
                link.download = name;
                document.body.append(link);
                link.click();
                link.remove();
              }
            }}
            onClose={() => setOpen(false)}
            align="end"
            portal
          />
        </div>
      }
    />
  );
}
