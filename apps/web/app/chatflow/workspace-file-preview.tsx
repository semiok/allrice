'use client';
import { useEffect, useState } from 'react';
import {
  CodeBlock,
  languageForPath,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { DeliverableVersion } from '@allrice/contracts';
import { ReadOnlyArtifactPreview } from './artifact-workbench';
import {
  parseArtifactPreview,
  workbenchJson,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import styles from './workbench.module.css';
export function WorkspaceFilePreview(props: {
  objectId: string;
  title: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  onVersion: (id: string, title: string) => void;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [versions, setVersions] = useState<DeliverableVersion[]>([]);
  const [versionError, setVersionError] = useState('');
  const base = `/api/v1/files/${encodeURIComponent(props.objectId)}`;
  const query = `?workspaceId=${encodeURIComponent(props.workspaceId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setPreview(null);
    setVersions([]);
    setVersionError('');
    void workbenchJson(`${base}/preview${query}`, props.tenantHeaders, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setPreview(parseArtifactPreview(value));
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : '文件不可用，请刷新文件列表。',
          );
      });
    void workbenchJson(`${base}/versions${query}`, props.tenantHeaders, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted)
          setVersions((value as { versions: DeliverableVersion[] }).versions);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setVersionError('暂时无法读取历史版本，可重试。');
      });
    return () => controller.abort();
  }, [base, query, props.tenantHeaders, attempt]);
  return (
    <div className={styles.body}>
      <h3>{props.title}</h3>
      <div className={styles.actions}>
        <a
          href={`${base}/download${query}&name=${encodeURIComponent(props.title)}`}
          download
        >
          下载文件
        </a>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          刷新文件
        </button>
      </div>
      {versions.length > 1 ? (
        <label>
          历史版本
          <select
            aria-label="文件历史版本"
            value={props.objectId}
            onChange={(event) => {
              const v = versions.find(
                (version) => version.objectId === event.target.value,
              );
              if (v) props.onVersion(v.objectId, v.fileName);
            }}
          >
            {versions.map((version) => (
              <option key={version.id} value={version.objectId}>
                v{version.version} · {version.fileName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {versionError ? <p role="status">{versionError}</p> : null}
      {error ? (
        <p role="alert">{error}</p>
      ) : preview ? (
        preview.kind === 'text' &&
        !['text/markdown', 'text/plain'].includes(preview.mediaType) ? (
          <CodeBlock
            code={preview.text}
            lang={languageForPath(props.title)}
            lineNumbers
            wrap
            copyLabel="复制源码"
            copiedLabel="已复制"
          />
        ) : (
          <ReadOnlyArtifactPreview preview={preview} />
        )
      ) : (
        <p role="status">正在加载文件预览…</p>
      )}
    </div>
  );
}
