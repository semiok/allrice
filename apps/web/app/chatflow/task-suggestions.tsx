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
}) {
  const [snapshot, setSnapshot] = useState<TaskSuggestionDisplay[] | null>(
    null,
  );
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<TaskSuggestionDisplay | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const actionLabel = draft.length ? '追加到草稿' : '填写草稿';
  const visible = (snapshot ?? suggestions).slice(page * 5, page * 5 + 5);
  const close = () => {
    setSnapshot(null);
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
      if (trigger.current?.isConnected)
        trigger.current.focus({ preventScroll: true });
    };
  }, [selected, snapshot, compact]);

  function pick(suggestion: TaskSuggestionDisplay) {
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
    ...preparationEntries(visible),
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
      disabled={busy || !suggestions.length}
      aria-label="推荐任务"
      aria-haspopup={compact ? 'dialog' : 'menu'}
      aria-expanded={!!snapshot}
      onClick={() => {
        setPage(0);
        setSnapshot((current) => (current ? null : [...suggestions]));
      }}
    >
      <IconChecklistOutlineRegular size={16} aria-hidden="true" />
      推荐任务
    </button>
  );
  return (
    <div className={css.row}>
      {suggestions.length ? (
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
            onClose={() => setSnapshot(null)}
            items={[
              {
                type: 'label',
                id: 'heading',
                text: `常用任务 · ${actionLabel}`,
              },
              ...visible.map((suggestion) => ({
                id: `task:${suggestion.id}`,
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
                  onClick={() => pick(suggestion)}
                >
                  <strong>{suggestion.title}</strong>
                  {suggestion.description && (
                    <small>{suggestion.description}</small>
                  )}
                  {hints(suggestion) && <small>{hints(suggestion)}</small>}
                </button>
              ))}
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
