import type {
  InteractionStatus,
  UserQuestionAnswerSubmission,
} from '@allrice/contracts';

import { formatTime } from './chatflow-utils';
import styles from './dsh-saas.module.css';

interface ReceiptValue {
  label: string;
  recommended: boolean;
}

export interface UserQuestionReceiptRow {
  id: string;
  title: string;
  values: ReceiptValue[];
  skipped: boolean;
}

function receiptLabel(label: string): ReceiptValue {
  const suffix =
    /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return {
    label: label.replace(suffix, ''),
    recommended: suffix.test(label),
  };
}

export function projectUserQuestionReceipt(
  text: string,
  answer: UserQuestionAnswerSubmission,
): UserQuestionReceiptRow[] {
  const titles = text
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('：');
      return separator > 0 ? line.slice(0, separator).trim() : '';
    })
    .filter(Boolean);

  return answer.answers.map((item, index) => {
    const values = item.selected.map(receiptLabel);
    if (item.custom) {
      values.push({ label: item.custom, recommended: false });
    }
    return {
      id: item.id,
      title: titles[index] ?? item.id,
      values,
      skipped: values.length === 0,
    };
  });
}

type InputStatus = InteractionStatus['inputs'][number]['status'];

/** Saving the answer is only a submission; "confirmed" needs the run to have
 * taken it (adopted, or the follow-up run that read it), MET-210. An unknown
 * outcome is neither confirmed nor refused. */
export function userQuestionReceiptState(status: InputStatus | undefined) {
  if (status === 'adopted' || status === 'running' || status === 'completed')
    return {
      state: 'confirmed',
      mark: '✓',
      title: '已确认',
      note: 'Rice 已收到你的回答',
    };
  if (status === 'unknown')
    return {
      state: 'unknown',
      mark: '?',
      title: '未能确认',
      note: '没能确认 Rice 是否收到这次回答',
    };
  if (status === 'rejected' || status === 'canceled' || status === 'failed')
    return {
      state: 'rejected',
      mark: '!',
      title: '未被采纳',
      note: '这次回答没有被 Rice 接收',
    };
  return status
    ? {
        state: 'waiting',
        mark: '…',
        title: '已提交',
        note: '等待 Rice 接收这次回答',
      }
    : { state: 'submitted', mark: '•', title: '已提交', note: '' };
}

export function UserQuestionReceipt(props: {
  answer: UserQuestionAnswerSubmission;
  createdAt: string;
  text: string;
  status?: InputStatus;
}) {
  const rows = projectUserQuestionReceipt(props.text, props.answer);
  const state = userQuestionReceiptState(props.status);
  return (
    <div className={styles.confirmationRow}>
      <article
        aria-label="用户确认结果"
        className={styles.confirmationCard}
        data-state={state.state}
      >
        <header>
          <i aria-hidden="true">{state.mark}</i>
          <div>
            <strong>{state.title}</strong>
            {state.note ? <span>{state.note}</span> : null}
          </div>
          <time>{formatTime(props.createdAt)}</time>
        </header>
        <dl>
          {rows.map((row) => (
            <div key={row.id}>
              <dt>{row.title}</dt>
              <dd>
                {row.skipped ? (
                  <span className={styles.confirmationSkipped}>已跳过</span>
                ) : (
                  row.values.map((value, index) => (
                    <span
                      className={styles.confirmationValue}
                      key={`${value.label}-${index}`}
                    >
                      {value.label}
                      {value.recommended ? <em>推荐</em> : null}
                    </span>
                  ))
                )}
              </dd>
            </div>
          ))}
        </dl>
      </article>
    </div>
  );
}
