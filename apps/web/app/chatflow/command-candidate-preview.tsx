'use client';
import { useState } from 'react';
import {
  ChangesetDocumentSchema,
  type RuntimeLocalCommand,
} from '@allrice/contracts';
import { ToolFileDiff } from './cline-adapter/tool-file-diff';

export function CommandCandidatePreview({
  candidate,
  state,
}: {
  candidate: NonNullable<RuntimeLocalCommand['arguments']['candidate']>;
  state?: 'current' | 'stale' | 'unavailable' | null;
}) {
  const [selected, setSelected] = useState(0);
  let document;
  try {
    document = ChangesetDocumentSchema.parse(JSON.parse(candidate.content));
  } catch {
    return <p role="alert">候选修改无法读取，请勿批准；刷新后重试。</p>;
  }
  const file = document.files[selected] ?? document.files[0]!;
  return (
    <section aria-label="本次沙箱候选版本">
      <p>
        先把下列修改装载到临时隔离副本，再运行验证命令；不会写回原目录，也不表示已通过独立审查。
      </p>
      <p>
        Artifact：<code>{candidate.artifactId}</code> ·{' '}
        <code>{candidate.checksum}</code>
      </p>
      {state !== 'current' && (
        <p role="status">
          {state === 'stale'
            ? '已有更新版本；本次命令和回执只对应此旧版本，不能证明新版本已通过。'
            : '当前版本状态未确认，请刷新；未确认时不可批准。'}
        </p>
      )}
      <label>
        查看候选文件{' '}
        <select
          value={selected}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {document.files.map((f, i) => (
            <option key={f.path} value={i}>
              {f.path} · {f.before ? (f.after ? '修改' : '删除') : '新增'}
            </option>
          ))}
        </select>
      </label>
      <ToolFileDiff
        key={`${candidate.checksum}:${file.path}`}
        path={file.path}
        before={file.before?.text ?? null}
        after={file.after?.text ?? null}
        mode="unified"
        onSelect={() => {}}
      />
      <details>
        <summary>前后文本（Diff 不可用时仍可核对）</summary>
        <p>修改前</p>
        <pre>{file.before?.text ?? '（文件不存在）'}</pre>
        <p>修改后</p>
        <pre>{file.after?.text ?? '（删除文件）'}</pre>
      </details>
    </section>
  );
}
