'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ReferenceRevisionSchema,
  type ReferenceRevision,
  type WorkbenchFile,
} from '@allrice/contracts';
import type { EmployeePanelDataClient } from '../../lib/chatflow/employee-panel-data';
import { useEmployeePanelData } from './use-employee-panel-data';

export type WorkbenchFileReferenceProps = {
  workspaceId: string;
  sessionId: string | null;
  headers: Record<string, string>;
  active: boolean;
  dataClient?: EmployeePanelDataClient;
  readOnly?: boolean;
  onUse: (reference: ReferenceRevision) => void;
  onTemplate?: (reference: ReferenceRevision) => void;
};

/** The existing fixed-snapshot preparation, shared by the list and preview. */
export function useWorkbenchFileReference(props: WorkbenchFileReferenceProps) {
  const data = useEmployeePanelData(props);
  const [using, setUsing] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    fileId: string;
    reference: ReferenceRevision;
  } | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, string>()),
    lifetime = useRef(0);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    lifetime.current++;
    setUsing(null);
    setPending(null);
    return () => {
      lifetime.current++;
      operation.current?.abort();
    };
  }, [props.workspaceId, props.sessionId, props.active, props.readOnly, data]);
  useEffect(() => {
    if (!props.active || !pending) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void data
        .readPreparedReference(
          {
            workspaceId: props.workspaceId,
            sourceId: pending.reference.sourceId,
            revisionId: pending.reference.revisionId,
          },
          controller.signal,
        )
        .then((current) => {
          if (controller.signal.aborted) return;
          if (
            current.sourceId !== pending.reference.sourceId ||
            current.revisionId !== pending.reference.revisionId ||
            current.status !== 'active'
          )
            throw Error('所选文件的访问权限已变化，请重新选择。');
          if (current.processing === 'ready') {
            if (!props.readOnly) props.onUse(current);
            setPending(null);
            setUsing(null);
            setNotice(props.readOnly ? '当前会话已归档。' : '');
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
    data,
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
    const controller = new AbortController();
    operation.current = controller;
    try {
      const requestId =
        requests.current.get(file.objectId) ?? crypto.randomUUID();
      requests.current.set(file.objectId, requestId);
      const raw = await data.captureReference(
        {
          workspaceId: props.workspaceId,
          objectId: file.objectId,
          requestId,
        },
        controller.signal,
      );
      if (controller.signal.aborted || generation !== lifetime.current) return;
      const reference = ReferenceRevisionSchema.parse(
        (raw as { reference: unknown }).reference,
      );
      if (reference.processing === 'ready') {
        props.onUse(reference);
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
      lifetime.current++;
      operation.current?.abort();
      setPending(null);
      setUsing(null);
    },
  };
}
