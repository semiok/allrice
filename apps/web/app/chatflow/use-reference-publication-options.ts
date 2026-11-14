'use client';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ReferenceLibraryOptionsSchema, UuidSchema } from '@allrice/contracts';
import { workbenchJson } from '../../lib/chatflow/workbench-model';

export type ReferencePublicationOptions = z.infer<
  typeof ReferenceLibraryOptionsSchema
>;
const responseSchema = z.object({
  viewerId: UuidSchema,
  options: ReferenceLibraryOptionsSchema,
});

/** Only the existing publication options are needed by a deliverable form.
 * The current viewer is a response identity check, never write ownership. */
export function useReferencePublicationOptions(props: {
  workspaceId: string;
  viewerId?: string;
  headers: Record<string, string>;
  active: boolean;
  supplied?: ReferencePublicationOptions;
}) {
  const headerKey = JSON.stringify(props.headers);
  const key = `${props.workspaceId}/${props.viewerId}/${headerKey}`;
  const [result, setResult] = useState<{
    key: string;
    options?: ReferencePublicationOptions;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!props.active || !props.viewerId || props.supplied) return;
    const controller = new AbortController();
    void workbenchJson(
      '/api/v1/references/publications?' +
        new URLSearchParams({
          workspaceId: props.workspaceId,
          category: 'all',
          limit: '1',
        }),
      JSON.parse(headerKey),
      { signal: controller.signal },
    )
      .then(responseSchema.parse)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (
          value.viewerId !== props.viewerId ||
          value.options.workspaceId !== props.workspaceId
        )
          throw Error('Publication viewer changed');
        setResult({ key, options: value.options });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ key, error: '发布未完成，请重试。' });
      });
    return () => controller.abort();
  }, [
    key,
    props.active,
    props.supplied,
    props.workspaceId,
    props.viewerId,
    headerKey,
  ]);
  return props.supplied?.workspaceId === props.workspaceId
    ? { options: props.supplied }
    : result?.key === key
      ? result
      : {};
}
