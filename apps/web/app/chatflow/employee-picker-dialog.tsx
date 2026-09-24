'use client';
import { useEffect } from 'react';
import type { Workspace } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import css from './employee-sidebar.module.css';

export function EmployeePickerDialog({
  workspace,
  onClose,
  onSelect,
}: {
  workspace: Workspace;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      if (!/^[1-9]$/.test(event.key)) return;
      const employee = workspace.employees[Number(event.key) - 1];
      if (employee) {
        event.preventDefault();
        onSelect(employee.id);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [workspace.employees, onSelect]);
  return (
    <DshDialog
      ariaLabel="选择 AI 员工"
      title="选择处理这项工作的 AI 员工"
      onClose={onClose}
      initialFocusSelector="[data-default-employee='true']"
    >
      <div className={css.picker}>
        {workspace.employees.map((employee, index) => {
          const profile = workspace.employeeProfiles.find(
            (item) => item.assignmentId === employee.id,
          );
          return (
            <button
              type="button"
              key={employee.id}
              className={css.card}
              data-default-employee={
                employee.isDefault ||
                (!workspace.employees.some((item) => item.isDefault) &&
                  index === 0)
              }
              onClick={() => onSelect(employee.id)}
            >
              <strong>
                {employee.currentVersion.manifest.name}
                {employee.isDefault ? ' · 默认员工' : ''}
              </strong>
              <span>
                {profile?.identity.role ??
                  employee.currentVersion.manifest.description}
              </span>
              {profile?.skills.length ? (
                <small>
                  擅长：{profile.skills.map((skill) => skill.name).join('、')}
                </small>
              ) : null}
              <small>{index < 9 ? `${index + 1} · ` : ''}开始工作</small>
            </button>
          );
        })}
      </div>
      <p className={css.hint}>
        按数字键 1–9 快速选择，Enter 确认当前选项，Esc 取消。
      </p>
    </DshDialog>
  );
}
