'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EmployeeInstanceLifecycleInputSchema,
  EmployeeDetailsSchema,
  EmployeeInstanceSchema,
  UuidSchema,
  type EmployeeDetailsProfile,
  type EmployeeInstance,
} from '@allrice/contracts';
import type { Workspace } from './chatflow-types';
import { readJson } from './chatflow-utils';

type LifecycleInput = ReturnType<
  typeof EmployeeInstanceLifecycleInputSchema.parse
>;
type Operation = LifecycleInput['operation'];
type Mutation = {
  scope: string;
  instanceId: string;
  operation: Operation;
  busy: boolean;
  error?: string;
  uncertain?: boolean;
  denied?: boolean;
  target?: EmployeeDetailsProfile;
};

class InstanceReadError extends Error {
  constructor(
    readonly status: number,
    cause: unknown,
  ) {
    super(
      cause instanceof Error ? cause.message : '归档列表读取失败，请重试。',
    );
  }
}

// Only the HTTP envelope is unpacked here. Domain fields always pass through
// the provider's shared strict schema, including the current archivedAt.
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !(key in value))
    throw new Error('归档列表读取失败，请重试。');
  return Reflect.get(value, key);
}

export function useEmployeeArchive({
  workspace,
  headers,
  selectedInstanceId,
  onChanged,
}: {
  workspace: Workspace | null;
  headers: Record<string, string>;
  selectedInstanceId?: string;
  onChanged: (instance: EmployeeInstance) => void | Promise<void>;
}) {
  const organizationId = workspace?.organizationId;
  const workspaceId = workspace?.workspaceId;
  const ownerId = workspace?.viewerId;
  const scope = `${organizationId}/${workspaceId}/${ownerId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<{
    scope: string;
    instances: EmployeeInstance[];
    loading: boolean;
    error?: string;
  }>();
  const [selected, setSelected] = useState<{
    key: string;
    instance?: EmployeeInstance;
    error?: string;
  }>();
  const selectedKey = `${scope}/${selectedInstanceId}/${revision}`;
  const [mutation, setMutation] = useState<Mutation>();
  const write = useRef<AbortController | null>(null);
  const requests = useRef(new Map<string, LifecycleInput>());

  const validate = useCallback(
    (value: unknown, id?: string) => {
      const instance = EmployeeInstanceSchema.parse(value);
      if (
        instance.organizationId !== organizationId ||
        instance.workspaceId !== workspaceId ||
        instance.ownerId !== ownerId ||
        (id && instance.id !== id)
      )
        throw new Error('归档列表读取失败，请重试。');
      return instance;
    },
    [organizationId, workspaceId, ownerId],
  );
  const readInstance = useCallback(
    async (id: string, signal: AbortSignal) => {
      const response = await fetch(
        `/api/v1/employee-instances/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId ?? '')}`,
        { headers, cache: 'no-store', signal },
      );
      try {
        return validate(
          field(await readJson<unknown>(response), 'instance'),
          id,
        );
      } catch (cause) {
        throw new InstanceReadError(response.status, cause);
      }
    },
    [headers, workspaceId, validate],
  );
  const remember = useCallback(
    (instance: EmployeeInstance) => {
      if (currentScope.current !== scope) return;
      setPage((previous) => {
        const instances = previous?.scope === scope ? previous.instances : [];
        const old = instances.find((row) => row.id === instance.id);
        return {
          scope,
          loading: previous?.scope === scope && previous.loading,
          ...(previous?.scope === scope && previous.error
            ? { error: previous.error }
            : {}),
          instances:
            old && old.revision > instance.revision
              ? instances
              : [
                  ...instances.filter((row) => row.id !== instance.id),
                  instance,
                ],
        };
      });
    },
    [scope],
  );
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    requests.current.clear();
    write.current?.abort();
    write.current = null;
    setMutation(undefined);
    return () => write.current?.abort();
  }, [scope]);

  useEffect(() => {
    if (!organizationId || !workspaceId || !ownerId) return;
    const controller = new AbortController();
    setPage((old) => ({
      scope,
      instances: old?.scope === scope ? old.instances : [],
      loading: true,
    }));
    void (async () => {
      const instances = new Map<string, EmployeeInstance>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ workspaceId, view: 'history' });
        if (cursor) query.set('beforeId', cursor);
        const response = await fetch(`/api/v1/employee-instances?${query}`, {
          headers,
          cache: 'no-store',
          signal: controller.signal,
        });
        let body: unknown;
        try {
          body = await readJson<unknown>(response);
        } catch (cause) {
          throw new InstanceReadError(response.status, cause);
        }
        for (const raw of EmployeeInstanceSchema.array().parse(
          field(body, 'instances'),
        )) {
          const instance = validate(raw);
          instances.set(instance.id, instance);
        }
        cursor = UuidSchema.nullable().parse(field(body, 'nextBeforeId'));
        if (cursor && cursors.has(cursor))
          throw new Error('归档列表读取失败，请重试。');
        if (cursor) cursors.add(cursor);
      } while (cursor && !controller.signal.aborted);
      if (controller.signal.aborted || currentScope.current !== scope) return;
      setPage((old) => {
        // A selected-instance read or lifecycle receipt may be newer than a
        // page that started before it. Never restore an older lifecycle value.
        for (const instance of old?.scope === scope ? old.instances : []) {
          const incoming = instances.get(instance.id);
          if (incoming && instance.revision > incoming.revision)
            instances.set(instance.id, instance);
        }
        return { scope, loading: false, instances: [...instances.values()] };
      });
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted && currentScope.current === scope)
        setPage((old) => ({
          scope,
          instances:
            old?.scope === scope &&
            !(
              cause instanceof InstanceReadError &&
              [401, 403, 404].includes(cause.status)
            )
              ? old.instances
              : [],
          loading: false,
          error: '归档列表读取失败，请重试。',
        }));
    });
    return () => controller.abort();
  }, [
    organizationId,
    workspaceId,
    ownerId,
    scope,
    headers,
    revision,
    validate,
  ]);

  useEffect(() => {
    if (!selectedInstanceId || !ownerId) return;
    const controller = new AbortController();
    void readInstance(selectedInstanceId, controller.signal)
      .then((instance) => {
        if (!controller.signal.aborted && currentScope.current === scope) {
          setSelected({ key: selectedKey, instance });
          remember(instance);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && currentScope.current === scope)
          setSelected({
            key: selectedKey,
            error:
              cause instanceof Error
                ? cause.message
                : '归档列表读取失败，请重试。',
          });
      });
    return () => controller.abort();
  }, [selectedInstanceId, ownerId, scope, selectedKey, readInstance, remember]);

  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  async function mutate(
    operation: Operation,
    target: EmployeeDetailsProfile | EmployeeInstance,
  ) {
    if (!workspaceId || !ownerId || write.current) return false;
    const instanceId = 'instanceId' in target ? target.instanceId : target.id;
    if (
      operation === 'archive' &&
      (!('canArchive' in target) || target.canArchive !== true)
    )
      return false;
    const controller = new AbortController();
    write.current = controller;
    const key = `${scope}/${instanceId}/${operation}`;
    let input = requests.current.get(key);
    let knownFailure = false;
    let denied = false;
    let attempted = false;
    setMutation({
      scope,
      instanceId,
      operation,
      busy: true,
      ...('instanceId' in target ? { target } : {}),
    });
    try {
      if (!input) {
        // Restore the latest archived snapshot, never a chosen old persona.
        const current =
          operation === 'restore'
            ? await readInstance(instanceId, controller.signal)
            : undefined;
        if (current && !current.archivedAt) {
          remember(current);
          await changed.current(current);
          reload();
          return true;
        }
        input = EmployeeInstanceLifecycleInputSchema.parse({
          workspaceId,
          requestId: crypto.randomUUID(),
          expectedRevision: current?.revision ?? target.revision,
          operation,
          ...(current ? { sourceRevision: current.revision } : {}),
        });
        requests.current.set(key, input);
      }
      attempted = true;
      const response = await fetch(
        `/api/v1/employee-instances/${encodeURIComponent(instanceId)}/lifecycle`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      knownFailure = response.status >= 400 && response.status < 500;
      denied = [401, 403, 404].includes(response.status);
      const receipt = validate(
        field(await readJson<unknown>(response), 'instance'),
        instanceId,
      );
      if (
        receipt.revision !== input.expectedRevision + 1 ||
        Boolean(receipt.archivedAt) !== (operation === 'archive')
      )
        throw new Error('归档列表读取失败，请重试。');
      const current = await readInstance(instanceId, controller.signal);
      if (Boolean(current.archivedAt) !== (operation === 'archive'))
        throw new Error('归档列表读取失败，请重试。');
      if (controller.signal.aborted || currentScope.current !== scope)
        return false;
      remember(current);
      requests.current.delete(key);
      await changed.current(current);
      reload();
      return true;
    } catch (cause) {
      if (controller.signal.aborted || currentScope.current !== scope)
        return false;
      let current: EmployeeInstance | undefined;
      let readDenied =
        cause instanceof InstanceReadError &&
        [401, 403, 404].includes(cause.status);
      if (!readDenied) {
        try {
          current = await readInstance(instanceId, controller.signal);
        } catch (readError) {
          readDenied =
            readError instanceof InstanceReadError &&
            [401, 403, 404].includes(readError.status);
        }
      }
      if (controller.signal.aborted || currentScope.current !== scope)
        return false;
      if (current) remember(current);
      if (readDenied) {
        setPage({
          scope,
          instances: [],
          loading: false,
          error:
            cause instanceof Error
              ? cause.message
              : '归档列表读取失败，请重试。',
        });
        setSelected({
          key: selectedKey,
          error:
            cause instanceof Error
              ? cause.message
              : '归档列表读取失败，请重试。',
        });
      }
      if (
        current &&
        Boolean(current.archivedAt) === (operation === 'archive')
      ) {
        requests.current.delete(key);
        await changed.current(current);
        reload();
        return true;
      }
      if (knownFailure) requests.current.delete(key);
      const confirmedFailure = knownFailure && current !== undefined;
      let refreshedTarget: EmployeeDetailsProfile | undefined;
      if (confirmedFailure && operation === 'archive' && !current?.archivedAt) {
        try {
          const body = await fetch(
            `/api/v1/employee-instances/${encodeURIComponent(instanceId)}/content?workspaceId=${encodeURIComponent(workspaceId)}`,
            { headers, cache: 'no-store', signal: controller.signal },
          ).then(readJson<unknown>);
          const detail = EmployeeDetailsSchema.parse(body);
          if (detail.profile.instanceId === instanceId)
            refreshedTarget = detail.profile;
        } catch {
          /* Do not silently advance the confirmation to an unread target. */
        }
      }
      if (controller.signal.aborted || currentScope.current !== scope)
        return false;
      setMutation({
        scope,
        instanceId,
        operation,
        busy: false,
        denied: denied || readDenied,
        target: refreshedTarget,
        uncertain: attempted && !confirmedFailure && !denied && !readDenied,
        ...(confirmedFailure
          ? {
              error:
                operation === 'archive'
                  ? '归档失败，员工尚未归档。请重试。'
                  : '恢复失败，员工仍处于归档状态。请重试。',
            }
          : denied || readDenied || !attempted
            ? {
                error:
                  cause instanceof Error
                    ? cause.message
                    : '归档列表读取失败，请重试。',
              }
            : {}),
      });
      return false;
    } finally {
      if (write.current === controller) {
        write.current = null;
        setMutation((old) =>
          old?.scope === scope ? { ...old, busy: false } : old,
        );
      }
    }
  }

  const instances = useMemo(
    () => (page?.scope === scope ? page.instances : []),
    [page, scope],
  );
  const archivedIds = useMemo(
    () =>
      new Set(
        instances
          .filter((instance) => instance.archivedAt)
          .map((instance) => instance.id),
      ),
    [instances],
  );
  const selectedRead = selected?.key === selectedKey ? selected : undefined;
  return {
    scope,
    instances,
    archivedIds,
    loading: !page || page.scope !== scope || page.loading,
    error: page?.scope === scope ? page.error : undefined,
    selectedInstance: selectedRead?.instance,
    selectedError: selectedRead?.error,
    selectedPending: Boolean(selectedInstanceId && !selectedRead),
    mutation: mutation?.scope === scope ? mutation : undefined,
    reload,
    archive: (target: EmployeeDetailsProfile) => mutate('archive', target),
    restore: (target: EmployeeInstance) => mutate('restore', target),
  };
}
