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
  current.current = props.active ? key : '';
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const [state, setState] = useState({ key, using: '', error: '' });
  useEffect(() => {
    epoch.current++;
    request.current?.abort();
    setState({ key, using: '', error: '' });
    return () => {
      epoch.current++;
      request.current?.abort();
    };
  }, [key, props.active]);
  async function setFavorite(objectId: string, favorite: boolean) {
    if (!props.active || !props.viewerId) return;
    request.current?.abort();
    const controller = new AbortController(),
      generation = ++epoch.current;
    request.current = controller;
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
      if (
        controller.signal.aborted ||
        current.current !== key ||
        generation !== epoch.current
      )
        return;
      if (
        result.viewerId !== props.viewerId ||
        result.objectId !== objectId ||
        result.favorite !== favorite
      )
        throw Error('操作未完成，请重试。');
      setState({ key, using: '', error: '' });
      window.dispatchEvent(new Event('allrice:workbench-files-changed'));
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
    }
  }
  return {
    using: state.key === key ? state.using : '',
    error: state.key === key ? state.error : '',
    disabled: !props.viewerId || !props.active,
    setFavorite,
  };
}
