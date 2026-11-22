'use client';

import { useEffect, useRef, useState } from 'react';
import type { EmployeePanelDataClient } from '../../lib/chatflow/employee-panel-data';
import { useEmployeePanelData } from './use-employee-panel-data';

/** A personal preference; the server independently checks the current actor and file. */
export function useWorkbenchFileFavorite(props: {
  ownerKey: string;
  viewerId?: string;
  workspaceId: string;
  headers: Record<string, string>;
  active: boolean;
  dataClient?: EmployeePanelDataClient;
}) {
  const data = useEmployeePanelData(props);
  const key = `${props.ownerKey}/${props.workspaceId}/${props.viewerId ?? ''}`;
  const current = useRef(key);
  current.current = key;
  const request = useRef<{
    key: string;
    controller: AbortController;
  } | null>(null);
  const epoch = useRef(0);
  const [state, setState] = useState({ key, using: '', error: '' });
  useEffect(() => {
    const controller =
      request.current?.key === key && !request.current.controller.signal.aborted
        ? request.current.controller
        : new AbortController();
    request.current = { key, controller };
    setState((prior) =>
      prior.key === key ? prior : { key, using: '', error: '' },
    );
    return () => controller.abort();
  }, [key, data]);
  useEffect(() => {
    if (!props.active)
      setState((prior) =>
        prior.key === key && prior.using ? { ...prior, using: '' } : prior,
      );
  }, [key, props.active]);
  async function setFavorite(objectId: string, favorite: boolean) {
    if (!props.active || !props.viewerId) return;
    const controller =
        request.current?.key === key &&
        !request.current.controller.signal.aborted
          ? request.current.controller
          : new AbortController(),
      generation = ++epoch.current;
    request.current = { key, controller };
    setState({ key, using: objectId, error: '' });
    try {
      const result = await data.favorite(
        {
          workspaceId: props.workspaceId,
          objectId,
          body: { favorite },
        },
        controller.signal,
      );
      if (controller.signal.aborted || current.current !== key) return;
      if (
        result.viewerId !== props.viewerId ||
        result.objectId !== objectId ||
        result.favorite !== favorite
      )
        throw Error('操作未完成，请重试。');
      if (generation === epoch.current) setState({ key, using: '', error: '' });
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        current.current === key &&
        generation === epoch.current
      )
        setState({
          key,
          using: '',
          error:
            cause instanceof Error ? cause.message : '操作未完成，请重试。',
        });
    } finally {
      // Hiding a retained panel does not cancel an accepted server write.
      // Re-read current metadata even when a newer local action owns busy/error.
      if (!controller.signal.aborted && current.current === key)
        window.dispatchEvent(new Event('allrice:workbench-files-changed'));
    }
  }
  return {
    using: state.key === key ? state.using : '',
    error: state.key === key ? state.error : '',
    disabled: !props.viewerId || !props.active,
    setFavorite,
  };
}
