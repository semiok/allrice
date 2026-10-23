'use client';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  ReferenceArtifactSaveInputSchema,
  ReferenceLibraryOptionsSchema,
  ReferenceSaveResultSchema,
  type ReferenceArtifactSaveInput,
} from '@allrice/contracts';
import {
  Button,
  FileTypeIcon,
  classifyFileType,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { WorkbenchFileIcon } from './workbench-file-icon';
import reader from './document-reader.module.css';
import { DshDialog } from './dsh-upstream/Dialog';
import { workbenchJson } from '../../lib/chatflow/workbench-model';
import css from './save-artifact-reference.module.css';

type Props = {
  workspaceId: string;
  headers: Record<string, string>;
  versionId: string;
  fileName: string;
  version: number;
  icon?: boolean;
};
export function SaveArtifactReference(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {props.icon ? (
        <Tooltip label="设为参考资料" side="bottom" portal>
          <button
            type="button"
            className={reader.iconButton}
            aria-label="设为参考资料"
            onClick={() => setOpen(true)}
          >
            <WorkbenchFileIcon kind="reference" />
          </button>
        </Tooltip>
      ) : (
        <Button onClick={() => setOpen(true)}>保存为参考资料</Button>
      )}
      {open && <SaveDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
function SaveDialog({
  workspaceId,
  headers,
  versionId,
  fileName,
  version,
  onClose,
}: Props & { onClose: () => void }) {
  const [options, setOptions] = useState<z.infer<
    typeof ReferenceLibraryOptionsSchema
  > | null>(null);
  const [scope, setScope] =
    useState<ReferenceArtifactSaveInput['scope']>('personal');
  const [departmentId, setDepartmentId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const requests = useRef(new Map<string, ReferenceArtifactSaveInput>());
  const headerKey = JSON.stringify(headers);
  useEffect(() => {
    const controller = new AbortController();
    void workbenchJson(
      '/api/v1/references/artifacts?workspaceId=' + workspaceId,
      JSON.parse(headerKey),
      { signal: controller.signal },
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        const next = ReferenceLibraryOptionsSchema.parse(data);
        setOptions(next);
        setDepartmentId(next.departmentId ?? next.departments[0]?.id ?? '');
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '无法读取保存范围');
      });
    return () => controller.abort();
  }, [workspaceId, headerKey]);
  async function save() {
    const value = {
      workspaceId,
      artifactVersionId: versionId,
      scope,
      ...(scope === 'department' ? { departmentId } : {}),
      purpose,
    };
    const key = JSON.stringify(value);
    const input =
      requests.current.get(key) ??
      ReferenceArtifactSaveInputSchema.parse({
        ...value,
        requestId: crypto.randomUUID(),
      });
    requests.current.set(key, input);
    setBusy(true);
    setError('');
    try {
      ReferenceSaveResultSchema.parse(
        await workbenchJson('/api/v1/references/artifacts', headers, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      );
      setSaved(true);
      window.dispatchEvent(new Event('allrice:workbench-files-changed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <DshDialog
      title="保存为参考资料"
      ariaLabel="保存为参考资料"
      onClose={() => {
        if (!busy) onClose();
      }}
      className={css.dialog}
      bodyClassName={css.body}
    >
      <div className={css.file}>
        <FileTypeIcon kind={classifyFileType(fileName)} size={32} />
        <p className={css.fileTitle}>
          {fileName} · v{version}
        </p>
      </div>
      {saved ? (
        <>
          <p role="status">
            已保存到
            {scope === 'personal'
              ? '个人'
              : scope === 'company'
                ? '公司'
                : (options?.departments.find((d) => d.id === departmentId)
                    ?.name ?? '部门')}
            参考资料，可从输入框附件菜单的“参考资料”查看。
          </p>
          <p className={css.hint}>保留所选成果版本；重复保存会返回已有资料。</p>
          <Button onClick={onClose}>完成</Button>
        </>
      ) : (
        <>
          <p className={css.hint}>
            保存当前版本，后续成果修改不会自动覆盖这份资料。
          </p>
          <div className={css.upload}>
            <label>
              保存范围
              <select
                aria-label="保存范围"
                disabled={busy || !options?.writable}
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="personal">仅自己</option>
                {options?.maintenanceLevel !== 'personal' &&
                  !!options?.departments.length && (
                    <option value="department">指定部门</option>
                  )}
                {options?.maintenanceLevel === 'company' && (
                  <option value="company">全公司</option>
                )}
              </select>
            </label>
            {scope === 'department' && (
              <label>
                部门
                <select
                  aria-label="部门"
                  disabled={busy}
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                >
                  {options?.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              用途（可选）
              <input
                aria-label="参考资料用途"
                value={purpose}
                maxLength={1000}
                disabled={busy}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="例如：每月经营报告的格式参考"
              />
            </label>
          </div>
          <p className={css.hint}>
            {scope === 'personal'
              ? '仅自己可以查看。'
              : scope === 'company'
                ? '公司同事可以查看和下载所选文件。'
                : '所选部门的同事可以查看和下载所选文件。'}
            原聊天和其他成果保持原有访问范围。
          </p>
          {options && !options.writable && <p>当前账号没有维护权限。</p>}
          {error && (
            <p className={css.error} role="alert">
              {error}
            </p>
          )}
          <div className={css.actions}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                !options?.writable ||
                (scope === 'department' && !departmentId)
              }
              onClick={() => void save()}
            >
              {busy ? '正在保存…' : '保存'}
            </Button>
          </div>
        </>
      )}
    </DshDialog>
  );
}
