'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EmployeeDetailsSchema,
  EmployeeInstanceSchema,
  OrganizationAiSharedDetailsSchema,
  type EmployeeDetails,
  type EmployeeInstance,
  type ReferenceSelection,
  type ExperienceSummary,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import { EmployeeProfileDetails } from './employee-profile-details';
import {
  EmployeeProfileForm,
  employeeProfileFormFromRaw,
  mergeEmployeeProfileForm,
  type EmployeeProfileFormValues,
} from './employee-profile-form';
import { readJson } from './chatflow-utils';
import formCss from './employee-profile-form.module.css';
import {
  ExperiencePanel,
  ExperienceSummaryCard,
} from '../workspace/experience/experience-panel';
import { NativeDocumentPreview } from './native-document-preview';
import { DocumentToolbar } from './document-reader';
import {
  workbenchJson,
  parseArtifactPreview,
  type ArtifactPreview,
} from '../../lib/chatflow/workbench-model';
import css from './employee-profile-details.module.css';

interface EmployeeDetailsDialogProps {
  open: boolean;
  scopeId: string;
  instanceId?: string;
  employeeId?: string;
  workspaceId: string;
  headers: Record<string, string>;
  onClose: () => void;
  onPrepare?: (text: string, instanceId: string) => void;
  onProfileUpdated?: (instance: EmployeeInstance) => void;
  organizationView?: { organizationId: string; userId: string };
}

export function EmployeeDetailsDialog(props: EmployeeDetailsDialogProps) {
  if (!props.open) return null;
  // A different viewer/workspace/instance must never render the previous read,
  // even for the frame before an effect or an aborted request settles.
  return (
    <EmployeeDetailsReader
      key={`${props.scopeId}/${props.instanceId ?? 'missing'}`}
      {...props}
    />
  );
}

