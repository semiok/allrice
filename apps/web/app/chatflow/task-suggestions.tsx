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
  files: '添加资料',
  bridge: '连接与管理电脑',
  connections: '连接应用',
};

export function TaskSuggestions({
  suggestions,
  draft,
  busy,
  hero,
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
  hero: boolean;
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
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const actionLabel = draft.length ? '追加到草稿' : '填写草稿';
  const visible = (snapshot ?? suggestions).slice(page * 5, page * 5 + 5);
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
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ].filter((node) => node.getClientRects().length);
    (
      form.current?.querySelector<HTMLElement>('input,select,button') ??
      nodes()[0]
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
    if (suggestion.slots?.some((slot) => slot.required && !slot.defaultValue)) {
      setValues(
        Object.fromEntries(
          (suggestion.slots ?? []).map((slot) => [
            slot.name,
            slot.defaultValue ?? '',
          ]),
        ),
      );
      setSelected(suggestion);
      return;
    }
    try {
      onPrepare(renderTaskSuggestion(suggestion));
    } catch (cause) {
      setValues(
        Object.fromEntries(
          (suggestion.slots ?? []).map((slot) => [
            slot.name,
            slot.defaultValue ?? '',
          ]),
        ),
      );
      setSelected(suggestion);
      setError(cause instanceof Error ? cause.message : '请补齐参数');
    }
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
    if (!selected || busy) return;
    try {
      const prepared = renderTaskSuggestion(selected, values);
      close();
      onPrepare(prepared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请补齐参数');
    }
  }
  function hints(suggestion: TaskSuggestionDisplay) {
    const missing = preparationEntries([suggestion])
      .filter((entry) => entry.id !== 'prepare:files' || !attachmentCount)
      .map((entry) => entry.id.slice(8) as Preparation);
    const facts = (suggestion.readiness ?? []).map((id) =>
      readiness?.capabilities.find((capability) => capability.id === id),
    );
    return [
      ...new Set([
        ...missing.map((id) => preparationLabels[id]),
        ...facts
          .filter((fact) => fact && fact.state !== 'ready')
          .map((fact) => capabilityReasons[fact!.reason]),
        ...(suggestion.readiness?.length && !readiness
          ? ['执行条件将在发送时核对；仍可填写草稿。']
          : []),
      ]),
    ].join(' · ');
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
    ...preparationEntries([
      ...visible,
      ...(nextSnapshot?.suggestions.map((s) => s.task) ?? []),
    ]),
    ...((snapshot?.length ?? 0) > 5
      ? [
          {
            id: 'page:more',
            label: page
              ? '返回常用任务'
              : `更多任务（${snapshot!.length - 5}）`,
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
      aria-label="推荐任务"
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
      推荐任务
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
                text: `常用任务 · ${actionLabel}`,
              },
              ...visible.map((suggestion) => ({
                id: `task:${suggestion.id}`,
                disabled: checking,
                label: (
                  <span className={css.item}>
                    <strong>{suggestion.title}</strong>
                    {suggestion.description && (
                      <small>{suggestion.description}</small>
                    )}
                    {hints(suggestion) && <small>{hints(suggestion)}</small>}
                  </span>
                ),
              })),
              ...(nextSnapshot?.suggestions.length || nextSnapshot?.notice
                ? [
                    {
                      type: 'label' as const,
                      id: 'next-heading',
                      text: `下一步 · ${actionLabel}`,
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
      {hero && (
        <div className={css.common}>
          {suggestions.slice(0, 3).map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              disabled={busy}
              title={`${suggestion.title} · ${actionLabel}`}
              onClick={() => pick(suggestion)}
            >
              {suggestion.title}
            </button>
          ))}
        </div>
      )}
      <Modal
        open={!!selected || (!!snapshot && compact)}
        title={selected ? selected.title : '推荐任务'}
        closeLabel="关闭推荐任务"
        onClose={close}
        description={
          selected
            ? `${actionLabel}，确认后仍需使用原发送按钮。`
            : `常用任务 · ${actionLabel}`
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
              {hints(selected) && <p>{hints(selected)}</p>}
              {preparationEntries([selected]).map((entry) =>
                'label' in entry ? (
                  <Button
                    key={entry.id}
                    onClick={() => {
                      close();
                      onPreparation(entry.id.slice(8) as Preparation);
                    }}
                  >
                    {entry.label}
                  </Button>
                ) : null,
              )}
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
                  <strong>{suggestion.title}</strong>
                  {suggestion.description && (
                    <small>{suggestion.description}</small>
                  )}
                  {hints(suggestion) && <small>{hints(suggestion)}</small>}
                </button>
              ))}
              {nextSnapshot?.suggestions.length || nextSnapshot?.notice ? (
                <>
                  <strong>下一步 · {actionLabel}</strong>
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
