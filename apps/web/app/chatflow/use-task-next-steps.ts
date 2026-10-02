'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TaskNextStepsSchema, type TaskNextSteps } from '@allrice/contracts';
import { taskNextStepsMatchScope } from '../../lib/chatflow/task-next-steps';

export function useTaskNextSteps(input: {
  organizationId?: string;
  workspaceId?: string;
  viewerId?: string | null;
  sessionId: string | null;
  employeeAssignmentId?: string;
  employeeVersionId?: string;
  runRevision: string;
  headers: Record<string, string>;
}) {
  const {
    organizationId,
    workspaceId,
    viewerId,
    sessionId,
    employeeAssignmentId,
    employeeVersionId,
    runRevision,
    headers,
  } = input;
  const scope = JSON.stringify([
    organizationId,
    workspaceId,
    viewerId,
    sessionId,
    employeeAssignmentId,
    employeeVersionId,
    runRevision,
  ]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    data: TaskNextSteps | null;
  } | null>(null);
  const requests = useRef<{
    controller: AbortController;
    scope: string;
    promise: Promise<TaskNextSteps | null>;
  } | null>(null);
  const reload = useCallback(
    (fresh = false): Promise<TaskNextSteps | null> => {
      if (
        !organizationId ||
        !workspaceId ||
        !viewerId ||
        !sessionId ||
        !employeeAssignmentId ||
        !employeeVersionId
      )
        return Promise.resolve(null);
      if (!fresh && requests.current?.scope === scope)
        return requests.current.promise;
      requests.current?.controller.abort();
      const controller = new AbortController();
      const request = {
        controller,
        scope,
        promise: Promise.resolve<TaskNextSteps | null>(null),
      };
      requests.current = request;
      const current = () =>
        requests.current === request &&
        latestScope.current === scope &&
        !controller.signal.aborted;
      request.promise = (async () => {
        const timeout = window.setTimeout(() => controller.abort(), 15_000);
        try {
          const query = new URLSearchParams({
            workspaceId,
            employeeAssignmentId,
            employeeVersionId,
          });
          const response = await fetch(
            `/api/v1/sessions/${sessionId}/next-steps?${query}`,
            {
              headers,
              cache: 'no-store',
              signal: controller.signal,
            },
          );
          if (!response.ok) throw Error('下一步建议暂不可用');
          const data = TaskNextStepsSchema.parse(await response.json());
          if (
            !taskNextStepsMatchScope(data, {
              organizationId,
              workspaceId,
              viewerId,
              sessionId,
              employeeAssignmentId,
              employeeVersionId,
            })
          )
            throw Error('下一步建议作用域已变化');
          if (!current()) return null;
          setSnapshot({ scope, data });
          return data;
        } catch {
          // Discovery failure cannot alter Run status, history or the draft.
          if (requests.current === request && latestScope.current === scope)
            setSnapshot({ scope, data: null });
          return null;
        } finally {
          window.clearTimeout(timeout);
          if (requests.current === request) requests.current = null;
        }
      })();
      return request.promise;
    },
    [
      organizationId,
      workspaceId,
      viewerId,
      sessionId,
      employeeAssignmentId,
      employeeVersionId,
      scope,
      headers,
    ],
  );
  useEffect(() => {
    void reload();
    return () => {
      requests.current?.controller.abort();
      requests.current = null;
    };
  }, [reload]);
  return { data: snapshot?.scope === scope ? snapshot.data : null, reload };
}
