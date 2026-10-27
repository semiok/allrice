'use client';

import { useId, useRef, useState } from 'react';
import {
  EmployeeInstanceProfileSchema,
  employeeColorPalette,
  resolveEmployeeAccent,
  type EmployeeDetailsProfile,
  type EmployeeInstanceProfile,
  type EmployeePaletteColor,
} from '@allrice/contracts';
import { employeeAccentStyle } from './employee-navigation';
import css from './employee-profile-form.module.css';

export interface EmployeeProfileFormValues {
  name: string;
  accentColor: EmployeePaletteColor;
  mission: string;
  workStyle: string;
  expressionStyle: NonNullable<EmployeeInstanceProfile['expressionStyle']>;
}

export const defaultEmployeeProfileFormValues: Readonly<EmployeeProfileFormValues> =
  {
    name: '',
    accentColor: 'blue',
    mission: '理解目标，推进工作，交付清晰、可用的结果。',
    workStyle:
      '先确认目标和资料，再分步执行；信息不足时及时说明，交付时列出待确认事项。',
    expressionStyle: 'structured',
  };

/** Resolve only the visible fields. Keep the raw profile for the write merge;
 * the effective details projection intentionally omits private source fields. */
export function employeeProfileFormFromRaw(
  raw: EmployeeInstanceProfile,
  resolved?: EmployeeDetailsProfile,
): EmployeeProfileFormValues {
  const name = raw.name ?? resolved?.name ?? '';
  return {
    name,
    accentColor: resolveEmployeeAccent(
      name,
      raw.appearance?.accentColor ?? resolved?.appearance?.accentColor,
    ),
    mission:
      raw.mission ??
      resolved?.identity.mission ??
      defaultEmployeeProfileFormValues.mission,
    workStyle:
      raw.workStyle ??
      resolved?.identity.workStyle ??
      defaultEmployeeProfileFormValues.workStyle,
    expressionStyle:
      raw.expressionStyle ??
      resolved?.expressionStyle ??
      defaultEmployeeProfileFormValues.expressionStyle,
  };
}

/** Custom-instance PATCH replaces the profile, so retain fields this form does
 * not edit. An image/emoji avatar is never replaced by an initials preview. */
export function mergeEmployeeProfileForm(
  raw: EmployeeInstanceProfile,
  values: EmployeeProfileFormValues,
): EmployeeInstanceProfile {
  const name = values.name.trim();
  const appearance = raw.appearance ?? {
    avatarType: 'initials' as const,
    avatarValue: Array.from(name)[0] || '员',
  };
  return EmployeeInstanceProfileSchema.parse({
    ...raw,
    name,
    mission: values.mission.trim(),
    workStyle: values.workStyle.trim(),
    expressionStyle: values.expressionStyle,
    appearance: {
      ...appearance,
      ...(appearance.avatarType === 'initials'
        ? { avatarValue: Array.from(name)[0] || '员' }
        : {}),
      accentColor:
        appearance.accentColor === 'indigo' && values.accentColor === 'blue'
          ? 'indigo'
          : values.accentColor,
    },
  });
}

interface EmployeeProfileFormProps {
  mode: 'create' | 'edit';
  initialValue: EmployeeProfileFormValues;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  onSubmit: (values: EmployeeProfileFormValues) => void | Promise<void>;
  onCancel: () => void;
}

/** Shared presentation for create/edit. Mount with a new key when the target or
 * saved revision changes; local drafts must not leak to a different employee. */
