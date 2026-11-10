'use client';

import { useId } from 'react';
import type { EmployeeSkillCatalog } from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  EmployeeCapabilityDanger,
  EmployeeCapabilityDetailsHeader,
  EmployeeCapabilityHeading,
  EmployeeCapabilityRow,
} from './employee-capability-presentation';
import capabilityCss from './employee-capability-presentation.module.css';
import css from './employee-skills-section.module.css';

export type EmployeeBaseSkill = EmployeeSkillCatalog['platformSkills'][number];
export type EmployeePersonalSkill =
  EmployeeSkillCatalog['personalSkills'][number];
export type EmployeeSkill = EmployeeBaseSkill | EmployeePersonalSkill;

/** The host owns reads and their scope. Missing data is never an empty catalog. */
export type EmployeeSkillsView =
  | { status: 'loading'; label: string }
  | { status: 'error'; message: string; onRetry?: () => void }
  | { status: 'ready'; catalog: EmployeeSkillCatalog };

export function employeeSkillVersion(version: string | null) {
  if (!version) return '未提供';
  // The approved numeric examples use a decorative v. Other author strings
  // remain exact; this formatting neither validates nor orders versions.
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? `v${version}` : version;
}

export function employeeSkillSource(skill: EmployeeSkill) {
  if (skill.kind === 'platform') return '基础技能';
  return skill.source.kind === 'github'
    ? skill.source.requestedUrl
    : skill.source.fileName;
}

/** Display-only candidate. The host supplies every action; this module neither
 * fetches nor writes, and its display flags never grant server authority. */
export function EmployeeSkillsSection({
  view,
  onOpen,
  onAdd,
  disabled = false,
}: {
  view: EmployeeSkillsView;
  onOpen: (skill: EmployeeSkill) => void;
  onAdd?: () => void;
  disabled?: boolean;
}) {
  const headingId = useId();
  const catalog = view.status === 'ready' ? view.catalog : null;
  return (
    <section className={css.section} aria-labelledby={headingId}>
      <EmployeeCapabilityHeading
        id={headingId}
        title="技能"
        kind="Skills"
        description="它会的本事，干活时自己判断要不要用。"
        action={
          catalog?.canInstall &&
          onAdd && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={css.add}
              disabled={disabled}
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              }
              onClick={onAdd}
            >
              添加技能
            </Button>
          )
        }
      />
      {view.status === 'loading' && (
        <p className={css.feedback} role="status" aria-busy="true">
          {view.label}
        </p>
      )}
      {view.status === 'error' && (
        <div className={css.feedback}>
          <p role="alert">{view.message}</p>
          {view.onRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={view.onRetry}
            >
              重试
            </Button>
          )}
        </div>
      )}
      {catalog && (
        <>
          <div
            className={
              catalog.personalSkills.length ? css.subheading : css.empty
            }
          >
            我添加的 · {catalog.personalSkills.length}
          </div>
          {catalog.personalSkills.length > 0 && (
            <div className={capabilityCss.list}>
              {catalog.personalSkills.map((skill) => (
                <EmployeeCapabilityRow
                  key={skill.installationId}
                  name={skill.displayName}
                  description={skill.description}
                  version={employeeSkillVersion(skill.version)}
                  disabled={disabled}
                  onOpen={() => onOpen(skill)}
                />
              ))}
            </div>
          )}
          <div className={css.subheading}>
            基础技能 · {catalog.platformSkills.length}
          </div>
          <div className={css.baseSkills}>
            {catalog.platformSkills.map((skill) => (
              <Button
                type="button"
                key={skill.id}
                variant="outline"
                size="sm"
                className={css.chip}
                disabled={disabled}
                onClick={() => onOpen(skill)}
              >
                {skill.displayName}
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** A detail page for an existing host layer. The host owns Escape/mask/focus
 * and supplies the same parent-return action as this page's back button. */
export function EmployeeSkillDetails({
  skill,
  canInstall,
  onBack,
  onUpdate,
  onUninstall,
  onStart,
  starting,
  error,
  disabled,
  backLabel = '返回员工详情',
}: {
  skill: EmployeeSkill;
  canInstall: EmployeeSkillCatalog['canInstall'];
  onBack: () => void;
  onUpdate?: (skill: EmployeePersonalSkill) => void;
  onUninstall?: (skill: EmployeePersonalSkill) => void;
  onStart?: () => void;
  starting?: boolean;
  error?: string;
  disabled?: boolean;
  backLabel?: string;
}) {
  const personal = skill.kind === 'personal';
  const update =
    skill.kind === 'personal' && canInstall && onUpdate
      ? () => onUpdate(skill)
      : undefined;
  const uninstall =
    skill.kind === 'personal' && skill.canUninstall && onUninstall
      ? () => onUninstall(skill)
      : undefined;
  return (
    <div className={css.detail}>
      <EmployeeCapabilityDetailsHeader
        title={skill.displayName}
        version={employeeSkillVersion(skill.version)}
        backLabel={backLabel}
        onBack={onBack}
        onUpdate={update}
        onStart={onStart}
        starting={starting}
        disabled={disabled || starting}
      />
      <div className={css.detailBody}>
        <div className={css.detailLabel}>
          <span className={css.pill}>{personal ? '我添加的' : '基础技能'}</span>
        </div>
        <p className={css.detailDescription}>{skill.description}</p>
        <dl className={css.metadata}>
          <div>
            <dt>来源</dt>
            <dd>{employeeSkillSource(skill)}</dd>
          </div>
        </dl>
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
        {uninstall && (
          <EmployeeCapabilityDanger
            disabled={disabled || starting}
            onRemove={uninstall}
          >
            卸载这个技能
          </EmployeeCapabilityDanger>
        )}
      </div>
    </div>
  );
}
