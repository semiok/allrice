'use client';
import { useEffect, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { platformFileMaximumBytes } from '@allrice/contracts';

export function StorageUsage({ workspaceId }: { workspaceId: string }) {
  const [usage, setUsage] = useState<{
    usedBytes: number;
    limitBytes: number | null;
  } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setUsage(null);
    setError(false);
    void fetch(`/api/v1/files?workspaceId=${workspaceId}&summary=1`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('storage_usage_failed');
        const body = await response.json();
        if (
          body.workspaceId !== workspaceId ||
          !Number.isFinite(body.usedBytes) ||
          (body.limitBytes !== null && !Number.isFinite(body.limitBytes))
        )
          throw Error('storage_usage_invalid');
        if (!controller.signal.aborted) setUsage(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [workspaceId, revision]);
  const bytes = (value: number) =>
    value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return (
    <div>
      <h3>文件存储</h3>
      {usage ? (
        <p>
          工作区已用 {bytes(usage.usedBytes)}；
          {usage.limitBytes === null
            ? '未设置额外存储配额'
            : `配置上限 ${bytes(usage.limitBytes)}`}
          。
        </p>
      ) : (
        <p role="status">
          {error ? '暂时无法读取存储用量。' : '正在读取存储用量…'}
        </p>
      )}
      <p>
        单次文件传输上限 {platformFileMaximumBytes / 1_000_000}{' '}
        MB，浏览器与上传共用此规则。
      </p>
      <Button
        variant="outline"
        onClick={() => setRevision((value) => value + 1)}
      >
        刷新存储用量
      </Button>
    </div>
  );
}
