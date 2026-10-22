'use client';
import { useEffect, useRef, useState } from 'react';
import {
  EmployeeInstanceSchema,
  type EmployeeInstance,
} from '@allrice/contracts';
import {
  IconChevronRightOutlineRegular,
  IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { Workspace } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import {
  employeeAccent,
  employeeAccentStyle,
  employeeIntroduction,
} from './employee-navigation';
import css from './employee-sidebar.module.css';
import dialog from './compact-dialog.module.css';
import createCss from './employee-create.module.css';
import formCss from './employee-profile-form.module.css';
import {
  EmployeeProfileForm,
  defaultEmployeeProfileFormValues,
  mergeEmployeeProfileForm,
  type EmployeeProfileFormValues,
} from './employee-profile-form';
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
  const sourceId =
    (workspace.employees.find((e) => e.isDefault) ?? workspace.employees[0])
      ?.id ?? '';
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ payload: string; id: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function createEmployee(values: EmployeeProfileFormValues) {
    if (active.current || !sourceId || !values.name.trim()) return;
    const profile = mergeEmployeeProfileForm({}, values);
    const payload = JSON.stringify({
      workspaceId: workspace.workspaceId,
      assignmentId: sourceId,
      profile,
    });
    if (request.current?.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
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
          profile,
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
      key={creating ? 'create' : 'choose'}
      ariaLabel={creating ? '创建自己的 AI 员工' : '选择 AI 员工'}
      eyebrow={creating ? undefined : '新的工作'}
      title={creating ? '创建自己的 AI 员工' : '这次和谁一起工作？'}
      className={creating ? formCss.dialog : dialog.dialog}
      bodyClassName={creating ? formCss.body : dialog.body}
      onClose={() => {
        if (!active.current) onClose();
      }}
      initialFocusSelector={
        creating ? '[data-employee-name]' : '[data-create-employee]'
      }
    >
      {creating ? (
        <EmployeeProfileForm
          mode="create"
          initialValue={defaultEmployeeProfileFormValues}
          busy={busy}
          disabled={!sourceId}
          error={error}
          onSubmit={createEmployee}
          onCancel={() => {
            setError('');
            setCreating(false);
          }}
        />
      ) : (
        <>
          <div className={css.picker}>
            <button
              type="button"
              data-create-employee
              className={createCss.entry}
              disabled={!sourceId}
              onClick={() => setCreating(true)}
            >
              <IconPlusOutlineRegular size={22} />
              <span>创建自己的 AI 员工</span>
              <IconChevronRightOutlineRegular size={18} />
            </button>
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
                    (!employeeChoices(workspace).some(
                      (item) => item.isDefault,
                    ) &&
                      index === 0)
                  }
                  onClick={() => onSelect(employeeChoiceId(employee))}
                >
                  <span className={css.pickerInitial} aria-hidden="true">
                    {Array.from(manifest.name)[0]}
                  </span>
                  <span className={css.pickerCopy}>
                    <span className={css.pickerHeading}>
                      <strong className={css.pickerName}>
                        {manifest.name}
                      </strong>
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
          <p className={dialog.footer}>
            <span>选择一位员工，开始新的工作</span>
            <span className={css.pickerShortcuts}>
              <kbd>Esc</kbd> 关闭
            </span>
          </p>
        </>
      )}
    </DshDialog>
  );
}
