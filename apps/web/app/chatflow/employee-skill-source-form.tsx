'use client';

import { useId, useRef, type ReactNode } from 'react';
import { Button, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './employee-skills-host.module.css';

export interface EmployeeSkillSourceDraft {
  tab: 'github' | 'zip';
  github: string;
  file: File | null;
}

export function EmployeeSkillPage({
  title,
  backLabel,
  blocked = false,
  onBack,
  children,
  footer,
}: {
  title: string;
  backLabel?: string;
  blocked?: boolean;
  onBack: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className={css.page}>
      <header className={css.header}>
        {backLabel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={css.back}
            aria-label={backLabel}
            disabled={blocked}
            onClick={onBack}
            data-modal-autofocus
            icon={
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m10 5-7 7 7 7M3 12h18" />
              </svg>
            }
          />
        )}
        <h2>{title}</h2>
      </header>
      <div className={css.body}>{children}</div>
      {footer && <footer className={css.footer}>{footer}</footer>}
    </div>
  );
}

/** The public native card remains focusable while an explicit action disables
 * its controls. No trap or document keyboard listener is added here. */
export function focusEmployeeSkillDialog(control: HTMLElement) {
  control
    .closest<HTMLElement>('[role="dialog"]')
    ?.focus({ preventScroll: true });
}

export function EmployeeSkillFeedback({
  busy,
  children,
}: {
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={busy ? css.loading : css.error}
      role={busy ? 'status' : 'alert'}
      aria-busy={busy || undefined}
    >
      {busy && <span className={css.spinner} aria-hidden="true" />}
      <p>{children}</p>
    </div>
  );
}

/** A real File is retained only in the current page. Selection never submits,
 * reads an archive, creates a preview or writes an installation. */
export function EmployeeSkillSourceForm({
  operation,
  name,
  draft,
  reading,
  error,
  onChange,
  onRead,
  onBack,
}: {
  operation: 'install' | 'update';
  name?: string;
  draft: EmployeeSkillSourceDraft;
  reading: boolean;
  error?: string;
  onChange: (draft: EmployeeSkillSourceDraft) => void;
  onRead: () => void;
  onBack: () => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const zip = draft.tab === 'zip';
  const choose = () => fileInput.current?.click();
  return (
    <EmployeeSkillPage
      title={operation === 'update' ? `更新“${name ?? '未提供'}”` : '添加技能'}
      backLabel={operation === 'update' ? '返回技能详情' : '返回员工详情'}
      onBack={onBack}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onBack}>
            取消
          </Button>
          {zip && draft.file && (
            <Button
              type="button"
              variant="outline"
              disabled={reading}
              onClick={choose}
            >
              重新选择
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={reading || (zip && !draft.file)}
            onClick={(event) => {
              focusEmployeeSkillDialog(event.currentTarget);
              onRead();
            }}
          >
            {reading ? '读取中' : error ? '重试' : '读取'}
          </Button>
        </>
      }
    >
      <fieldset className={css.tabsField} disabled={reading}>
        <SegmentedTabs
          label="安装来源"
          value={draft.tab}
          onChange={(tab) => onChange({ ...draft, tab })}
          className={css.tabs}
          items={[
            {
              value: 'github',
              label: 'GitHub 链接',
              id: `${id}-github`,
              panelId: `${id}-panel`,
            },
            {
              value: 'zip',
              label: '压缩包',
              id: `${id}-zip`,
              panelId: `${id}-panel`,
            },
          ]}
        />
      </fieldset>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${draft.tab}`}
      >
        <input
          ref={fileInput}
          className={css.fileInput}
          type="file"
          accept=".zip"
          tabIndex={-1}
          aria-label="选择 ZIP 文件"
          disabled={reading}
          onChange={(event) => {
            const file = event.currentTarget.files?.item(0);
            if (file) onChange({ ...draft, file });
            event.currentTarget.value = '';
          }}
        />
        {zip ? (
          <>
            {draft.file ? (
              <div className={css.fileRow}>
                <span>{draft.file.name}</span>
                {reading && <span className={css.caption}>正在读取…</span>}
              </div>
            ) : (
              <div
                className={css.drop}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files.item(0);
                  if (file && !reading) onChange({ ...draft, file });
                }}
              >
                <p>把 .zip 文件拖到这里</p>
                <Button type="button" variant="outline" onClick={choose}>
                  选择文件
                </Button>
              </div>
            )}
            <p className={css.help}>根目录要有 SKILL.md，压缩包不超过 8 MB。</p>
          </>
        ) : (
          <>
            <div className={css.field}>
              <label htmlFor={`${id}-url`}>仓库链接</label>
              <input
                id={`${id}-url`}
                className={css.input}
                type="text"
                inputMode="url"
                value={draft.github}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://github.com/账号/仓库"
                readOnly={reading}
                onChange={(event) =>
                  onChange({ ...draft, github: event.target.value })
                }
              />
            </div>
            <p className={css.help}>
              目前只支持公开仓库，根目录要有 SKILL.md。
            </p>
          </>
        )}
        {reading && (
          <EmployeeSkillFeedback busy>正在读取…</EmployeeSkillFeedback>
        )}
        {error && <EmployeeSkillFeedback>{error}</EmployeeSkillFeedback>}
        <section className={css.limits} aria-label="文件要求">
          <h3>文件要求</h3>
          <p>
            正文不超过 256 KB；资源最多 32 个，每个不超过 128 KB，合计不超过 512
            KB。压缩包不超过 8 MB。
          </p>
        </section>
      </div>
    </EmployeeSkillPage>
  );
}
