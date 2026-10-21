'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  WorkflowPackageSchema,
  brandContentTemplateKeys,
} from '@allrice/contracts';

const CatalogSchema = z.object({ packages: z.array(WorkflowPackageSchema) });

/** Only a registered business package on this viewer's custom instance exposes
 * the entry. Scope equality hides an old result in the switching render itself. */
export function useBrandContentWorkspace(input: {
  scopeId: string;
  workspaceId: string;
  viewerId?: string | null;
  instanceId?: string;
  kind?: 'general' | 'custom';
  headers: Record<string, string>;
}) {
  const { scopeId, workspaceId, viewerId, instanceId, kind } = input;
  const scope = JSON.stringify([
    scopeId,
    viewerId,
    workspaceId,
    instanceId,
    kind,
  ]);
  const lifetime = useRef({ scope, generation: 0 });
  if (lifetime.current.scope !== scope)
    lifetime.current = { scope, generation: lifetime.current.generation + 1 };
  const generation = lifetime.current.generation;
  const eligible = Boolean(viewerId && instanceId && kind === 'custom');
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const headers = useRef(input.headers);
  headers.current = input.headers;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    generation: number;
    available: boolean;
    keys: string[];
  } | null>(null);

  useEffect(() => {
    if (!eligible || !instanceId || !viewerId) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    const current = () =>
      !controller.signal.aborted && latestScope.current === scope;
    const query = new URLSearchParams({ workspaceId, catalogOnly: '1' });
    void fetch(
      `/api/v1/employee-instances/${encodeURIComponent(instanceId)}/brand-content?${query}`,
      {
        headers: headers.current,
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw Error('Business catalog unavailable');
        const catalog = CatalogSchema.parse(await response.json());
        const keys: readonly string[] = Object.values(brandContentTemplateKeys);
        const available = catalog.packages.some(
          (item) =>
            item.instanceId === instanceId &&
            item.workspaceId === workspaceId &&
            item.ownerId === viewerId &&
            keys.includes(item.manifest.templateKey),
        );
        if (current())
          setSnapshot({
            scope,
            generation,
            available,
            keys: catalog.packages
              .filter(
                (item) =>
                  item.instanceId === instanceId &&
                  item.workspaceId === workspaceId &&
                  item.ownerId === viewerId &&
                  keys.includes(item.manifest.templateKey),
              )
              .map((item) => item.workflow.id + '/' + item.checksum),
          });
      })
      .catch(() => {
        if (current())
          setSnapshot({ scope, generation, available: false, keys: [] });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [eligible, generation, instanceId, scope, viewerId, workspaceId]);

  return {
    scope: `${scope}/${generation}`,
    keys:
      snapshot?.scope === scope && snapshot.generation === generation
        ? snapshot.keys
        : [],
    available:
      eligible &&
      snapshot?.scope === scope &&
      snapshot.generation === generation &&
      snapshot.available,
  };
}
