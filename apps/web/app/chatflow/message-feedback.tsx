'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { z } from 'zod';
import {
  MessageFeedbackItemSchema,
  type TaskRuntimeTiming,
} from '@allrice/contracts';
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { MessageFeedbackController } from './dsh-upstream/feedback/controller';
import { FeedbackDialogController } from './dsh-upstream/feedback/dialog';
import { MessageFeedbackActions } from './dsh-upstream/feedback/MessageFeedbackActions';
import { FeedbackDialog } from './dsh-upstream/feedback/FeedbackDialog';
import { MessageIconActions } from './dsh-upstream/feedback/MessageIconActions';
import { feedbackTranslate } from './feedback-labels';
import type { ClientRemote, HostObservable } from './feedback-native-types';
import { formatRunDuration } from './run-timing';
import css from './message-feedback.module.css';

function createFeedback(
  sessionId: string,
  workspaceId: string,
  headers: Record<string, string>,
) {
  const endpoint = `/api/v1/sessions/${sessionId}/message-feedback?workspaceId=${workspaceId}`;
  async function request<T>(
    method: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ) {
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        cache: 'no-store',
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok)
        return {
          ok: false as const,
          error: { code: 'request-failed', message: '反馈暂时不可用，请重试' },
        };
      const result = z
        .discriminatedUnion('ok', [
          z.object({ ok: z.literal(true), value: schema }),
          z.object({
            ok: z.literal(false),
            error: z.object({
              code: z.string(),
              current: MessageFeedbackItemSchema.nullable(),
            }),
          }),
        ])
        .parse(await response.json());
      return { ok: true as const, value: result };
    } catch {
      return {
        ok: false as const,
        error: { code: 'network', message: '反馈暂时不可用，请重试' },
      };
    }
  }
  const remote: ClientRemote['messageFeedback'] = {
    list: () =>
      request('GET', z.object({ items: z.array(MessageFeedbackItemSchema) })),
    put: ({ messageId, rating, note, category, ifVersion }) =>
      request('PUT', MessageFeedbackItemSchema, {
        messageId,
        rating,
        note,
        category,
        ifVersion,
      }),
    delete: ({ messageId, ifVersion }) =>
      request('DELETE', z.object({ absent: z.literal(true) }), {
        messageId,
        ifVersion,
      }),
  };
  const feedback = new MessageFeedbackController(remote, sessionId);
  const dialog = new FeedbackDialogController((target, entry) =>
    target.kind === 'message'
      ? feedback.rate(target.messageId, target.rating, entry)
      : Promise.resolve({
          ok: false,
          error: { code: 'unsupported', message: '请选择一条回复' },
        }),
  );
  const useFeedback = <R,>(
    select: (view: ReturnType<typeof feedback.getSnapshot>) => R,
  ) => useSelected(feedback, select);
  const useDialog = <R,>(
    select: (view: ReturnType<typeof dialog.state.getSnapshot>) => R,
  ) => useSelected(dialog.state, select);
  const dialogProps = {
    useDialog,
    edit: (draft: Parameters<typeof dialog.edit>[0]) => dialog.edit(draft),
    submit: () => dialog.submitDraft(),
    dismiss: () => dialog.dismiss(),
    dismissFailure: () => dialog.dismissFailure(),
    dismissToast: (seq: number) => dialog.dismissToast(seq),
  };
  return { feedback, dialog, useFeedback, dialogProps };
}
function useSelected<T, R>(store: HostObservable<T>, select: (value: T) => R) {
  return select(
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot),
  );
}
const FeedbackContext = createContext<ReturnType<typeof createFeedback> | null>(
  null,
);

/** Key this provider by tenant/workspace/viewer/session so late replies cannot cross scopes. */
export function MessageFeedbackProvider({
  sessionId,
  workspaceId,
  headers,
  children,
}: {
  sessionId: string;
  workspaceId: string;
  headers: Record<string, string>;
  children: ReactNode;
}) {
  const [surface] = useState(() =>
    createFeedback(sessionId, workspaceId, headers),
  );
  const lifecycle = useRef(0);
  useEffect(() => {
    lifecycle.current++;
    return () => {
      const generation = ++lifecycle.current;
      queueMicrotask(() => {
        if (generation === lifecycle.current) {
          surface.feedback.dispose();
          surface.dialog.dispose();
        }
      });
    };
  }, [surface]);
  return (
    <FeedbackContext.Provider value={surface}>
      {children}
      <FeedbackDialog {...surface.dialogProps} t={feedbackTranslate} />
    </FeedbackContext.Provider>
  );
}

export function AssistantMessageActions({
  messageId,
  text,
  createdAt,
  timing,
}: {
  messageId: string;
  text: string;
  createdAt: string;
  timing?: TaskRuntimeTiming;
}) {
  const surface = useContext(FeedbackContext);
  return (
    <MessageIconActions
      className={css.actions}
      text={text}
      time={Date.parse(createdAt)}
      clock="end"
      t={feedbackTranslate}
      extraActions={
        surface && (
          <MessageFeedbackActions
            messageId={messageId}
            useFeedback={surface.useFeedback}
            ensure={() => surface.feedback.ensure()}
            current={(id) => surface.feedback.getSnapshot().items.get(id)}
            retract={(id, rating) => surface.feedback.retract(id, rating)}
            openDialog={(id, rating) =>
              surface.dialog.open({ kind: 'message', messageId: id, rating })
            }
            t={feedbackTranslate}
          />
        )
      }
      usageAction={
        timing && (
          <span className={css.duration}>
            <IconClockOutlineRegular />
            用时 {formatRunDuration(timing.wallMs)}
          </span>
        )
      }
    />
  );
}
