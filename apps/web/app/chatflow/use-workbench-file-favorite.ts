'use client';

import { useEffect, useRef, useState } from 'react';
import { UuidSchema } from '@allrice/contracts';
import { z } from 'zod';
import { workbenchJson } from '../../lib/chatflow/workbench-model';

const resultSchema = z.object({
  viewerId: UuidSchema,
  objectId: UuidSchema,
  favorite: z.boolean(),
});

/** A personal preference; the server independently checks the current actor and file. */
export function useWorkbenchFileFavorite(props: {
  ownerKey: string;
  viewerId?: string;
  workspaceId: string;
  headers: Record<string, string>;
  active: boolean;
}) {
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
  }, [key]);
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
      const result = resultSchema.parse(
        await workbenchJson(
          `/api/v1/workbench/files/${objectId}/favorite?workspaceId=${encodeURIComponent(props.workspaceId)}`,
          { ...props.headers, 'X-AllRice-Expected-Viewer-Id': props.viewerId },
          {
            method: 'PUT',
            body: JSON.stringify({ favorite }),
            signal: controller.signal,
          },
        ),
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
