'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  NativeSubagentControlResultSchema,
  NativeSubagentControlMessageSchema,
  UuidSchema,
  type NativeSubagentControlInput,
  type NativeSubagentControlTicket,
  type NativeSubagentSummary,
} from '@allrice/contracts';
import type { Attachment, RunView } from './chatflow-types';
import css from './native-subagent-directory.module.css';
import { ChatComposerInput } from './chat-composer';
import { useAttachments } from './use-attachments';
import { AttachmentPreviewDialog } from './attachment-preview-dialog';
import { MessageImageGallery } from './attachment-components';
import { createMessageImageCache } from './message-image-cache';

type Root = { rootRunId: string; generation: number };
const rootKey = (root?: Root | null) =>
  `${root?.rootRunId}/${root?.generation}`;
type Child = Extract<
  NativeSubagentSummary['descendants'][number],
  { kind: 'child' }
>;
type Reference = Root & {
  input: Pick<
    NativeSubagentControlInput,
    'kind' | 'requestId' | 'parentSessionId' | 'childSessionId' | 'mode'
  >;
};
type Attempt = {
  reference: Reference;
  ticket?: NativeSubagentControlTicket;
  notice?: string;
  busy?: boolean;
  message?: NativeSubagentControlTicket['message'];
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
    accepted:
      ticket?.kind === 'prompt'
        ? '消息已被原生接收；不代表已经处理。'
        : '停止请求已接收；不代表子任务已经停止。在途工具仍可能继续输出、生成文件和产生用量，请以实际运行状态为准。',
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
  const [imageCache] = useState(createMessageImageCache);
  useEffect(() => () => imageCache.dispose(), [imageCache]);
  useEffect(
    () => () => imageCache.release(storageKey),
    [imageCache, storageKey],
  );
  const imageSource = useMemo(
    () => ({
      load: imageCache.loader(storageKey, headers),
      reference: (attachment: Attachment) =>
        imageCache.reference(storageKey, attachment),
    }),
    [imageCache, storageKey, headers],
  );
  const [attempts, setAttempts] = useState<Record<string, Attempt>>(() => {
    try {
      const saved: Reference[] = JSON.parse(
        sessionStorage.getItem(storageKey) ?? '[]',
      );
      return Object.fromEntries(
        saved
          .filter(
            (r) =>
              ['interrupt', 'prompt'].includes(r?.input?.kind) &&
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
  const publish = (attempt: Attempt, remember = false) => {
    latest.current = {
      ...latest.current,
      [attempt.reference.input.requestId]: attempt,
    };
    setAttempts(latest.current);
    if (!remember) return;
    try {
      // Only explicit creation persists immutable references, never network results.
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(Object.values(latest.current).map((a) => a.reference)),
      );
    } catch {
      /* Storage may be unavailable. */
    }
  };
  const url = `/api/v1/sessions/${encodeURIComponent(sessionId)}/subagents/controls?${new URLSearchParams({ workspaceId })}`;
  const request = async (
    reference: Reference,
    post?: NativeSubagentControlInput,
    message?: NativeSubagentControlTicket['message'],
  ) => {
    const { input } = reference;
    const key = JSON.stringify([
      rootKey(reference),
      input.parentSessionId,
      input.childSessionId,
      input.kind,
    ]);
    if (locks.current.has(key)) return;
    locks.current.add(key);
    const previous = {
      ...latest.current[input.requestId],
      ...(message ? { message } : {}),
    };
    publish({ ...previous, reference, busy: true }, !!post);
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
          ...(post
            ? { body: JSON.stringify({ ...reference, input: post }) }
            : {}),
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
        return response.status >= 500;
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
      if (ticket.message)
        NativeSubagentControlMessageSchema.parse(ticket.message);
      publish({
        ...previous,
        reference,
        ticket,
        message: ticket.message ?? previous.message,
      });
      return ticket.result.status !== 'rejected';
    } catch {
      const notice = post
        ? '提交结果未知，请保留请求 ID 并查看回执；不会自动重发。'
        : '暂时无法读取回执；不会重新提交原请求。';
      publish({ ...previous, reference, notice });
      return true;
    } finally {
      locks.current.delete(key);
    }
  };
  const create = (
    root: Root,
    child: Child,
    payload:
      | { kind: 'interrupt' }
      | Pick<
          Extract<NativeSubagentControlInput, { kind: 'prompt' }>,
          'kind' | 'content' | 'delivery'
        >,
    images: NonNullable<NativeSubagentControlTicket['message']>['images'] = [],
  ) => {
    const address = {
      requestId: crypto.randomUUID(),
      parentSessionId: child.parentId,
      childSessionId: child.id,
      mode: 'continuable' as const,
      kind: payload.kind,
    };
    return request(
      { ...root, input: address },
      {
        ...address,
        ...payload,
        ...(payload.kind === 'prompt'
          ? { clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : {}),
      },
      payload.kind === 'prompt'
        ? { content: payload.content, images }
        : undefined,
    );
  };
  return {
    workspaceId,
    sessionId,
    headers,
    imageSource,
    attempts: Object.values(attempts),
    check: (reference: Reference) => request(reference),
    stop: (root: Root, child: Child) =>
      create(root, child, { kind: 'interrupt' }),
    send: (
      root: Root,
      child: Child,
      content: Extract<
        NativeSubagentControlInput,
        { kind: 'prompt' }
      >['content'],
      delivery: 'queue' | 'steer',
      images: NonNullable<NativeSubagentControlTicket['message']>['images'],
    ) => create(root, child, { kind: 'prompt', content, delivery }, images),
  };
}

export function NativeSubagentControls({
  childId,
  child,
  root,
  permitted,
  controls,
  parentAvailable,
}: {
  childId: string;
  child?: Child;
  root: Root | null;
  permitted: boolean;
  controls: ReturnType<typeof useNativeSubagentControls>;
  parentAvailable?: boolean;
}) {
  const [draft, setDraft] = useState(''),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false),
    sendingRef = useRef(false);
  const attachments = useAttachments({
    busy: sending,
    setError,
    tenantHeaders: controls.headers,
    workspace: { workspaceId: controls.workspaceId },
  });
  const identity = `${controls.workspaceId}/${controls.sessionId}/${rootKey(root)}/${child?.parentId}/${child?.id}/${permitted}/${parentAvailable}`;
  const current = useRef<string | null>(identity);
  current.current = identity;
  useEffect(
    () => () => {
      current.current = null;
    },
    [],
  );
  const attempts = controls.attempts.filter(
    ({ reference: { input } }) =>
      input.childSessionId === childId &&
      (!child || input.parentSessionId === child.parentId),
  );
  const reason = !permitted
    ? '仅会话所有者可控制子任务。'
    : !root
      ? '当前没有可控制的根运行，子任务保持只读。'
      : !child
        ? '当前无法读取子任务状态，仅可查看已有回执。'
        : '';
  const busy = attempts.some(
    (attempt) =>
      attempt.reference.input.kind === 'interrupt' &&
      attempt.busy &&
      rootKey(attempt.reference) === rootKey(root),
  );
  const sendReason =
    reason ||
    (parentAvailable === true
      ? ''
      : parentAvailable === false
        ? '直属父智能体当前不可用。'
        : '直属父智能体状态未知，暂不能发送。');
  const send = async (modified: boolean) => {
    if (
      sendingRef.current ||
      sendReason ||
      !root ||
      !child ||
      (!draft.trim() && !attachments.pendingAttachments.length)
    )
      return;
    sendingRef.current = true;
    setSending(true);
    setError('');
    const captured = identity;
    try {
      const images = await Promise.all(
        attachments.pendingAttachments.map((image) =>
          attachments.persistPendingAttachment(image, controls.sessionId),
        ),
      );
      if (current.current !== captured) return;
      const submitted = await controls.send(
        root,
        child,
        [
          ...(draft.trim() ? [{ type: 'text' as const, text: draft }] : []),
          ...images.map((image) => ({
            type: 'image' as const,
            objectId: image.id,
          })),
        ],
        modified && child.running === true ? 'steer' : 'queue',
        NativeSubagentControlMessageSchema.shape.images.parse(
          images.map(({ id, fileName, mediaType, sizeBytes }) => ({
            id,
            fileName,
            mediaType,
            sizeBytes,
          })),
        ),
      );
      if (submitted && current.current === captured) {
        setDraft('');
        attachments.clearPendingAttachments();
      }
    } catch (cause) {
      if (current.current === captured)
        setError(cause instanceof Error ? cause.message : '图片上传失败。');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const intake = (files: FileList | File[]) => {
    const batch = [...files];
    if (
      batch.some(
        (file) =>
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
            file.type,
          ) || file.size > 20 * 1024 * 1024,
      )
    ) {
      setError(
        '整批图片未添加：仅支持 PNG、JPEG、WebP、GIF，单张不超过 20 MB。',
      );
      return;
    }
    attachments.uploadAttachments(batch);
  };
  if (!child && !attempts.length) return null;
  return (
    <section className={css.controls} aria-label="子任务控制">
      <h3>子任务控制</h3>
      {reason && <p role="status">{reason}</p>}
      {child?.mode === 'continuable' && (
        <>
          {sendReason && sendReason !== reason && (
            <p role="status">{sendReason}</p>
          )}
          <ChatComposerInput
            employeeName={child.title || '子任务'}
            draft={draft}
            onDraftChange={setDraft}
            busy={sending || !!sendReason}
            composerInput={textarea}
            composing={composing}
            imageOnly
            pendingAttachments={attachments.pendingAttachments}
            onOpenAttachment={attachments.setAttachmentPreview}
            onRemoveAttachment={attachments.removePendingAttachment}
            onRetryAttachment={(target) => {
              attachments.setPendingAttachments((pending) =>
                pending.map((image) =>
                  image.id === target.id
                    ? { ...image, status: 'draft', error: undefined }
                    : image,
                ),
              );
              setError('');
            }}
            onUploadAttachments={intake}
            onInputError={setError}
            onSubmit={(modified) => void send(modified)}
          />
          <Button
            size="sm"
            disabled={
              sending ||
              !!sendReason ||
              (!draft.trim() && !attachments.pendingAttachments.length)
            }
            onClick={(event) => {
              if (event.detail < 2) void send(event.ctrlKey !== event.metaKey);
            }}
          >
            {child.running === true ? 'Queue' : '发送'}
          </Button>
          {child.running === true && (
            <small>Enter / 点击：Queue；Ctrl / ⌘ + Enter / 点击：Steer</small>
          )}
          {error && <p role="alert">{error}</p>}
          <AttachmentPreviewDialog
            attachment={attachments.attachmentPreview}
            onClose={() => attachments.setAttachmentPreview(null)}
          />
        </>
      )}
      {child?.running === true && child.mode === 'continuable' && (
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
        <small>旧请求请查看回执；新请求是独立操作。</small>
      )}
      {attempts.map(({ reference, ticket, notice, busy, message }) => (
        <div
          key={reference.input.requestId}
          aria-label={
            reference.input.kind === 'prompt' ? '发送回执' : 'Stop 回执'
          }
        >
          {message && (
            <>
              <small>本次发送内容</small>
              <p style={{ whiteSpace: 'pre-wrap' }}>
                {message.content
                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  .join('\n')}
              </p>
              <MessageImageGallery
                attachments={message.images}
                source={controls.imageSource}
              />
            </>
          )}
          {rootKey(reference) !== rootKey(root) && (
            <small>此前根运行的请求</small>
          )}
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
