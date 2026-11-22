'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmployeePanelDataClient } from '../../lib/chatflow/employee-panel-data';
import { savePanelDownload } from '../../lib/chatflow/employee-panel-data';
import { legacyEmployeePanelDataClient } from '../../lib/chatflow/employee-panel-data-legacy';

/** Absence keeps existing 3.x callers compatible. 4.0's data owner always
 * passes an explicit client, including its rejecting unbound client. */
export function useEmployeePanelData(props: {
  dataClient?: EmployeePanelDataClient;
  headers: Record<string, string>;
  viewerId?: string;
}) {
  const headerKey = JSON.stringify(props.headers);
  return useMemo(
    () =>
      props.dataClient ??
      legacyEmployeePanelDataClient(JSON.parse(headerKey), props.viewerId),
    [props.dataClient, headerKey, props.viewerId],
  );
}

export function useEmployeePanelDownload(
  client: EmployeePanelDataClient,
  scope: string,
  active: boolean,
) {
  const current = useRef({ client, scope, active });
  current.current = { client, scope, active };
  const operation = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    return () => operation.current?.abort();
  }, [client, scope, active]);
  return {
    error,
    async download(
      read: (signal: AbortSignal) => Promise<Blob>,
      fileName: string,
    ) {
      if (!active) return;
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const live = () =>
        !controller.signal.aborted &&
        current.current.active &&
        current.current.client === client &&
        current.current.scope === scope;
      setError('');
      try {
        const bytes = await read(controller.signal);
        if (live()) savePanelDownload(bytes, fileName);
      } catch (cause) {
        if (live())
          setError(
            cause instanceof Error ? cause.message : '文件下载失败，请重试。',
          );
      }
    },
  };
}
