'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ReferenceRevisionSchema,
  type ReferenceRevision,
  type WorkbenchFile,
} from '@allrice/contracts';
import { workbenchJson } from '../../lib/chatflow/workbench-model';

export type WorkbenchFileReferenceProps = {
  workspaceId: string;
  sessionId: string | null;
  headers: Record<string, string>;
  active: boolean;
  readOnly?: boolean;
  onUse: (reference: ReferenceRevision) => void;
  onTemplate?: (reference: ReferenceRevision) => void;
};

/** The existing fixed-snapshot preparation, shared by the list and preview. */
export function useWorkbenchFileReference(props: WorkbenchFileReferenceProps) {
  const [using, setUsing] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    fileId: string;
    reference: ReferenceRevision;
  } | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, string>()),
    lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    setUsing(null);
    setPending(null);
    return () => {
      lifetime.current++;
    };
  }, [props.workspaceId, props.sessionId, props.active, props.readOnly]);
  useEffect(() => {
    if (!props.active || !pending) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void workbenchJson(
        '/api/v1/references?' +
          new URLSearchParams({
            workspaceId: props.workspaceId,
            sourceId: pending.reference.sourceId,
          }),
        props.headers,
        { signal: controller.signal },
      )
        .then((raw) => {
          const references = (raw as { references: unknown[] }).references.map(
            (value) => ReferenceRevisionSchema.parse(value),
          );
          const current = references.find(
            (value) => value.revisionId === pending.reference.revisionId,
          );
          if (controller.signal.aborted) return;
          if (!current || current.status !== 'active')
            throw Error('所选文件的访问权限已变化，请重新选择。');
          if (current.processing === 'ready') {
            if (!props.readOnly) props.onUse(current);
            setPending(null);
            setUsing(null);
            setNotice(props.readOnly ? '当前会话已归档。' : '已引用文件。');
          } else if (
            ['failed', 'unsupported', 'uploading'].includes(current.processing)
          ) {
            setPending(null);
            setUsing(null);
            setError(
              current.processing === 'unsupported'
                ? '这个文件暂不支持引用，请下载查看。'
                : '资料处理尚未完成，请稍后重试。',
            );
          } else setPending({ ...pending, reference: current });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setPending(null);
            setUsing(null);
            setError(
              error instanceof Error ? error.message : '操作未完成，请重试。',
            );
          }
        });
    }, 1500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    pending,
    props.active,
    props.workspaceId,
    props.headers,
    props.readOnly,
    props.onUse,
  ]);
  async function useFile(file: WorkbenchFile) {
    if (using || props.readOnly || !props.active) return;
    if (file.reference?.companyTemplate) {
      props.onTemplate?.(file.reference);
      return;
    }
    setUsing(file.objectId);
    setError('');
    setNotice('');
    const generation = lifetime.current;
    try {
      const requestId =
        requests.current.get(file.objectId) ?? crypto.randomUUID();
      requests.current.set(file.objectId, requestId);
      const raw = await workbenchJson(
        `/api/v1/workbench/files/${file.objectId}/reference?workspaceId=${props.workspaceId}`,
        props.headers,
        { method: 'POST', body: JSON.stringify({ requestId }) },
      );
      if (generation !== lifetime.current) return;
      const reference = ReferenceRevisionSchema.parse(
        (raw as { reference: unknown }).reference,
      );
      if (reference.processing === 'ready') {
        props.onUse(reference);
        setNotice('已引用文件。');
        setUsing(null);
      } else if (['saved', 'processing'].includes(reference.processing))
        setPending({ fileId: file.objectId, reference });
      else {
        setUsing(null);
        setError('这个文件暂不支持引用，请下载查看。');
      }
    } catch (error) {
      if (generation === lifetime.current) {
        setUsing(null);
        setError(
          error instanceof Error ? error.message : '操作未完成，请重试。',
        );
      }
    }
  }
  return {
    using,
    pending,
    error,
    notice,
    useFile,
    cancel: () => {
      setPending(null);
      setUsing(null);
    },
  };
}
