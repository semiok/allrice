'use client';
import { useEffect, useRef, useState } from 'react';
import {
  EmployeeInstanceSchema,
  employeeColorPalette,
  type EmployeePaletteColor,
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
  const [name, setName] = useState('');
  const [color, setColor] = useState<EmployeePaletteColor>('blue');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ payload: string; id: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function createEmployee() {
    const normalizedName = name.trim();
    if (active.current || !sourceId || !normalizedName) return;
    const profile = {
      name: normalizedName,
      expressionStyle: 'structured',
      appearance: {
        avatarType: 'initials',
        avatarValue: normalizedName.slice(0, 1),
        accentColor: color,
      },
    };
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
      eyebrow="新的工作"
      title={creating ? '创建自己的 AI 员工' : '这次和谁一起工作？'}
      className={dialog.dialog}
      bodyClassName={dialog.body}
      onClose={onClose}
      initialFocusSelector={
        creating ? '#employee-name' : '[data-create-employee]'
      }
    >
      {creating ? (
        <form
          className={createCss.form}
          onSubmit={(event) => {
            event.preventDefault();
            void createEmployee();
          }}
        >
          <label className={createCss.nameLabel} htmlFor="employee-name">
            员工名字
          </label>
          <input
            id="employee-name"
            className={createCss.nameInput}
            value={name}
            maxLength={120}
            required
            disabled={busy}
            placeholder="例如： 文案专家、财务助手、商务分析师"
            onChange={(event) => setName(event.target.value)}
          />
          <fieldset className={createCss.colors} disabled={busy}>
            <legend>员工配色</legend>
            <div className={createCss.palette}>
              {(
                Object.keys(employeeColorPalette) as EmployeePaletteColor[]
              ).map((id) => (
                <label key={id} className={createCss.colorChoice}>
                  <input
                    type="radio"
                    name="employee-color"
                    value={id}
                    checked={color === id}
                    onChange={() => setColor(id)}
                  />
                  <span
                    className={createCss.swatch}
                    style={{ backgroundColor: employeeColorPalette[id].value }}
                    aria-hidden="true"
                  >
                    {color === id ? '✓' : ''}
                  </span>
                  <span>{employeeColorPalette[id].label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div
            className={createCss.preview}
            style={employeeAccentStyle(name, color)}
            aria-label="员工预览"
          >
            <span className={createCss.avatar} aria-hidden="true">
              {name.trim().slice(0, 1) || 'A'}
            </span>
            <div>
              <strong>{name.trim() || '你的 AI 员工'}</strong>
              <p>{employeeColorPalette[color].label} · 前台识别色预览</p>
            </div>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <div className={createCss.actions}>
            <button
              type="button"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              返回
            </button>
            <button type="submit" disabled={busy || !sourceId || !name.trim()}>
              {busy ? '正在创建…' : '创建'}
            </button>
          </div>
        </form>
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
                    {manifest.name.slice(0, 1)}
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
