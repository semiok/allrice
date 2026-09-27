'use client';
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

export function EmployeePickerDialog({
  workspace,
  onClose,
  onSelect,
}: {
  workspace: Workspace;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
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
        {workspace.employees.map((employee, index) => {
          const profile = workspace.employeeProfiles.find(
            (item) => item.assignmentId === employee.id,
          );
          const manifest = employee.currentVersion.manifest;
          const description = employeeIntroduction(employee, profile);
          return (
            <button
              type="button"
              key={employee.id}
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
                (!workspace.employees.some((item) => item.isDefault) &&
                  index === 0)
              }
              onClick={() => onSelect(employee.id)}
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
      <p className={dialog.footer}>
        <span>选择一位员工，开始新的工作</span>
        <span className={css.pickerShortcuts}>
          <kbd>Esc</kbd> 关闭
        </span>
      </p>
    </DshDialog>
  );
}
