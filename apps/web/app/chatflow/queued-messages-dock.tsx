'use client';

// Adapter of DeepSeek DSH QueueDock.tsx (MIT), pinned in upstream.json.
// Retains native geometry, icons, collapsed list and awaited per-row actions.
// Allrice supplies the durable inbox; Edit extracts back to the full composer
// so file attachments remain editable with the message.
import { useId, useState } from 'react';
import type { QueuedMessage } from './chatflow-types';
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconEditOutline16,
  IconTrashOutline16,
  IconSendOutline14,
  IconQueueOutline14,
} from './dsh-upstream/QueueIcons';
import css from './dsh-upstream/QueueDock.module.css';

export function QueuedMessagesDock({
  items: queue,
  canSteer,
  canEdit,
  busy: composerBusy,
  updateQueue,
}: {
  items: QueuedMessage[];
  canSteer: boolean;
  canEdit: boolean;
  busy: boolean;
  updateQueue: (
    item: QueuedMessage,
    action: 'edit' | 'remove' | 'steer',
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [error, setError] = useState('');
  const listId = useId();
  if (!queue.length && !error) return null;
  const expanded = !collapsed || busy !== null;
  const listVisible = queue.length === 1 || expanded;
  const applyAction = async (
    item: QueuedMessage,
    action: 'edit' | 'remove' | 'steer',
  ) => {
    setBusy(item.id);
    setError('');
    try {
      await updateQueue(item, action);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '操作失败，消息仍在队列中。',
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={css.dock} data-queue-dock="" aria-label="排队消息">
      <div className={css.panel}>
        {error ? (
          <div className={css.header} role="alert">
            {error}
          </div>
        ) : null}
        {queue.length > 1 && (
          <button
            type="button"
            className={css.header}
            title="当前任务结束后依次发送"
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={busy !== null}
            onClick={() => setCollapsed((v) => !v)}
          >
            <span className={css.lead} aria-hidden>
              <IconQueueOutline14 />
            </span>
            <span className={css.count}>排队消息 · {queue.length}</span>
            <span className={css.chevron} aria-hidden>
              {expanded ? (
                <IconChevronDownOutline14 />
              ) : (
                <IconChevronUpOutline14 />
              )}
            </span>
          </button>
        )}
        <ul id={listId} className={css.list} hidden={!listVisible}>
          {listVisible &&
            queue.map((row) => {
              const preview = [
                row.text,
                ...(row.attachments ?? []).map((a) => `📎 ${a.fileName}`),
              ].join('　');
              const steerUnavailable = row.attachments?.length
                ? '含附件的消息会作为下一轮任务处理'
                : !canSteer
                  ? '等待当前回合开始后可引导'
                  : undefined;
              return (
                <li
                  key={row.id}
                  className={css.row}
                  data-queued-message={row.id}
                >
                  {queue.length === 1 && (
                    <span
                      className={css.lead}
                      aria-hidden
                      title="当前任务结束后发送"
                    >
                      <IconQueueOutline14 />
                    </span>
                  )}
                  <span className={css.preview} title={preview}>
                    {preview}
                  </span>
                  <div className={css.actions}>
                    <button
                      type="button"
                      className={css.action}
                      aria-label="立即引导"
                      title={steerUnavailable ?? '补充／纠正当前回合'}
                      disabled={
                        composerBusy ||
                        busy !== null ||
                        Boolean(steerUnavailable)
                      }
                      onClick={() => void applyAction(row, 'steer')}
                    >
                      <IconSendOutline14 />
                    </button>
                    <button
                      type="button"
                      className={css.action}
                      aria-label="重新编辑"
                      title={
                        canEdit ? '取回输入框编辑' : '请先发送或清空当前草稿'
                      }
                      disabled={composerBusy || busy !== null || !canEdit}
                      onClick={() => void applyAction(row, 'edit')}
                    >
                      <IconEditOutline16 size={14} />
                    </button>
                    <button
                      type="button"
                      className={css.action}
                      aria-label="撤回消息"
                      title="撤回，不再执行"
                      disabled={composerBusy || busy !== null}
                      onClick={() => void applyAction(row, 'remove')}
                    >
                      <IconTrashOutline16 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
}