export function EmployeeProfileForm({
  mode,
  initialValue,
  busy = false,
  disabled = false,
  error,
  onSubmit,
  onCancel,
}: EmployeeProfileFormProps) {
  const id = useId();
  const [values, setValues] = useState(() => ({ ...initialValue }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const pending = useRef(false);
  const locked = busy || submitting;
  const name = values.name.trim();
  const update = <K extends keyof EmployeeProfileFormValues>(
    key: K,
    value: EmployeeProfileFormValues[K],
  ) => {
    setSubmitError('');
    setValues((before) => ({ ...before, [key]: value }));
  };
  return (
    <form
      className={css.form}
      aria-label={mode === 'create' ? '创建员工信息' : '编辑员工信息'}
      aria-busy={locked}
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          pending.current ||
          locked ||
          disabled ||
          !name ||
          !values.mission.trim() ||
          !values.workStyle.trim()
        )
          return;
        pending.current = true;
        setSubmitting(true);
        setSubmitError('');
        try {
          await onSubmit({
            ...values,
            name,
            mission: values.mission.trim(),
            workStyle: values.workStyle.trim(),
          });
        } catch (cause) {
          setSubmitError(
            cause instanceof Error ? cause.message : '保存未完成，请重试。',
          );
        } finally {
          pending.current = false;
          setSubmitting(false);
        }
      }}
    >
      <fieldset className={css.fields} disabled={locked}>
        <section className={css.identity} aria-label="员工基本信息">
          <div className={css.nameRow}>
            <span
              className={css.avatar}
              style={employeeAccentStyle(name, values.accentColor)}
              aria-hidden="true"
            >
              {Array.from(name)[0] || '员'}
            </span>
            <div className={css.nameField}>
              <label htmlFor={`${id}-name`}>员工名字</label>
              <input
                id={`${id}-name`}
                data-employee-name
                value={values.name}
                maxLength={120}
                required
                autoComplete="off"
                placeholder="例如： 文案专家、财务专员、商务分析师"
                onChange={(event) => update('name', event.target.value)}
              />
            </div>
          </div>
          <fieldset className={css.colors}>
            <legend>头像颜色</legend>
            <div className={css.palette}>
              {(
                Object.keys(employeeColorPalette) as EmployeePaletteColor[]
              ).map((color) => (
                <label key={color} className={css.colorChoice}>
                  <input
                    type="radio"
                    name={`${id}-color`}
                    value={color}
                    checked={values.accentColor === color}
                    onChange={() => update('accentColor', color)}
                  />
                  <span
                    className={css.swatch}
                    style={{
                      backgroundColor: employeeColorPalette[color].value,
                    }}
                    aria-hidden="true"
                  >
                    {values.accentColor === color ? '✓' : ''}
                  </span>
                  <span>{employeeColorPalette[color].label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
        <div className={css.settings}>
          <div className={css.field}>
            <label htmlFor={`${id}-mission`}>使命</label>
            <textarea
              id={`${id}-mission`}
              value={values.mission}
              rows={2}
              maxLength={500}
              required
              onChange={(event) => update('mission', event.target.value)}
            />
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-work-style`}>工作方式</label>
            <textarea
              id={`${id}-work-style`}
              value={values.workStyle}
              rows={2}
              maxLength={1_000}
              required
              onChange={(event) => update('workStyle', event.target.value)}
            />
          </div>
          <div className={css.field}>
            <label htmlFor={`${id}-expression-style`}>表达偏好</label>
            <select
              id={`${id}-expression-style`}
              value={values.expressionStyle}
              onChange={(event) =>
                update(
                  'expressionStyle',
                  event.target
                    .value as EmployeeProfileFormValues['expressionStyle'],
                )
              }
            >
              <option value="concise">简洁，结论优先</option>
              <option value="structured">结构清晰，分步说明</option>
              <option value="exploratory">比较方案与取舍</option>
            </select>
          </div>
        </div>
      </fieldset>
      {error || submitError ? <p role="alert">{error || submitError}</p> : null}
      <footer className={css.actions}>
        <button type="button" disabled={locked} onClick={onCancel}>
          取消
        </button>
        <button
          type="submit"
          disabled={
            locked ||
            disabled ||
            !name ||
            !values.mission.trim() ||
            !values.workStyle.trim()
          }
        >
          {locked
            ? mode === 'create'
              ? '正在创建…'
              : '正在保存…'
            : mode === 'create'
              ? '创建'
              : '保存'}
        </button>
      </footer>
    </form>
  );
}
