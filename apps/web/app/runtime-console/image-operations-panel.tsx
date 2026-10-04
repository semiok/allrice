'use client';
import { AdminButton } from '../../components/admin/admin-ui';
import { useState } from 'react';
import styles from './image-operations-panel.module.css';
type ImageOperation = {
  id: string;
  operation: 'generate' | 'edit';
  status: 'running' | 'succeeded' | 'failed' | 'unknown';
  imageModel: string;
  organizationName: string;
  createdAt: string;
  errorCode: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number | null;
  } | null;
};
const statusLabels = {
  running: '处理中',
  succeeded: '已完成',
  failed: '未完成',
  unknown: '结果待核对',
};
export function ImageOperationsPanel() {
  const [items, setItems] = useState<ImageOperation[] | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/admin/image-operations', {
        cache: 'no-store',
      });
      if (!response.ok) throw Error('暂时无法读取图片调用记录');
      const body = await response.json();
      setItems(body.operations);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className={styles.root}
      onToggle={(event) => {
        if (event.currentTarget.open && items === null && !busy) void load();
      }}
    >
      <summary>最近图片调用</summary>
      <p>
        最近 50 次生成与编辑。Token
        为服务返回的已知用量，图片调用单独记录；不代表订阅余额或图片价格。
      </p>
      <AdminButton
        variant="quiet"
        icon="refresh"
        type="button"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? '读取中…' : '刷新记录'}
      </AdminButton>
      {error ? <p role="alert">{error}</p> : null}
      {items?.length === 0 ? (
        <p>暂无图片调用。</p>
      ) : items?.length ? (
        <div className={styles.scroll}>
          <table>
            <caption>图片调用记录</caption>
            <thead>
              <tr>
                <th>租户</th>
                <th>操作</th>
                <th>状态</th>
                <th>图片模型</th>
                <th>已知 Token</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.organizationName}</td>
                  <td>{item.operation === 'edit' ? '修改图片' : '生成图片'}</td>
                  <td title={item.errorCode ?? undefined}>
                    {statusLabels[item.status]}
                  </td>
                  <td>{item.imageModel}</td>
                  <td>
                    {item.usage
                      ? (
                          item.usage.inputTokens + item.usage.outputTokens
                        ).toLocaleString()
                      : '待核对'}
                  </td>
                  <td>{new Date(item.createdAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}
