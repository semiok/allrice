'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Input,
  Menu,
  Modal,
  IconChecklistOutlineRegular,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  TaskSuggestionDisplay,
  TaskNextStep,
  TaskNextSteps,
  WorkspaceReadiness,
} from '@allrice/contracts';
import {
  renderTaskSuggestion,
  type PreparedComposerDraft,
} from '../../lib/chatflow/composer-draft';
import { taskSuggestionPreparations } from '../../lib/chatflow/task-preparation';
import { capabilityReasons } from './capability-catalog';
import css from './task-suggestions.module.css';

type Preparation = NonNullable<TaskSuggestionDisplay['preparation']>[number];
const preparationLabels: Record<Preparation, string> = {
  files: '选择资料',
  bridge: '连接与管理电脑',
  connections: '连接应用',
};
const commonTaskCount = 3;
const commonTitles: Record<string, [string, string]> = {
  'office-word-report': ['制作 Word 报告', '写报告（Word）'],
  'office-excel-table': ['整理 Excel 表格', '整理表格（Excel）'],
  'office-ppt-report': ['制作 PPT 汇报', '做汇报（PPT）'],
  'office-word-notice': ['制作 Word 公文', '写通知或纪要（Word）'],
};
function taskTitle(task: TaskSuggestionDisplay) {
  const title = commonTitles[task.id];
  return title && task.title === title[0] ? title[1] : task.title;
}
function taskDescription(task: TaskSuggestionDisplay) {
  return task.description?.replace(/^(?:运营|财务|科研|程序员)：\s*/u, '');
}

