'use client';
import { useEffect, useRef, useState } from 'react';
import {
  EmployeeInstanceSchema,
  type EmployeeInstance,
} from '@allrice/contracts';
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Workspace } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import {
  employeeAccent,
  employeeAccentStyle,
  employeeIntroduction,
} from './employee-navigation';
import css from './employee-sidebar.module.css';
import dialog from './compact-dialog.module.css';
import {
  employeeChoices,
  employeeChoiceId,
  employeeChoiceProfile,
} from './employee-instances';
import { readJson } from './chatflow-utils';

export function EmployeePickerDialog({
  workspace,
  onClose,
  onSelect,
  onCreated,
  headers,
}: {
  workspace: Workspace;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreated: (instance: EmployeeInstance) => void;
  headers: Record<string, string>;
}) {
  const [sourceId, setSourceId] = useState(
    () =>
      (workspace.employees.find((e) => e.isDefault) ?? workspace.employees[0])
        ?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ sourceId: string; id: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function createXiaobai() {
    if (active.current || !workspace.employees.some((e) => e.id === sourceId))
      return;
    if (request.current?.sourceId !== sourceId)
      request.current = { sourceId, id: crypto.randomUUID() };
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/employee-instances', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          assignmentId: sourceId,
          requestId: request.current.id,
          profile: { name: '小白', expressionStyle: 'structured' },
        }),
      });
      const result = await readJson<{ instance: EmployeeInstance }>(response);
      if (!controller.signal.aborted)
        onCreated(EmployeeInstanceSchema.parse(result.instance));
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '创建未完成，请重试。',
        );
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <DshDialog
      ariaLabel="选择 AI 员工"
      eyebrow="新的工作"
      title="这次和谁一起工作？"
      className={dialog.dialog}
      bodyClassName={dialog.body}
      onClose={onClose}
      initialFocusSelector="[data-default-employee='true']"
    >
      <div className={css.picker}>
        {employeeChoices(workspace).map((employee, index) => {
          const profile = employeeChoiceProfile(
            workspace,
            employeeChoiceId(employee),
          );
          const manifest = employee.currentVersion.manifest;
          const description = employeeIntroduction(employee, profile);
          return (
            <button
              type="button"
              key={employeeChoiceId(employee)}
              className={css.pickerCard}
              data-accent={employeeAccent(
                manifest.name,
                manifest.appearance?.accentColor,
              )}
              style={employeeAccentStyle(
                manifest.name,
                manifest.appearance?.accentColor,
              )}
              data-default-employee={
                employee.isDefault ||
                (!employeeChoices(workspace).some((item) => item.isDefault) &&
                  index === 0)
              }
              onClick={() => onSelect(employeeChoiceId(employee))}
            >
              <span className={css.pickerInitial} aria-hidden="true">
                {manifest.name.slice(0, 1)}
              </span>
              <span className={css.pickerCopy}>
                <span className={css.pickerHeading}>
                  <strong className={css.pickerName}>{manifest.name}</strong>
                  {employee.isDefault ? (
                    <span className={css.pickerBadge}>默认</span>
                  ) : null}
                </span>
                <span className={css.pickerDescription}>{description}</span>
              </span>
              <span className={css.pickerAction} aria-hidden="true">
                <span>开始</span>
                <IconChevronRightOutlineRegular size={18} />
              </span>
            </button>
          );
        })}
      </div>
      <section className={css.createPersonal} aria-label="创建自己的小白">
        <div>
          <strong>创建自己的小白</strong>
          <p>
            从现有员工能力开始，通过聊天调整名称和表达方式。只属于你，可以创建多个。
          </p>
        </div>
        {workspace.employees.length > 1 ? (
          <label>
            基础员工
            <select
              aria-label="小白的基础员工"
              value={sourceId}
              disabled={busy}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {workspace.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.currentVersion.manifest.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={busy || !sourceId}
          onClick={() => void createXiaobai()}
        >
          {busy ? '正在创建…' : '创建小白'}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
      <p className={dialog.footer}>
        <span>选择一位员工，开始新的工作</span>
        <span className={css.pickerShortcuts}>
          <kbd>Esc</kbd> 关闭
        </span>
      </p>
    </DshDialog>
  );
}