function EmployeeDetailsReader(props: EmployeeDetailsDialogProps) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    attempt: number;
    data?: EmployeeDetails;
    experienceSummary?: ExperienceSummary;
    error?: string;
  }>();
  const [reference, setReference] = useState<ReferenceSelection | null>(null);
  const [editor, setEditor] = useState<{
    instance?: EmployeeInstance;
    loading: boolean;
    error?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [prepareError, setPrepareError] = useState('');
  const editRead = useRef<AbortController | null>(null);
  const editWrite = useRef<AbortController | null>(null);
  const writeRequest = useRef<{ payload: string; id: string } | null>(null);
  const data = result?.attempt === attempt ? result.data : undefined;
  const error = result?.attempt === attempt ? result.error : undefined;
  useEffect(
    () => () => {
      editRead.current?.abort();
      editWrite.current?.abort();
    },
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    if (!props.instanceId) {
      setResult({ attempt, error: '这位 AI 员工暂不可用，请关闭后重新选择。' });
      return () => controller.abort();
    }
    void workbenchJson(
      props.organizationView
        ? `${organizationInstanceBase(props.organizationView, props.instanceId)}/content`
        : `/api/v1/employee-instances/${encodeURIComponent(props.instanceId)}/content?workspaceId=${encodeURIComponent(props.workspaceId)}`,
      props.headers,
      { signal: controller.signal, cache: 'no-store' },
    )
      .then((value) => {
        const shared = props.organizationView
          ? OrganizationAiSharedDetailsSchema.parse(value)
          : undefined;
        if (
          shared &&
          (shared.organizationId !== props.organizationView?.organizationId ||
            shared.userId !== props.organizationView?.userId)
        )
          throw new Error('Organization detail target changed');
        const next = shared?.details ?? EmployeeDetailsSchema.parse(value);
        if (
          next.profile.instanceId !== props.instanceId ||
          next.content.employeeId !== props.employeeId
        )
          throw new Error('Employee detail target changed');
        if (!controller.signal.aborted)
          setResult({
            attempt,
            data: next,
            experienceSummary: shared?.experienceSummary,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({
            attempt,
            error:
              '无法读取这位 AI 员工的当前详情，请重新打开或联系管理员核对配发。',
          });
      });
    return () => controller.abort();
  }, [
    props.instanceId,
    props.employeeId,
    props.workspaceId,
    props.headers,
    props.organizationView,
    attempt,
  ]);
  const refresh = () => {
    editRead.current?.abort();
    setEditor(null);
    setPrepareError('');
    setReference(null);
    setAttempt((value) => value + 1);
  };
  const instanceUrl = props.instanceId
    ? `/api/v1/employee-instances/${encodeURIComponent(props.instanceId)}`
    : null;
  const cancelEdit = () => {
    if (editWrite.current) return;
    editRead.current?.abort();
    setEditor(null);
  };
  async function openEditor() {
    if (
      !instanceUrl ||
      !data ||
      props.organizationView ||
      data.profile.kind !== 'custom' ||
      !data.profile.canMaintainPersonal
    )
      return;
    editRead.current?.abort();
    const controller = new AbortController();
    editRead.current = controller;
    setEditor({ loading: true });
    setPrepareError('');
    let responseStatus = 0;
    try {
      const response = await fetch(
        `${instanceUrl}?workspaceId=${encodeURIComponent(props.workspaceId)}`,
        {
          headers: props.headers,
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      responseStatus = response.status;
      const value = await readJson<{ instance: unknown }>(response);
      const instance = EmployeeInstanceSchema.parse(value.instance);
      if (
        instance.id !== props.instanceId ||
        instance.workspaceId !== props.workspaceId ||
        instance.kind !== 'custom' ||
        instance.archivedAt ||
        instance.revision !== data.profile.revision ||
        JSON.stringify(instance.source) !== JSON.stringify(data.profile.source)
      )
        throw Error('员工设置已变化，请重新读取详情后再编辑。');
      if (!controller.signal.aborted) setEditor({ loading: false, instance });
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message =
          cause instanceof Error ? cause.message : '无法读取员工设置。';
        setEditor({
          loading: false,
          error: message,
        });
        if ([401, 403, 404].includes(responseStatus))
          setResult({ attempt, error: message });
      }
    }
  }
  async function saveProfile(values: EmployeeProfileFormValues) {
    if (!instanceUrl || !editor?.instance || editWrite.current) return;
    const current = editor.instance;
    const body = {
      workspaceId: props.workspaceId,
      expectedRevision: current.revision,
      profile: mergeEmployeeProfileForm(current.profile, values),
    };
    const payload = JSON.stringify(body);
    if (writeRequest.current?.payload !== payload)
      writeRequest.current = { payload, id: crypto.randomUUID() };
    const controller = new AbortController();
    editWrite.current = controller;
    setSaving(true);
    setEditor({ ...editor, error: undefined });
    let responseStatus = 0;
    try {
      const response = await fetch(instanceUrl, {
        method: 'PATCH',
        headers: { ...props.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, requestId: writeRequest.current.id }),
        signal: controller.signal,
      });
      responseStatus = response.status;
      const value = await readJson<{ instance: unknown }>(response);
      const instance = EmployeeInstanceSchema.parse(value.instance);
      if (
        instance.id !== current.id ||
        instance.workspaceId !== current.workspaceId ||
        instance.organizationId !== current.organizationId ||
        instance.ownerId !== current.ownerId ||
        instance.assignmentId !== current.assignmentId ||
        instance.kind !== 'custom' ||
        instance.archivedAt ||
        instance.revision !== current.revision + 1
      )
        throw Error('员工设置回执不匹配，请重新读取详情。');
      if (!controller.signal.aborted) {
        props.onProfileUpdated?.(instance);
        refresh();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message =
          cause instanceof Error ? cause.message : '保存未完成，请重试。';
        if ([401, 403, 404].includes(responseStatus)) {
          // A denied/revoked read must not keep the old private profile on screen.
          setEditor({ loading: false, error: message });
          setResult({ attempt, error: message });
        } else setEditor({ loading: false, instance: current, error: message });
      }
    } finally {
      if (!controller.signal.aborted) {
        editWrite.current = null;
        setSaving(false);
      }
    }
  }
  function prepare(text: string) {
    if (!data || !props.onPrepare) return;
    try {
      props.onPrepare(text, data.profile.instanceId);
      props.onClose();
    } catch (cause) {
      setPrepareError(
        cause instanceof Error ? cause.message : '未能带入聊天，请重试。',
      );
    }
  }
  return (
    <DshDialog
      ariaLabel={
        editor
          ? '编辑员工'
          : data
            ? `${data.profile.name}员工详情`
            : 'AI 员工详情'
      }
      bodyClassName={editor ? formCss.body : css.body}
      className={
        editor
          ? formCss.dialog
          : `${css.dialog} ${data && !reference ? css.profileDialog : ''}`
      }
      onClose={editor ? cancelEdit : props.onClose}
      title={editor ? '编辑员工' : (data?.profile.name ?? 'AI 员工详情')}
      initialFocusSelector={editor?.instance ? 'input' : undefined}
    >
      {editor ? (
        editor.loading ? (
          <p role="status">正在读取员工设置…</p>
        ) : editor.instance && data ? (
          <>
            <EmployeeProfileForm
              key={`${editor.instance.id}/${editor.instance.revision}`}
              mode="edit"
              initialValue={employeeProfileFormFromRaw(
                editor.instance.profile,
                data.profile,
              )}
              busy={saving}
              error={editor.error}
              onSubmit={saveProfile}
              onCancel={cancelEdit}
            />
            {editor.error && (
              <button type="button" className={css.retry} onClick={refresh}>
                重新读取详情
              </button>
            )}
          </>
        ) : (
          <>
            <p role="alert">{editor.error ?? '无法读取员工设置。'}</p>
            <button type="button" className={css.retry} onClick={refresh}>
              重新读取详情
            </button>
          </>
        )
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          <button type="button" className={css.retry} onClick={refresh}>
            重新读取
          </button>
        </>
      ) : !data ? (
        <p role="status">正在读取当前内容…</p>
      ) : reference ? (
        <EmployeeReferencePreview
          key={reference.revisionId}
          reference={reference}
          workspaceId={props.workspaceId}
          headers={props.headers}
          onBack={refresh}
          endpointBase={
            props.organizationView && props.instanceId
              ? `${organizationInstanceBase(props.organizationView, props.instanceId)}/references`
              : undefined
          }
        />
      ) : (
        <>
          {prepareError && <p role="alert">{prepareError}</p>}
          <EmployeeProfileDetails
            key={attempt}
            details={data}
            onPreview={setReference}
            onEdit={
              props.organizationView ? undefined : () => void openEditor()
            }
            onPrepare={
              props.organizationView || !props.onPrepare ? undefined : prepare
            }
            onClose={props.onClose}
            view={props.organizationView ? 'shared' : 'personal'}
            experienceContent={
              props.organizationView
                ? result?.experienceSummary && (
                    <ExperienceSummaryCard
                      summary={result.experienceSummary}
                      shared
                    />
                  )
                : props.instanceId && (
                    <ExperiencePanel
                      workspaceId={props.workspaceId}
                      instanceId={props.instanceId}
                      scopeId={props.scopeId}
                      headers={props.headers}
                      embedded
                      readOnly
                    />
                  )
            }
          />
        </>
      )}
    </DshDialog>
  );
}

function organizationInstanceBase(
  view: { organizationId: string; userId: string },
  instanceId: string,
) {
  return `/api/v1/admin/organizations/${encodeURIComponent(view.organizationId)}/people/${encodeURIComponent(view.userId)}/ai-instances/${encodeURIComponent(instanceId)}`;
}

/** Preview the pinned revision through the existing ACL-aware file endpoints.
 * This deliberately reuses the document renderer, not the editable library. */
export function EmployeeReferencePreview({
  reference,
  workspaceId,
  headers,
  onBack,
  endpointBase,
}: {
  reference: ReferenceSelection;
  workspaceId: string;
  headers: Record<string, string>;
  onBack: () => void;
  endpointBase?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    preview?: ArtifactPreview;
    failed?: boolean;
  }>();
  const base = `${endpointBase ?? '/api/v1/references/revisions'}/${encodeURIComponent(reference.revisionId)}`;
  const query = `?workspaceId=${encodeURIComponent(workspaceId)}`;
  const key = `${workspaceId}/${reference.revisionId}/${attempt}`;
  const current = result?.key === key ? result : undefined;
  const readFailed = useCallback(() => setResult({ key, failed: true }), [key]);
  useEffect(() => {
    const controller = new AbortController();
    void workbenchJson(base + '/preview' + query, headers, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(parseArtifactPreview)
      .then((preview) => {
        if (!controller.signal.aborted) setResult({ key, preview });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, failed: true });
      });
    return () => controller.abort();
  }, [base, query, headers, key]);
  return (
    <section className={css.preview} aria-label="参考资料预览">
      <button type="button" className={css.back} onClick={onBack}>
        ← 返回员工详情
      </button>
      {current?.failed ? (
        <>
          <p role="alert">
            无法读取该版本的参考资料。资料可能已停用或当前无权访问。
          </p>
          <button
            type="button"
            className={css.retry}
            onClick={() => setAttempt((value) => value + 1)}
          >
            重新读取
          </button>
        </>
      ) : !current?.preview ? (
        <p role="status">正在读取参考资料…</p>
      ) : (
        <>
          <DocumentToolbar
            title={reference.fileName}
            downloadUrl={base + '/download' + query}
            actions={[{ id: 'refresh', label: '刷新预览' }]}
            onAction={() => setAttempt((value) => value + 1)}
          >
            <span>v{reference.revision}</span>
          </DocumentToolbar>
          <div className={css.previewContent}>
            <NativeDocumentPreview
              preview={current.preview}
              fileName={reference.fileName}
              pageUrl={base + '/preview' + query}
              headers={headers}
              onReadFailure={readFailed}
            />
          </div>
          <p className={css.hint}>
            查看此员工引用的固定版本 v{reference.revision}。
          </p>
        </>
      )}
    </section>
  );
}
