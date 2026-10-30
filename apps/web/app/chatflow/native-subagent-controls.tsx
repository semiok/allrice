'use client';
import { useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  NativeSubagentControlResultSchema,
  UuidSchema,
  type NativeSubagentControlInput,
  type NativeSubagentControlTicket,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import type { RunView } from './chatflow-types';
import css from './native-subagent-directory.module.css';

type Root = { rootRunId: string; generation: number };
type Child = Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
>;
type Reference = Root & {
  input: Extract<NativeSubagentControlInput, { kind: 'interrupt' }>;
};
type Attempt = {
  reference: Reference;
  ticket?: NativeSubagentControlTicket;
  notice?: string;
  busy?: boolean;
};
const refusal: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '登录已失效，请重新登录。',
  AUTHORIZATION_DENIED: '当前没有控制此子任务的权限。',
  CHILD_CONTROL_CONFLICT: '请求 ID 与原请求冲突。',
  CHILD_CONTROL_UNAVAILABLE: '根运行或控制权限已变化。',
};
const ticketText = (ticket?: NativeSubagentControlTicket) => {
  const result = ticket?.result;
  if (!result) return '尚无确认结果，请查看原请求回执。';
  if (result.status === 'rejected') return `请求被拒绝：${result.code}`;
  return {
    recorded: '请求已记录，等待原生回执。',
    accepted: '停止请求已接收；不代表子任务已经停止。',
    unknown: '原生接收结果未知，不会自动重发。',
  }[result.status];
};

/** Existing root events are a UI hint; the authenticated backend retains authority. */
export function nativeSubagentControlRoot(view?: RunView): Root | null {
  if (
    !view ||
    !['running', 'connecting'].includes(view.status) ||
    !UuidSchema.safeParse(view.runId).success
  )
    return null;
  const turn = view.events.findLast(
    (event) =>
      event.runId === view.runId &&
      event.harness === 'dsh' &&
      event.type === 'turn.started',
  );
  return turn?.generation != null
    ? { rootRunId: view.runId, generation: turn.generation }
    : null;
}

export function useNativeSubagentControls(
  workspaceId: string,
  sessionId: string,
  headers: Record<string, string>,
  viewerId?: string | null,
) {
  const storageKey = `allrice-child-control-refs:${JSON.stringify([viewerId, workspaceId, sessionId, headers])}`;
  const [attempts, setAttempts] = useState<Record<string, Attempt>>(() => {
    try {
      const saved: Reference[] = JSON.parse(
        sessionStorage.getItem(storageKey) ?? '[]',
      );
      return Object.fromEntries(
        saved
          .filter(
            (r) =>
              r?.input?.kind === 'interrupt' &&
              r.input.mode === 'continuable' &&
              typeof r.input.parentSessionId === 'string' &&
              typeof r.input.childSessionId === 'string' &&
              UuidSchema.safeParse(r.input.requestId).success,
          )
          .map((reference) => [reference.input.requestId, { reference }]),
      );
    } catch {
      return {};
    }
  });
  const latest = useRef(attempts),
    locks = useRef(new Set<string>());
  const publish = (attempt: Attempt) => {
    latest.current = {
      ...latest.current,
      [attempt.reference.input.requestId]: attempt,
    };
    setAttempts(latest.current);
    try {
      // References never restore a confirmation or replay an input after reload.
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(Object.values(latest.current).map((a) => a.reference)),
      );
    } catch {
      /* Storage may be unavailable. */
    }
  };
  const url = `/api/v1/sessions/${encodeURIComponent(sessionId)}/subagents/controls?${new URLSearchParams({ workspaceId })}`;
  const request = async (reference: Reference, post = false) => {
    const { input } = reference;
    const key = JSON.stringify([input.parentSessionId, input.childSessionId]);
    if (locks.current.has(key)) return;
    locks.current.add(key);
    const previous = latest.current[input.requestId];
    publish({ ...previous, reference, busy: true });
    try {
      const response = await fetch(
        post ? url : `${url}&requestId=${input.requestId}`,
        {
          method: post ? 'POST' : 'GET',
          headers: {
            ...headers,
            ...(post ? { 'content-type': 'application/json' } : {}),
          },
          cache: 'no-store',
          ...(post ? { body: JSON.stringify(reference) } : {}),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        const detail = refusal[body?.error?.code] ?? '控制请求被拒绝。';
        const notice = post
          ? response.status < 500
            ? `${detail}本次未提交。`
            : '提交结果未知，请查看原请求回执。'
          : `回执读取失败：${detail}`;
        publish({ ...previous, reference, notice });
        return;
      }
      const ticket = body?.ticket as NativeSubagentControlTicket | undefined;
      if (
        !ticket ||
        ticket.requestId !== input.requestId ||
        ticket.kind !== input.kind ||
        (ticket.result?.status !== 'recorded' &&
          !NativeSubagentControlResultSchema.safeParse(ticket.result)
            .success) ||
        (ticket.result.status === 'accepted' &&
          ticket.result.acceptance.kind !== input.kind)
      )
        throw Error('unreadable ticket');
      publish({ reference, ticket });
    } catch {
      const notice = post
        ? '提交结果未知，请保留请求 ID 并查看回执；不会自动重发。'
        : '暂时无法读取回执；不会重新提交原请求。';
      publish({ ...previous, reference, notice });
    } finally {
      locks.current.delete(key);
    }
  };
  return {
    attempts: Object.values(attempts),
    check: (reference: Reference) => request(reference),
    stop: (root: Root, child: Child) =>
      request(
        {
          ...root,
          input: {
            requestId: crypto.randomUUID(),
            parentSessionId: child.parentId,
            childSessionId: child.id,
            mode: 'continuable',
            kind: 'interrupt',
          },
        },
        true,
      ),
  };
}

export function NativeSubagentControls({
  child,
  root,
  permitted,
  controls,
}: {
  child: Child;
  root: Root | null;
  permitted: boolean;
  controls: ReturnType<typeof useNativeSubagentControls>;
}) {
  const attempts = controls.attempts.filter(
    ({ reference: { input } }) =>
      input.parentSessionId === child.parentId &&
      input.childSessionId === child.id,
  );
  const reason = !permitted
    ? '仅会话所有者可控制子任务。'
    : !root
      ? '当前没有可控制的根运行，子任务保持只读。'
      : '';
  const busy = attempts.some((attempt) => attempt.busy);
  return (
    <section className={css.controls} aria-label="子任务控制">
      <h3>子任务控制</h3>
      {reason && <p role="status">{reason}</p>}
      {child.running === true && child.mode === 'continuable' && (
        <Button
          size="sm"
          disabled={!!reason || busy}
          onClick={(event) => {
            if (event.detail < 2 && root && !reason)
              void controls.stop(root, child);
          }}
        >
          {attempts.length ? '发起新的 Stop 请求' : 'Stop 此子任务'}
        </Button>
      )}
      {attempts.length > 0 && (
        <small>旧请求请查看回执；新请求是独立的停止操作。</small>
      )}
      {attempts.map(({ reference, ticket, notice, busy }) => (
        <div key={reference.input.requestId} aria-label="Stop 回执">
          <p role="status">
            {busy ? '正在提交或读取回执…' : ticketText(ticket)}
          </p>
          {notice && <p role="alert">{notice}</p>}
          <small>
            请求 ID：<code>{reference.input.requestId}</code>
          </small>
          <Button
            size="sm"
            disabled={busy || !permitted}
            onClick={() => void controls.check(reference)}
          >
            查看回执
          </Button>
        </div>
      ))}
    </section>
  );
}
