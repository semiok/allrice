'use client';
import { useEffect, useState } from 'react';
import {
  ExperienceProvenanceSchema,
  type ExperienceProvenance,
} from '@allrice/contracts';
import styles from './experience.module.css';

type Props = {
  workspaceId: string;
  instanceId: string;
  memoryId: string;
  revision: number;
  headers?: Record<string, string>;
};
export function ExperienceSources(props: Props) {
  return (
    <SourceReader
      key={`${props.workspaceId}/${props.instanceId}/${props.memoryId}/${props.revision}`}
      {...props}
    />
  );
}
function SourceReader({
  workspaceId,
  instanceId,
  memoryId,
  revision,
  headers,
}: Props) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{
    value?: ExperienceProvenance;
    error?: string;
  }>();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(
      `/api/v1/experiences/${encodeURIComponent(memoryId)}/provenance?workspaceId=${encodeURIComponent(workspaceId)}&instanceId=${encodeURIComponent(instanceId)}&revision=${revision}`,
      {
        cache: 'no-store',
        headers,
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw Error(
            [401, 403, 404, 409].includes(response.status)
              ? '来源或访问权限已变化，无法展开。请重新读取经验记录。'
              : '暂时无法读取来源，请稍后重新展开。',
          );
        const value = ExperienceProvenanceSchema.parse(await response.json());
        const pin = value.projection.pin;
        if (
          value.workspaceId !== workspaceId ||
          pin.instanceId !== instanceId ||
          pin.id !== memoryId ||
          pin.revision !== revision
        )
          throw Error('经验版本已变化，请重新读取。');
        if (!controller.signal.aborted) setResult({ value });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({
            error: error instanceof Error ? error.message : '来源读取失败。',
          });
      });
    return () => controller.abort();
  }, [open, workspaceId, instanceId, memoryId, revision, headers]);
  return (
    <section aria-label="经验来源与版本">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setResult(undefined);
          setOpen(!open);
        }}
      >
        {open ? '收起来源与版本' : '查看来源与版本'}
      </button>
      {open &&
        (result?.error ? (
          <p role="alert">{result.error}</p>
        ) : !result?.value ? (
          <p role="status">正在核对并读取来源…</p>
        ) : (
          <>
            <p>
              {result.value.projection.topic === 'attendance'
                ? '名单核对'
                : '报告表达'}{' '}
              · 经验 v{revision} ·{' '}
              {new Date(result.value.adoptedAt).toLocaleString('zh-CN')} 采用
            </p>
            <p>适用范围：{result.value.projection.applicability}</p>
            <p>以下是形成这条经验的原始反馈，仅本人可见。</p>
            {result.value.sources.map((source, index) => (
              <section key={source.id}>
                <strong>反馈 {index + 1}</strong>
                <blockquote className={styles.source}>
                  {source.excerpt}
                </blockquote>
                <details>
                  <summary>查看准确记录</summary>
                  <p>任务：{source.runId}</p>
                  <p>会话：{source.sessionId}</p>
                  <p>消息：{source.messageId}</p>
                  <p>来源校验值：{source.sourceDigest}</p>
                  {source.skills.map((pin) => (
                    <p key={pin.bindingId}>
                      使用的个人技能版本：{pin.versionId}；安装：
                      {pin.installationId}；校验值：
                      {pin.packageChecksum ?? pin.definitionChecksum}
                    </p>
                  ))}
                </details>
              </section>
            ))}
            <details>
              <summary>查看经验版本记录</summary>
              <p>整理任务：{result.value.consolidationRunId}</p>
              <p>内容校验值：{result.value.projection.pin.contentDigest}</p>
              <p>
                采用依据校验值：{result.value.projection.pin.adoptionDigest}
              </p>
            </details>
          </>
        ))}
    </section>
  );
}
