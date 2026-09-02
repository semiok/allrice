'use client';

import { useState } from 'react';

import type {
  UserQuestionAnswerSubmission,
  UserQuestionItem,
} from '@allrice/contracts';

import type { PendingUserQuestion } from '../../lib/chatflow/user-question-state';

import { AssistantMarkdown } from './assistant-markdown';
import styles from './dsh-saas.module.css';

interface DraftAnswer {
  selected: string[];
  custom: string;
  skipped: boolean;
}

interface UserQuestionComposerProps {
  busy: boolean;
  error: string;
  pending: PendingUserQuestion;
  onCancelRun: () => void | Promise<void>;
  onSubmit: (answer: UserQuestionAnswerSubmission) => void | Promise<void>;
}

function recommendedLabel(label: string) {
  const suffix =
    /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return {
    label: label.replace(suffix, ''),
    recommended: suffix.test(label),
  };
}

function answered(draft: DraftAnswer) {
  return draft.selected.length > 0 || draft.custom.trim().length > 0;
}

function answerItem(question: UserQuestionItem, draft: DraftAnswer) {
  if (draft.skipped) return { id: question.id, selected: [] };
  const custom = draft.custom.trim();
  return {
    id: question.id,
    selected: custom && !question.multiSelect ? [] : [...draft.selected],
    ...(custom ? { custom } : {}),
  };
}

export function userQuestionAnswerText(
  questions: UserQuestionItem[],
  answer: UserQuestionAnswerSubmission,
) {
  const answers = new Map(answer.answers.map((item) => [item.id, item]));
  return questions
    .map((question) => {
      const value = answers.get(question.id);
      const parts = [...(value?.selected ?? [])];
      if (value?.custom) parts.push(value.custom);
      return `${question.header ?? question.question}：${parts.join('、') || '跳过'}`;
    })
    .join('\n');
}

export function UserQuestionComposer({
  busy,
  error,
  pending,
  onCancelRun,
  onSubmit,
}: UserQuestionComposerProps) {
  const questions = pending.questions;
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() =>
    questions.map(() => ({ selected: [], custom: '', skipped: false })),
  );
  const [validation, setValidation] = useState('');
  const question = questions[index]!;
  const draft = drafts[index]!;

  const replaceDraft = (next: DraftAnswer) => {
    setDrafts((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? next : item)),
    );
    setValidation('');
  };

  const submit = (values: DraftAnswer[]) => {
    const incomplete = values.findIndex(
      (value) => !value.skipped && !answered(value),
    );
    if (incomplete >= 0) {
      setIndex(incomplete);
      setValidation('请选择一个选项、填写答案，或跳过本题。');
      return;
    }
    void onSubmit({
      questionId: pending.questionId,
      answers: questions.map((item, itemIndex) =>
        answerItem(item, values[itemIndex]!),
      ),
    });
  };

  const continueFlow = () => {
    if (!answered(draft)) {
      setValidation('请选择一个选项或填写答案。');
      return;
    }
    if (index < questions.length - 1) {
      setIndex(index + 1);
      setValidation('');
      return;
    }
    submit(drafts);
  };

  const skip = () => {
    const next = drafts.map((value, itemIndex) =>
      itemIndex === index ? { selected: [], custom: '', skipped: true } : value,
    );
    setDrafts(next);
    setValidation('');
    if (index < questions.length - 1) {
      setIndex(index + 1);
    } else {
      submit(next);
    }
  };

  return (
    <div className={styles.userQuestionFrame}>
      <section
        aria-labelledby={`user-question-${pending.questionId}-${index}`}
        className={styles.userQuestionCard}
      >
        <header className={styles.userQuestionHeader}>
          <div>
            <span>{question.header ?? 'Rice 需要你确认'}</span>
            <h2 id={`user-question-${pending.questionId}-${index}`}>
              {question.question}
            </h2>
          </div>
          {questions.length > 1 ? (
            <strong>
              {index + 1} / {questions.length}
            </strong>
          ) : null}
        </header>

        <div className={styles.userQuestionBody}>
          {question.detail ? (
            <div className={styles.userQuestionDetail}>
              <AssistantMarkdown text={question.detail} />
            </div>
          ) : null}
          <div
            aria-label={question.question}
            className={styles.userQuestionOptions}
            role={question.multiSelect ? 'group' : 'radiogroup'}
          >
            {(question.options ?? []).map((option, optionIndex) => {
              const selected = draft.selected.includes(option.label);
              const display = recommendedLabel(option.label);
              return (
                <button
                  aria-checked={selected}
                  className={`${styles.userQuestionOption} ${
                    selected ? styles.userQuestionOptionSelected : ''
                  }`}
                  disabled={busy}
                  key={`${option.label}-${optionIndex}`}
                  onClick={() => {
                    if (question.multiSelect) {
                      replaceDraft({
                        ...draft,
                        selected: selected
                          ? draft.selected.filter(
                              (label) => label !== option.label,
                            )
                          : [...draft.selected, option.label],
                        skipped: false,
                      });
                    } else {
                      replaceDraft({
                        selected: [option.label],
                        custom: '',
                        skipped: false,
                      });
                    }
                  }}
                  role={question.multiSelect ? 'checkbox' : 'radio'}
                  type="button"
                >
                  <i aria-hidden="true">
                    {question.multiSelect
                      ? selected
                        ? '✓'
                        : ''
                      : optionIndex + 1}
                  </i>
                  <span>
                    <strong>{display.label}</strong>
                    {display.recommended ? <em>推荐</em> : null}
                    {option.description ? (
                      <small>{option.description}</small>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          <textarea
            aria-label="自定义答案"
            className={styles.userQuestionCustom}
            disabled={busy}
            onChange={(event) =>
              replaceDraft({
                ...draft,
                selected: question.multiSelect ? draft.selected : [],
                custom: event.target.value,
                skipped: false,
              })
            }
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return;
              event.preventDefault();
              continueFlow();
            }}
            placeholder={
              question.options?.length ? '或者输入其他答案' : '输入你的答案'
            }
            rows={2}
            value={draft.custom}
          />
        </div>

        <footer className={styles.userQuestionFooter}>
          <div className={styles.userQuestionNavigation}>
            {index > 0 ? (
              <button
                disabled={busy}
                onClick={() => {
                  setIndex(index - 1);
                  setValidation('');
                }}
                type="button"
              >
                上一题
              </button>
            ) : null}
            <button disabled={busy} onClick={skip} type="button">
              跳过本题
            </button>
            <button
              disabled={busy}
              onClick={() => void onCancelRun()}
              type="button"
            >
              停止本轮
            </button>
          </div>
          <div className={styles.userQuestionSubmit}>
            {validation || error ? (
              <small role="status">{validation || error}</small>
            ) : null}
            <button
              disabled={busy || !answered(draft)}
              onClick={continueFlow}
              type="button"
            >
              {busy
                ? '正在提交…'
                : index < questions.length - 1
                  ? '下一题'
                  : '提交并继续'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