export function TaskSuggestions({
  suggestions,
  draft,
  busy,
  compact,
  attachmentCount,
  readiness,
  onPrepare,
  onPreparation,
  nextSteps,
  onOpen,
  onPrepareNextStep,
  onOpenCompanyTemplates,
}: {
  suggestions: TaskSuggestionDisplay[];
  draft: string;
  busy: boolean;
  compact: boolean;
  attachmentCount: number;
  readiness: WorkspaceReadiness | null;
  onPrepare: (prepared: PreparedComposerDraft) => void;
  onPreparation: (preparation: Preparation) => void;
  nextSteps?: TaskNextSteps | null;
  onOpen?: () => void;
  onOpenCompanyTemplates?: () => void;
  onPrepareNextStep?: (
    step: TaskNextStep,
    snapshot: TaskNextSteps,
  ) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<TaskSuggestionDisplay[] | null>(
    null,
  );
  const [page, setPage] = useState(0);
  const [nextSnapshot, setNextSnapshot] = useState<TaskNextSteps | null>(null);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<TaskSuggestionDisplay | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [requirements, setRequirements] = useState('');
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const actionLabel = draft.length ? '追加到输入框' : '填入输入框';
  const visible = page
    ? (snapshot ?? suggestions).slice(commonTaskCount)
    : (snapshot ?? suggestions).slice(0, commonTaskCount);
  const close = () => {
    setSnapshot(null);
    setNextSnapshot(null);
    setSelected(null);
    setError('');
  };

  // The published Modal supplies mask/portal/Escape. This form supplies bounded
  // input focus and restoration because the native atom has no focus manager.
  useEffect(() => {
    if (!selected && !(snapshot && compact)) return;
    const dialog = form.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const nodes = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ].filter((node) => node.getClientRects().length);
    (
      form.current?.querySelector<HTMLElement>(
        'input,textarea,select,button',
      ) ?? nodes()[0]
    )?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = nodes(),
        first = list[0],
        last = list.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', trap);
    return () => {
      dialog.removeEventListener('keydown', trap);
      // An async next-step check may have already focused the composer before
      // passive Modal cleanup. Preserve that deliberate focus destination.
      if (
        trigger.current?.isConnected &&
        (document.activeElement === document.body ||
          dialog.contains(document.activeElement))
      )
        trigger.current.focus({ preventScroll: true });
    };
  }, [selected, snapshot, compact]);

  function pick(suggestion: TaskSuggestionDisplay) {
    if (checking) return;
    setSnapshot(null);
    setError('');
    setValues(
      Object.fromEntries(
        (suggestion.slots ?? []).map((slot) => [
          slot.name,
          slot.defaultValue ??
            (slot.required ? '' : (slot.options?.[0] ?? slot.label)),
        ]),
      ),
    );
    setRequirements('');
    setSelected(suggestion);
  }
  async function pickNext(step: TaskNextStep) {
    if (busy || checking || !nextSnapshot || !onPrepareNextStep) return;
    setChecking(true);
    setError('');
    try {
      await onPrepareNextStep(step, nextSnapshot);
      close();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '建议已变化，请关闭后重新打开。',
      );
    } finally {
      setChecking(false);
    }
  }
  function prepare() {
    if (!selected || busy) return false;
    try {
      const prepared = renderTaskSuggestion(selected, values);
      if (requirements.trim())
        prepared.text += `\n\n补充要求：${requirements.trim()}`;
      if (prepared.text.length > 40_000)
        throw Error('任务说明太长，请缩短后重试。');
      onPrepare(prepared);
      close();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请补齐参数');
      return false;
    }
  }
  function hints(suggestion: TaskSuggestionDisplay) {
    const missing = preparationEntries([suggestion])
      .filter((entry) => entry.id !== 'prepare:files' || !attachmentCount)
      .map((entry) => entry.id.slice(8) as Preparation);
    return [
      ...new Set([
        ...missing.map((id) => preparationLabels[id]),
        ...readinessHints(suggestion),
      ]),
    ].join(' · ');
  }
  function readinessHints(suggestion: TaskSuggestionDisplay) {
    if (suggestion.readiness?.length && !readiness)
      return ['发送时会核对执行条件。'];
    return [
      ...new Set(
        (suggestion.readiness ?? [])
          .map((id) => readiness?.capabilities.find((fact) => fact.id === id))
          .filter((fact) => fact && fact.state !== 'ready')
          .map((fact) => capabilityReasons[fact!.reason]),
      ),
    ];
  }
  function preparationEntries(tasks: TaskSuggestionDisplay[]): MenuEntry[] {
    return taskSuggestionPreparations(tasks, readiness).map((id) => ({
      id: `prepare:${id}`,
      label: preparationLabels[id],
    }));
  }
  function menuSelect(id: string) {
    if (checking) return;
    if (id === 'company:templates') {
      close();
      onOpenCompanyTemplates?.();
      return;
    }
    const next = nextSnapshot?.suggestions.find(
      (step) => `next:${step.task.id}` === id,
    );
    if (next) {
      void pickNext(next);
      return;
    }
    if (id === 'page:more') {
      setPage((current) => (current ? 0 : 1));
      return;
    }
    if (id.startsWith('prepare:')) {
      close();
      onPreparation(id.slice(8) as Preparation);
      return;
    }
    const suggestion = visible.find((task) => `task:${task.id}` === id);
    if (suggestion) pick(suggestion);
  }
  const footer: MenuEntry[] = [
    ...(onOpenCompanyTemplates
      ? [{ id: 'company:templates', label: '公司范本' }]
      : []),
    ...((snapshot?.length ?? 0) > commonTaskCount
      ? [
          {
            id: 'page:more',
            label: page
              ? '返回常用任务'
              : `更多任务（${snapshot!.length - commonTaskCount}）`,
          },
        ]
      : []),
  ];
  const triggerButton = (
    <button
      type="button"
      ref={trigger}
      className={css.trigger}
      disabled={
        busy ||
        checking ||
        !(
          suggestions.length ||
          nextSteps?.suggestions.length ||
          nextSteps?.notice ||
          onOpenCompanyTemplates
        )
      }
      aria-label="常用任务"
      aria-haspopup={compact ? 'dialog' : 'menu'}
      aria-expanded={!!snapshot}
      onClick={() => {
        setPage(0);
        setError('');
        if (snapshot) close();
        else {
          setSnapshot([...suggestions]);
          setNextSnapshot(nextSteps ?? null);
          onOpen?.();
        }
      }}
    >
      <IconChecklistOutlineRegular size={16} aria-hidden="true" />
      常用任务
    </button>
  );
  return (
    <div className={css.row}>
      {suggestions.length ||
      nextSteps?.suggestions.length ||
      nextSteps?.notice ||
      onOpenCompanyTemplates ? (
        compact ? (
          triggerButton
        ) : (
          <Menu
            open={!!snapshot && !busy}
            autoFocus
            side="top"
            align="start"
            portal
            listClassName={css.menu}
            anchor={triggerButton}
            onClose={close}
            items={[
              {
                type: 'label',
                id: 'heading',
                text: '选择任务，补充需求后发送',
              },
              ...visible.map((suggestion) => ({
                id: `task:${suggestion.id}`,
                disabled: checking,
                label: (
                  <span className={css.item}>
                    <strong>{taskTitle(suggestion)}</strong>
                    {taskDescription(suggestion) && (
                      <small>{taskDescription(suggestion)}</small>
                    )}
                  </span>
                ),
              })),
              ...(nextSnapshot?.suggestions.length || nextSnapshot?.notice
                ? [
                    {
                      type: 'label' as const,
                      id: 'next-heading',
                      text: '下一步建议',
                    },
                    ...(nextSnapshot.notice
                      ? [
                          {
                            type: 'label' as const,
                            id: 'next-notice',
                            text: nextSnapshot.notice,
                          },
                        ]
                      : []),
                    ...nextSnapshot.suggestions.map((step) => ({
                      id: `next:${step.task.id}`,
                      disabled: checking,
                      label: (
                        <span className={css.item}>
                          <strong>{step.task.title}</strong>
                          {step.task.description && (
                            <small>{step.task.description}</small>
                          )}
                          {step.references.map((ref) => (
                            <small key={ref.versionId}>
                              引用：{ref.fileName}
                            </small>
                          ))}
                          {hints(step.task) && (
                            <small>{hints(step.task)}</small>
                          )}
                        </span>
                      ),
                    })),
                  ]
                : []),
              ...(checking
                ? [
                    {
                      type: 'label' as const,
                      id: 'next-checking',
                      text: '正在核对已有资料…',
                    },
                  ]
                : []),
              ...(error
                ? [{ type: 'label' as const, id: 'next-error', text: error }]
                : []),
            ]}
            footer={footer}
            onSelect={menuSelect}
          />
        )
      ) : (
        <span />
      )}
      <Modal
        open={!!selected || (!!snapshot && compact)}
        title={selected ? taskTitle(selected) : '常用任务'}
        closeLabel="关闭常用任务"
        onClose={close}
        description={
          selected
            ? '补充需求后填入输入框，你可以修改再发送。'
            : '选择任务，补充需求后发送'
        }
        className={css.modal}
        contentClassName={css.modalContent}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter') event.stopPropagation();
        }}
        footer={
          selected ? (
            <Button variant="primary" disabled={busy} onClick={prepare}>
              {actionLabel}
            </Button>
          ) : undefined
        }
      >
        <div ref={form} className={css.parameters}>
          {selected ? (
            <>
              {taskDescription(selected) && <p>{taskDescription(selected)}</p>}
              {(selected.slots ?? []).map((slot) => (
                <label key={slot.name}>
                  {slot.label}
                  {slot.required ? '（必填）' : ''}
                  {slot.options ? (
                    <select
                      aria-label={slot.label}
                      value={values[slot.name] ?? ''}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [slot.name]: event.target.value,
                        }))
                      }
                    >
                      <option value="" disabled>
                        请选择
                      </option>
                      {slot.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      aria-label={slot.label}
                      value={values[slot.name] ?? ''}
                      maxLength={2000}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [slot.name]: event.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              ))}
              <label>
                补充要求（可选）
                <textarea
                  aria-label="补充要求"
                  rows={3}
                  maxLength={4000}
                  value={requirements}
                  placeholder="例如：给谁看、重点内容、格式或篇幅要求"
                  onChange={(event) => setRequirements(event.target.value)}
                />
              </label>
              <p>
                {attachmentCount
                  ? `已选择 ${attachmentCount} 份资料。`
                  : '可以直接填写要求，也可以选择资料或公司范本。'}
                选择资料或范本时，本次要求会先保存在输入框中。
              </p>
              {readinessHints(selected).length > 0 && (
                <p>{readinessHints(selected).join(' · ')}</p>
              )}
              <div className={css.preparationButtons}>
                {preparationEntries([selected]).map((entry) =>
                  'label' in entry ? (
                    <Button
                      key={entry.id}
                      disabled={busy}
                      onClick={() => {
                        if (prepare())
                          onPreparation(entry.id.slice(8) as Preparation);
                      }}
                    >
                      {entry.label}
                    </Button>
                  ) : null,
                )}
                {onOpenCompanyTemplates && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      if (prepare()) onOpenCompanyTemplates();
                    }}
                  >
                    使用公司范本
                  </Button>
                )}
              </div>
              {error && <p role="alert">{error}</p>}
            </>
          ) : (
            <>
              {visible.map((suggestion) => (
                <button
                  className={css.mobileItem}
                  type="button"
                  key={suggestion.id}
                  disabled={checking}
                  onClick={() => pick(suggestion)}
                >
                  <strong>{taskTitle(suggestion)}</strong>
                  {taskDescription(suggestion) && (
                    <small>{taskDescription(suggestion)}</small>
                  )}
                </button>
              ))}
              {nextSnapshot?.suggestions.length || nextSnapshot?.notice ? (
                <>
                  <strong>下一步建议</strong>
                  {nextSnapshot.notice && <p>{nextSnapshot.notice}</p>}
                  {nextSnapshot.suggestions.map((step) => (
                    <button
                      className={css.mobileItem}
                      type="button"
                      key={step.task.id}
                      disabled={checking}
                      onClick={() => void pickNext(step)}
                    >
                      <strong>{step.task.title}</strong>
                      {step.task.description && (
                        <small>{step.task.description}</small>
                      )}
                      {step.references.map((ref) => (
                        <small key={ref.versionId}>引用：{ref.fileName}</small>
                      ))}
                      {hints(step.task) && <small>{hints(step.task)}</small>}
                    </button>
                  ))}
                </>
              ) : null}
              {checking && <p>正在核对已有资料…</p>}
              {error && <p role="alert">{error}</p>}
              {footer.map(
                (item) =>
                  'label' in item && (
                    <Button key={item.id} onClick={() => menuSelect(item.id)}>
                      {item.label}
                    </Button>
                  ),
              )}
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
