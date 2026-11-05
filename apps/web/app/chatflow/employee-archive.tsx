'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  IconArchiveOutlineRegular,
  IconCloseOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  EmployeeDetailsProfile,
  EmployeeInstance,
} from '@allrice/contracts';
import type { Session, Workspace } from './chatflow-types';
import { EmployeeSidebar } from './employee-sidebar';
import { employeeAccentStyle } from './employee-navigation';
import { sessionEmployeeKey } from './employee-instances';
import type { useEmployeeArchive } from './use-employee-archive';
import { useSessionArchive } from './use-session-archive';
import css from './employee-archive.module.css';

type Archive = ReturnType<typeof useEmployeeArchive>;

function MutationFeedback({
  archive,
  instanceId,
}: {
  archive: Archive;
  instanceId?: string;
}) {
  const mutation = archive.mutation;
  if (!mutation || (instanceId && mutation.instanceId !== instanceId))
    return null;
  if (mutation.busy)
    return (
      <p className={css.loading} role="status" aria-busy="true">
        {mutation.operation === 'archive' ? '正在归档…' : '正在恢复…'}
      </p>
    );
  // The unconfirmed-result sentence remains a design gate. An unknown write
  // is retryable with its original requestId, never labelled failed/succeeded.
  return mutation.error ? (
    <p className={css.error} role="alert">
      {mutation.error}
    </p>
  ) : null;
}

export function EmployeeArchiveConfirmation({
  archive,
  target,
  onCancel,
  onArchived,
}: {
  archive: Archive;
  target: EmployeeDetailsProfile;
  onCancel: () => void;
  onArchived: () => void;
}) {
  const mutation =
    archive.mutation?.instanceId === target.instanceId
      ? archive.mutation
      : undefined;
  const currentTarget = mutation?.target ?? target;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const busy = Boolean(mutation?.busy);
  const close = () => {
    if (!busy) onCancel();
  };
  const submit = async () => {
    if (await archive.archive(currentTarget)) onArchived();
  };
  return (
    <Modal
      open={mounted}
      headless
      title={`归档“${currentTarget.name}”？`}
      onClose={close}
      className={`${css.panel} ${css.confirmation}`}
    >
      <header className={css.header}>
        <h2>归档“{currentTarget.name}”？</h2>
      </header>
      <div className={css.body}>
        <p className={css.description}>
          它的对话还能看，但不能继续。随时可以恢复。
        </p>
        <MutationFeedback archive={archive} instanceId={target.instanceId} />
      </div>
      <footer className={css.footer}>
        <Button
          variant="outline"
          disabled={busy}
          onClick={close}
          data-modal-autofocus
        >
          取消
        </Button>
        <Button
          variant="primary"
          disabled={busy || currentTarget.canArchive !== true}
          onClick={() => void submit()}
        >
          {busy
            ? '归档中'
            : mutation?.error || mutation?.uncertain
              ? '重试'
              : '归档'}
        </Button>
      </footer>
    </Modal>
  );
}

