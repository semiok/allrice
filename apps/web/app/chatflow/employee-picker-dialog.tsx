'use client';
import { useEffect } from 'react';
import type { Workspace } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import { employeeAccent } from './employee-navigation';
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
      eyebrow="新的工作"
      title="这次和谁一起工作？"
      className={css.pickerDialog}
      bodyClassName={css.pickerBody}
      onClose={onClose}
      initialFocusSelector="[data-default-employee='true']"
    >
      <div className={css.picker}>
        {workspace.employees.map((employee, index) => {
          const profile = workspace.employeeProfiles.find(
            (item) => item.assignmentId === employee.id,
          );
          const manifest = employee.currentVersion.manifest;
          const description = (
            profile?.description?.trim() ||
            manifest.description?.trim() ||
            profile?.identity.mission?.trim() ||
            profile?.identity.role?.trim() ||
            '告诉我你的目标，一起把工作完成。'
          )
            .split(/\r?\n|(?<=[。！？])/u)[0]!
            .trim();
          return (
            <button
              type="button"
              key={employee.id}
              className={css.pickerCard}
              data-accent={employeeAccent(manifest.name)}
              data-default-employee={
                employee.isDefault ||
                (!workspace.employees.some((item) => item.isDefault) &&
                  index === 0)
              }
              onClick={() => onSelect(employee.id)}
            >
              <span className={css.pickerCardTop}>
                <span className={css.pickerInitial} aria-hidden="true">
                  {manifest.name.slice(0, 1)}
                </span>
                {employee.isDefault ? (
                  <span className={css.pickerBadge}>默认员工</span>
                ) : null}
              </span>
              <strong className={css.pickerName}>{manifest.name}</strong>
              <span className={css.pickerDescription}>{description}</span>
              <span className={css.pickerAction} aria-hidden="true">
                开始工作 <span>↗</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className={css.hint}>
        <span>选择一位员工，开始新的工作</span>
        <span className={css.pickerShortcuts}>
          <kbd>1–9</kbd> 快选 <kbd>Esc</kbd> 关闭
        </span>
      </p>
    </DshDialog>
  );
}
