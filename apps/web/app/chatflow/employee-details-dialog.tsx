'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  EmployeeDetailsSchema,
  OrganizationAiSharedDetailsSchema,
  type EmployeeDetails,
  type ReferenceSelection,
} from '@allrice/contracts';
import { DshDialog } from './dsh-upstream/Dialog';
import { EmployeeProfileDetails } from './employee-profile-details';
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
    error?: string;
  }>();
  const [reference, setReference] = useState<ReferenceSelection | null>(null);
  const data = result?.attempt === attempt ? result.data : undefined;
  const error = result?.attempt === attempt ? result.error : undefined;
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
        if (!controller.signal.aborted) setResult({ attempt, data: next });
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
    setReference(null);
    setAttempt((value) => value + 1);
  };
  return (
    <DshDialog
      ariaLabel={data ? `${data.profile.name}员工详情` : 'AI 员工详情'}
      bodyClassName={css.body}
      className={css.dialog}
      eyebrow="AI 员工 · 只读详情"
      onClose={props.onClose}
      title={data?.profile.name ?? 'AI 员工详情'}
    >
      {error ? (
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
        <EmployeeProfileDetails
          key={attempt}
          details={data}
          onPreview={setReference}
          view={props.organizationView ? 'shared' : 'personal'}
        />
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
