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
import createCss from './employee-create.module.css';

export interface EmployeeProfileFormValues {
  name: string;
  accentColor: EmployeePaletteColor;
  mission: string;
  workStyle: string;
  expressionStyle: NonNullable<EmployeeInstanceProfile['expressionStyle']>;
}

export type EmployeeProfileEditedFields = ReadonlySet<
  keyof EmployeeProfileFormValues
>;

export const defaultEmployeeProfileFormValues: Readonly<EmployeeProfileFormValues> =
  {
    name: '',
    accentColor: 'blue',
    mission: '理解目标，推进工作，交付清晰、可用的结果。',
    workStyle:
      '先确认目标和资料，再分步执行；信息不足时及时说明，交付时列出待确认事项。',
    expressionStyle: 'structured',
  };

/** Empty optional creation overrides inherit the existing base persona. Editing
 * continues to use the strict merge below and never accepts an empty workStyle. */
export function createEmployeeProfile(values: EmployeeProfileFormValues) {
  const name = values.name.trim();
  const workStyle = values.workStyle.trim();
  return EmployeeInstanceProfileSchema.parse({
    name,
    mission: values.mission.trim(),
    ...(workStyle ? { workStyle } : {}),
    expressionStyle: values.expressionStyle,
    appearance: {
      avatarType: 'initials',
      avatarValue: Array.from(name)[0] || '员',
      accentColor: values.accentColor,
    },
  });
}

const creationParts = [
  ['2', '技能 Skills', '它会的本事，干活时自己判断要不要用。', '自带基础技能，可再添加'],
  ['3', '工作场景 Workflow', '安装一个 Workflow，它就能按固定流程干活。', '一开始没有，可添加'],
  ['4', '插件 Plugins', '带有独立界面的工具，点击打开新页面。', '一开始没有'],
  ['5', '记忆 Memory', '工作中它提出想记住的内容，你确认后生效。', '一开始是空的，最多 100 条'],
] as const;

/** Full-form access comes from the current owner projection, never the saved
 * values, instance kind or a mutable employee name. Missing capability is closed. */
export function canEditEmployeePersona(profile: EmployeeDetailsProfile) {
  return (
    profile.canMaintainPersonal &&
    ['name', 'appearance', 'mission', 'workStyle', 'expressionStyle'].every(
      (field) => profile.editableFields?.some((allowed) => allowed === field),
    )
  );
}

export function canResetEmployeePersona(profile: EmployeeDetailsProfile) {
  return profile.isDefaultRice === true && canEditEmployeePersona(profile);
}

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

/** Editing general instances sends a patch; custom instances replace the raw
 * profile. Displayed inherited values are never added by an untouched field.
 * Without edit metadata, retain the existing complete new-employee payload. */
export function mergeEmployeeProfileForm(
  raw: EmployeeInstanceProfile,
  values: EmployeeProfileFormValues,
  resolved?: EmployeeDetailsProfile,
  editedFields?: EmployeeProfileEditedFields,
): EmployeeInstanceProfile {
  const changed = (field: keyof EmployeeProfileFormValues) =>
    editedFields === undefined || editedFields.has(field);
  const name = values.name.trim();
  const profile: EmployeeInstanceProfile =
    editedFields !== undefined && resolved?.kind === 'general'
      ? {}
      : { ...raw };
  if (changed('name')) profile.name = name;
  if (changed('mission')) profile.mission = values.mission.trim();
  if (changed('workStyle')) profile.workStyle = values.workStyle.trim();
  if (changed('expressionStyle'))
    profile.expressionStyle = values.expressionStyle;
  // Preserve the existing rename behavior only for an already personal initials
  // avatar. Merely displaying an inherited avatar does not create an override.
  const renameInitials =
    changed('name') && raw.appearance?.avatarType === 'initials';
  if (changed('accentColor') || renameInitials) {
    if (editedFields !== undefined) {
      profile.appearance = {
        ...(resolved?.kind === 'general' ? {} : raw.appearance),
        ...(renameInitials ? { avatarValue: Array.from(name)[0] || '员' } : {}),
        ...(changed('accentColor') ? { accentColor: values.accentColor } : {}),
      };
    } else {
      const appearance = raw.appearance ??
        resolved?.appearance ?? {
          avatarType: 'initials' as const,
          avatarValue: Array.from(name)[0] || '员',
        };
      profile.appearance = {
        ...appearance,
        ...(appearance.avatarType === 'initials' && changed('name')
          ? { avatarValue: Array.from(name)[0] || '员' }
          : {}),
        ...(changed('accentColor')
          ? {
              accentColor:
                appearance.accentColor === 'indigo' &&
                values.accentColor === 'blue'
                  ? 'indigo'
                  : values.accentColor,
            }
          : {}),
      };
    }
  }
  return EmployeeInstanceProfileSchema.parse(profile);
}

