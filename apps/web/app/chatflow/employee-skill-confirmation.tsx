'use client';

import type {
  PersonalSkillConfirmResponse,
  PersonalSkillPreviewResponse,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  employeeSkillVersion,
  type EmployeePersonalSkill,
} from './employee-skills-section';
import {
  EmployeeSkillFeedback,
  EmployeeSkillPage,
  focusEmployeeSkillDialog,
} from './employee-skill-source-form';
import css from './employee-skills-host.module.css';

export function employeeSkillPreviewName(
  preview: PersonalSkillPreviewResponse,
) {
  return preview.item.displayName?.trim()
    ? preview.item.displayName
    : preview.item.name;
}

export function employeeSkillPreviewVersion(
  preview: PersonalSkillPreviewResponse,
) {
  const version = preview.item.version;
  return employeeSkillVersion(version?.trim() ? version : null);
}

export function EmployeeSkillConfirmation({
  preview,
  current,
  pending,
  error,
  reread,
  disabledBindingLabel,
  onBack,
  onConfirm,
}: {
  preview: PersonalSkillPreviewResponse;
  current?: EmployeePersonalSkill;
  pending: boolean;
  error?: string;
  reread: boolean;
  disabledBindingLabel?: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const update = preview.operation === 'update';
  const title = update ? '确认更新' : '确认添加';
  return (
    <EmployeeSkillPage
      title={title}
      backLabel="返回来源填写"
      blocked={pending}
      onBack={onBack}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onBack}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            aria-busy={pending}
            onClick={(event) => {
              focusEmployeeSkillDialog(event.currentTarget);
              onConfirm();
            }}
          >
            {pending && <span className={css.spinner} aria-hidden="true" />}
            {pending && update
              ? '更新中'
              : reread
                ? '重新读取'
                : error
                  ? '重试'
                  : title}
          </Button>
        </>
      }
    >
      <dl className={css.metadata}>
        <div className={css.nameRow}>
          <dt>名称</dt>
          <dd>{employeeSkillPreviewName(preview)}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>
            {update ? (
              <span className={css.versions}>
                <span>{employeeSkillVersion(current?.version ?? null)}</span>
                <span aria-hidden="true">→</span>
                <span>{employeeSkillPreviewVersion(preview)}</span>
              </span>
            ) : (
              employeeSkillPreviewVersion(preview)
            )}
          </dd>
        </div>
        {!update && (
          <div>
            <dt>说明</dt>
            <dd>{preview.item.description}</dd>
          </div>
        )}
        <div>
          <dt>来源</dt>
          <dd>
            {preview.source.kind === 'github'
              ? preview.source.requestedUrl
              : preview.source.fileName}
          </dd>
        </div>
        {!update && (
          <div>
            <dt>文件</dt>
            <dd>{preview.files.length} 个</dd>
          </div>
        )}
      </dl>
      {update && preview.affectedBindings && (
        <section className={css.affected} aria-label="将影响的员工">
          <h3>将影响的员工 · {preview.affectedBindings.length}</h3>
          <p className={css.caption}>
            以下员工使用同一个技能，确认后将一起更新。
          </p>
          <div className={css.affectedList}>
            {preview.affectedBindings.map((binding) => (
              <div className={css.affectedRow} key={binding.id}>
                <span>{binding.label}</span>
                <span className={css.caption}>{binding.workspaceLabel}</span>
                {!binding.enabled && disabledBindingLabel && (
                  <span className={css.caption}>{disabledBindingLabel}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {update && pending && (
        <EmployeeSkillFeedback busy>正在更新…</EmployeeSkillFeedback>
      )}
      {error && <EmployeeSkillFeedback>{error}</EmployeeSkillFeedback>}
    </EmployeeSkillPage>
  );
}

/** Called only after a matching typed receipt; never a local optimistic write. */
export function EmployeeSkillSuccess({
  preview,
  result,
  unchanged,
  onDone,
  parentBackLabel = '返回员工详情',
}: {
  preview: PersonalSkillPreviewResponse;
  result: PersonalSkillConfirmResponse;
  unchanged: { title: string; message: string };
  onDone: () => void;
  parentBackLabel?: string;
}) {
  const update = result.receipt.operation === 'update';
  return (
    <EmployeeSkillPage
      title={
        result.receipt.unchanged
          ? unchanged.title
          : update
            ? '更新完成'
            : '添加完成'
      }
      backLabel={update ? '返回技能详情' : parentBackLabel}
      onBack={onDone}
      footer={
        <Button type="button" variant="primary" onClick={onDone}>
          {update ? '返回技能详情' : '完成'}
        </Button>
      }
    >
      <div className={css.success}>
        {!result.receipt.unchanged && (
          <span className={css.successMark} aria-hidden="true">
            ✓
          </span>
        )}
        <h3>
          {result.receipt.unchanged
            ? unchanged.message
            : `${update ? '已更新' : '已添加'}“${employeeSkillPreviewName(preview)}”`}
        </h3>
        {update && !result.receipt.unchanged && result.affectedBindings && (
          <p className={css.caption}>
            本次更新涉及 {result.affectedBindings.length} 位员工。
          </p>
        )}
      </div>
    </EmployeeSkillPage>
  );
}

export function EmployeeSkillRemoval({
  employeeName,
  skill,
  pending,
  error,
  onBack,
  onConfirm,
}: {
  employeeName: string;
  skill: EmployeePersonalSkill;
  pending: boolean;
  error?: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <EmployeeSkillPage
      title={`卸载“${skill.displayName}”？`}
      blocked={pending}
      onBack={onBack}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onBack}
            data-modal-autofocus
          >
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            className={css.dangerButton}
            disabled={pending}
            aria-busy={pending}
            onClick={(event) => {
              focusEmployeeSkillDialog(event.currentTarget);
              onConfirm();
            }}
          >
            {pending && <span className={css.spinner} aria-hidden="true" />}
            {error ? '重试' : '卸载'}
          </Button>
        </>
      }
    >
      <p className={css.removeDescription}>
        卸载后，{employeeName}将不再使用这个技能。
      </p>
      {error && <EmployeeSkillFeedback>{error}</EmployeeSkillFeedback>}
    </EmployeeSkillPage>
  );
}
