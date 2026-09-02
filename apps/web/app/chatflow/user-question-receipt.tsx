import type { UserQuestionAnswerSubmission } from '@allrice/contracts';

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

export function UserQuestionReceipt(props: {
  answer: UserQuestionAnswerSubmission;
  createdAt: string;
  text: string;
}) {
  const rows = projectUserQuestionReceipt(props.text, props.answer);
  return (
    <div className={styles.confirmationRow}>
      <article aria-label="用户确认结果" className={styles.confirmationCard}>
        <header>
          <i aria-hidden="true">✓</i>
          <div>
            <strong>已确认</strong>
            <span>Rice 已根据你的选择继续本轮工作</span>
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