interface EmployeeProfileFormProps {
  mode: 'create' | 'edit';
  initialValue: EmployeeProfileFormValues;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  reset?: {
    profile: EmployeeDetailsProfile;
    onRequest: () => void;
  };
  onSubmit: (
    values: EmployeeProfileFormValues,
    editedFields: EmployeeProfileEditedFields,
  ) => void | Promise<void>;
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
  reset,
  onSubmit,
  onCancel,
}: EmployeeProfileFormProps) {
  const id = useId();
  const [values, setValues] = useState(() => ({ ...initialValue }));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const pending = useRef(false);
  const editedFields = useRef(new Set<keyof EmployeeProfileFormValues>());
  const locked = busy || submitting;
  const name = values.name.trim();
  const update = <K extends keyof EmployeeProfileFormValues>(
    key: K,
    value: EmployeeProfileFormValues[K],
  ) => {
    editedFields.current.add(key);
    setSubmitError('');
    setValues((before) => ({ ...before, [key]: value }));
  };
  return (
    <form
      className={`${css.form} ${mode === 'edit' ? css.editForm : `${css.createForm} ${createCss.createForm}`}`}
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
          (mode === 'edit' && !values.workStyle.trim())
        )
          return;
        pending.current = true;
        setSubmitting(true);
        setSubmitError('');
        try {
          await onSubmit(
            {
              ...values,
              name,
              mission: values.mission.trim(),
              workStyle: values.workStyle.trim(),
            },
            new Set(editedFields.current),
          );
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
      <fieldset className={`${css.fields} ${mode === 'create' ? createCss.scroll : ''}`} disabled={locked}>
        {mode === 'create' && (
          <p className={createCss.intro}>
            一个员工由人设、技能、工作场景、插件、记忆五部分组成。现在先定人设，其他四项创建后在“详情”里随时添加。
          </p>
        )}
        <div className={mode === 'create' ? createCss.persona : undefined}>
        {mode === 'create' && (
          <div className={createCss.heading}>
            <span className={createCss.number}>1</span>
            <h3>人设</h3>
            <span className={createCss.caption}>它是谁、怎么干活、怎么说话</span>
          </div>
        )}
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
              <label htmlFor={`${id}-name`}>
                {mode === 'edit' ? '名字' : '员工名字'}
                {mode === 'create' && <span className={createCss.required} aria-hidden="true"> *</span>}
              </label>
              <input
                id={`${id}-name`}
                data-employee-name
                value={values.name}
                maxLength={120}
                required
                autoComplete="off"
                placeholder={
                  mode === 'create'
                    ? '例如： 文案专家、财务专员、商务分析师'
                    : undefined
                }
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
            <label htmlFor={`${id}-mission`}>使命{mode === 'create' && <span className={createCss.required} aria-hidden="true"> *</span>}</label>
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
              required={mode === 'edit'}
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
        </div>
        {mode === 'create' && (
          <>
            <div className={createCss.later}>创建后在“详情”里添加</div>
            <div className={createCss.parts}>
              {creationParts.map(([number, title, description, status]) => (
                <section className={createCss.part} key={number}>
                  <div className={createCss.heading}>
                    <span className={createCss.number}>{number}</span>
                    <h3>{title}</h3>
                  </div>
                  <p>{description}</p>
                  <div className={createCss.status}>{status}</div>
                </section>
              ))}
            </div>
          </>
        )}
      </fieldset>
      {error || submitError ? <p role="alert">{error || submitError}</p> : null}
      <footer className={css.actions}>
        {mode === 'create' && <p className={createCss.help}>名字和使命填好后才能创建</p>}
        {mode === 'edit' && reset && canResetEmployeePersona(reset.profile) && (
          <button
            type="button"
            className={css.reset}
            disabled={locked || disabled}
            onClick={reset.onRequest}
          >
            恢复默认
          </button>
        )}
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
            (mode === 'edit' && !values.workStyle.trim())
          }
        >
          {locked
            ? mode === 'create'
              ? '正在创建…'
              : '正在保存…'
            : mode === 'create'
              ? '确认创建'
              : '保存'}
        </button>
      </footer>
    </form>
  );
}
