'use client';

import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  CompanyTemplateSelectionSchema,
  type CompanyAsset,
  type CompanyAssetRevision,
  type CompanyTemplateSelection,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './company-template-browser.module.css';

export type CompanyDraftReference = {
  selection: CompanyTemplateSelection;
  title: string;
  number: number;
};

/** Shared by the company directory and recommended task entry. Preparing a
 * reference never reads private author files or submits a model task. */
export function CompanyTemplateUseForm({
  asset,
  revision,
  onClose,
  onPrepare,
  inline = false,
}: {
  asset: CompanyAsset;
  revision: CompanyAssetRevision;
  onClose: () => void;
  onPrepare: (reference: CompanyDraftReference) => Promise<void>;
  inline?: boolean;
}) {
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const form = (
    <form
      className={styles.editor}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (
          revision.content.slots.some(
            (slot) => slot.required && !parameters[slot.key]?.trim(),
          )
        ) {
          setError('请补齐必填内容。');
          return;
        }
        const parsed = CompanyTemplateSelectionSchema.safeParse({
          assetId: asset.id,
          revisionId: revision.id,
          digest: revision.digest,
          parameters,
        });
        if (!parsed.success) {
          setError('填写内容过长，请缩短后重试。');
          return;
        }
        setBusy(true);
        setError('');
        void onPrepare({
          selection: parsed.data,
          title: revision.content.title,
          number: revision.number,
        })
          .then(onClose)
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : '范本选用失败'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <strong>
        {revision.content.title} · v{revision.number}
      </strong>
      <p className={styles.text}>{revision.content.body}</p>
      <p>填写本次数据并加入草稿，确认后发送。AI 会参考此修订制作新的成果。</p>
      {revision.content.slots.map((slot) => (
        <label key={slot.key}>
          {slot.label}
          {slot.required ? '（必填）' : '（可选）'}
          {slot.multiline ? (
            <textarea
              aria-label={slot.label}
              required={slot.required}
              maxLength={4000}
              rows={4}
              disabled={busy}
              value={parameters[slot.key] ?? ''}
              onChange={(e) =>
                setParameters((p) => ({ ...p, [slot.key]: e.target.value }))
              }
            />
          ) : (
            <input
              aria-label={slot.label}
              required={slot.required}
              maxLength={4000}
              disabled={busy}
              value={parameters[slot.key] ?? ''}
              onChange={(e) =>
                setParameters((p) => ({ ...p, [slot.key]: e.target.value }))
              }
            />
          )}
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? '正在核对范本…' : '加入消息草稿'}
        </Button>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
      </div>
    </form>
  );
  return inline ? (
    <section aria-label="选用公司范本">{form}</section>
  ) : (
    <DshDialog
      ariaLabel="选用公司范本"
      title="选用公司范本"
      onClose={busy ? () => {} : onClose}
      className={styles.dialog}
      bodyClassName={styles.body}
    >
      {form}
    </DshDialog>
  );
}

export function CompanyTemplateDraftChips({
  references,
  disabled,
  onRemove,
}: {
  references: CompanyDraftReference[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  if (!references.length) return null;
  return (
    <div className={styles.actions} aria-label="已选公司范本">
      {references.map((ref) => (
        <span key={ref.selection.assetId}>
          范本：{ref.title} · v{ref.number}{' '}
          <Button
            aria-label={`移除范本 ${ref.title}`}
            disabled={disabled}
            onClick={() => onRemove(ref.selection.assetId)}
          >
            ×
          </Button>
        </span>
      ))}
    </div>
  );
}