export function EmployeeArchiveDialog({
  archive,
  headers,
  onSessionUpdated,
  workspace,
  activeId,
  onSelectSession,
  onPrepareSession,
  onClose,
}: {
  archive: Archive;
  headers: Record<string, string>;
  onSessionUpdated: (session: Session) => void;
  workspace: Workspace;
  activeId: string | null;
  onSelectSession: (id: string) => void;
  onPrepareSession: (id: string) => void;
  onClose: () => void;
}) {
  const sessionArchive = useSessionArchive({
    workspace,
    headers,
    onUpdated: onSessionUpdated,
    selectedSession: workspace.sessions.find(
      (session) => session.id === activeId,
    ),
    initialFilter: 'only',
  });
  const [tab, setTab] = useState<'employees' | 'conversations'>('employees');
  const [employeeId, setEmployeeId] = useState<string>();
  const archived = archive.instances.filter((instance) => instance.archivedAt);
  const busy = Boolean(archive.mutation?.busy);
  const close = () => {
    if (!busy) onClose();
  };
  const showTab = (next: typeof tab) => {
    setTab(next);
    setEmployeeId(undefined);
    sessionArchive.setFilter('only');
  };
  useEffect(() => {
    if (
      employeeId &&
      !sessionArchive.loading &&
      !sessionArchive.employeePages?.[employeeId]
    )
      sessionArchive.loadPreview(employeeId);
  }, [employeeId, sessionArchive]);
  const sessions: Session[] = employeeId
    ? sessionArchive.sessions.filter(
        (session) => sessionEmployeeKey(session) === employeeId,
      )
    : sessionArchive.sessions;
  return (
    <>
      <Modal open headless title="已归档" onClose={close} className={css.panel}>
        <header className={css.header}>
          <h2>已归档</h2>
          <button
            className={css.close}
            type="button"
            aria-label="关闭归档"
            disabled={busy}
            onClick={close}
          >
            <IconCloseOutlineRegular size={18} />
          </button>
        </header>
        <div className={css.body}>
          <div className={css.tabs} role="tablist" aria-label="归档内容">
            {(['conversations', 'employees'] as const).map((key) => (
              <button
                type="button"
                role="tab"
                key={key}
                id={`employee-archive-${key}-tab`}
                aria-selected={tab === key}
                aria-controls="employee-archive-panel"
                tabIndex={tab === key ? 0 : -1}
                onClick={() => showTab(key)}
                onKeyDown={(event) => {
                  if (
                    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'conversations'
                      : event.key === 'End'
                        ? 'employees'
                        : key === 'conversations'
                          ? 'employees'
                          : 'conversations';
                  showTab(next);
                  document
                    .getElementById(`employee-archive-${next}-tab`)
                    ?.focus();
                }}
              >
                {key === 'conversations' ? '对话' : '员工'}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="employee-archive-panel"
            aria-labelledby={`employee-archive-${tab}-tab`}
          >
            {tab === 'employees' ? (
              archive.loading ? (
                <p className={css.loading} role="status" aria-busy="true">
                  正在读取…
                </p>
              ) : archive.error ? (
                <>
                  <p className={css.error} role="alert">
                    {archive.error}
                  </p>
                  <div className={css.actions}>
                    <Button variant="primary" onClick={archive.reload}>
                      重试
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {archived.length ? (
                    <div className={css.employees}>
                      {archived.map((instance) => {
                        const name = instance.profile.name ?? 'AI 员工';
                        return (
                          <article className={css.employee} key={instance.id}>
                            <span
                              className={css.avatar}
                              aria-hidden="true"
                              style={employeeAccentStyle(
                                name,
                                instance.profile.appearance?.accentColor,
                              )}
                            >
                              {Array.from(name)[0] || '员'}
                            </span>
                            <div className={css.identity}>
                              <h3>{name}</h3>
                              <span>已归档</span>
                            </div>
                            <div className={css.actions}>
                              <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => {
                                  setEmployeeId(instance.id);
                                  setTab('conversations');
                                  sessionArchive.setFilter('show');
                                }}
                              >
                                查看对话
                              </Button>
                              <Button
                                variant="primary"
                                disabled={busy}
                                onClick={() => void archive.restore(instance)}
                              >
                                恢复员工
                              </Button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={css.empty}>
                      <IconArchiveOutlineRegular size={28} />
                      <p>还没有已归档员工</p>
                    </div>
                  )}
                  {archived.length > 0 && (
                    <p className={css.retention}>
                      归档后保留记忆、技能和工作场景。
                    </p>
                  )}
                  <MutationFeedback archive={archive} />
                </>
              )
            ) : (
              <>
                {sessionArchive.error || sessionArchive.loadError ? (
                  <p className={css.error} role="alert">
                    {sessionArchive.error || sessionArchive.loadError}
                  </p>
                ) : null}
                {sessionArchive.loading ? (
                  <p className={css.loading} role="status">
                    正在读取…
                  </p>
                ) : sessions.length || employeeId ? (
                  <EmployeeSidebar
                    workspace={workspace}
                    sessions={sessions}
                    archive={sessionArchive}
                    activeId={activeId}
                    collapsed={false}
                    onlyEmployeeInstanceId={employeeId}
                    onSelectSession={onSelectSession}
                    onPrepareSession={onPrepareSession}
                  />
                ) : (
                  <div className={css.empty}>
                    <IconArchiveOutlineRegular size={28} />
                    <p>暂无已归档会话</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Modal>
      {sessionArchive.overlays}
    </>
  );
}

export function EmployeeArchiveReadOnly({
  archive,
  instance,
}: {
  archive: Archive;
  instance: EmployeeInstance;
}) {
  return (
    <div className={css.readOnly} role="status">
      <span>AI 员工已归档，可以查看历史；恢复后才能继续工作。</span>
      <Button
        variant="outline"
        disabled={Boolean(archive.mutation?.busy)}
        onClick={() => void archive.restore(instance)}
      >
        恢复员工
      </Button>
      <MutationFeedback archive={archive} instanceId={instance.id} />
    </div>
  );
}
