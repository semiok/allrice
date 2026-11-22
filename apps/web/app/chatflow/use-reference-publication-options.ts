'use client';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import type { ReferenceLibraryOptionsSchema } from '@allrice/contracts';
import type { EmployeePanelDataClient } from '../../lib/chatflow/employee-panel-data';
import { useEmployeePanelData } from './use-employee-panel-data';

export type ReferencePublicationOptions = z.infer<
  typeof ReferenceLibraryOptionsSchema
>;
type ReferencePublicationOptionsResult = {
  options?: ReferencePublicationOptions;
  error?: string;
};

/** Only the existing publication options are needed by a deliverable form.
 * The current viewer is a response identity check, never write ownership. */
export function useReferencePublicationOptions(props: {
  workspaceId: string;
  viewerId?: string;
  headers: Record<string, string>;
  active: boolean;
  dataClient?: EmployeePanelDataClient;
  supplied?: ReferencePublicationOptions;
}): ReferencePublicationOptionsResult {
  const data = useEmployeePanelData(props);
  const headerKey = JSON.stringify(props.headers);
  const key = `${props.workspaceId}/${props.viewerId}/${headerKey}`;
  const [result, setResult] = useState<
    | (ReferencePublicationOptionsResult & {
        key: string;
        client: EmployeePanelDataClient;
      })
    | null
  >(null);
  useEffect(() => {
    if (!props.active || !props.viewerId || props.supplied) return;
    const controller = new AbortController();
    void data
      .publicationOptions({ workspaceId: props.workspaceId }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.viewerId !== props.viewerId ||
          value.options.workspaceId !== props.workspaceId
        )
          throw Error('Publication viewer changed');
        setResult({ key, client: data, options: value.options });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ key, client: data, error: '发布未完成，请重试。' });
      });
    return () => controller.abort();
  }, [
    key,
    props.active,
    props.supplied,
    props.workspaceId,
    props.viewerId,
    headerKey,
    data,
  ]);
  return props.supplied?.workspaceId === props.workspaceId
    ? { options: props.supplied }
    : result?.key === key && result.client === data
      ? result
      : {};
}
