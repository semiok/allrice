import type { ReactNode } from 'react';
import {
  Button,
  IconQuestionOutlineRegular,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconWarningOutlineRegular,
  IconThinkOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import shell from './dsh-saas.module.css';
import css from './memory-write-receipt.module.css';

/** Display of an existing memory read/write receipt, never write authority. */
export function MemoryWriteReceipt(props: {
  id: string;
  phase:
    | 'candidate'
    | 'confirming'
    | 'remembered'
    | 'discarded'
    | 'failed'
    | 'unknown';
  content?: string;
  error?: string;
  canWrite?: boolean;
  canConfirm?: boolean;
  onConfirm?: () => void;
  onDelete?: () => void;
  onRefresh?: () => void;
  children?: ReactNode;
}) {
  const { phase } = props;
  const busy = phase === 'confirming';
  const discarded = phase === 'discarded';
  const active = phase === 'remembered';
  const failed = phase === 'failed';
  const uncertain = phase === 'unknown';
  const label = {
    candidate: '待确认',
    confirming: '确认中...',
    remembered: '已确认',
    discarded: '已放弃',
    failed: '确认失败',
    unknown: '结果待确认',
  }[phase];
  const Icon = discarded
    ? IconCloseOutlineRegular
    : busy
      ? IconThinkOutlineRegular
      : failed || uncertain
        ? IconWarningOutlineRegular
        : active
          ? IconCheckOutlineRegular
          : IconQuestionOutlineRegular;
  return (
    <article
      className={css.card}
      data-memory-id={props.id}
      data-memory-state={phase}
      aria-busy={busy}
    >
      <header className={css.heading}>
        <Icon size={16} className={busy ? shell.processPulse : undefined} />
        <span>
          记忆写入
          <span className={failed ? css.error : undefined}>
            {' · '}
            {label}
          </span>
        </span>
      </header>
      {!discarded && <p className={css.content}>{props.content}</p>}
      {discarded ? (
        <p className={css.hint}>这条候选不会生效。</p>
      ) : (
        !active &&
        !props.error && <p className={css.hint}>确认后用于后续相关对话。</p>
      )}
      {props.error && !discarded && (
        <p role="alert" className={uncertain ? css.hint : css.error}>
          {props.error}
        </p>
      )}
      {!discarded && !active && props.canWrite && (
        <div className={css.actions}>
          {props.error ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={props.onRefresh}
            >
              重新读取
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={props.onDelete}
              >
                放弃
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={busy || !props.canConfirm}
                onClick={props.onConfirm}
              >
                {busy ? '确认中...' : '确认'}
              </Button>
            </>
          )}
        </div>
      )}
      {props.children}
    </article>
  );
}
