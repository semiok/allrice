import { employeeChoice, sessionEmployeeKey } from './employee-instances';
import { assistantStreamText } from '../../lib/execution/assistant-stream';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import { requestFailureMessage } from '../../lib/chatflow/request-failure';
import type { Session, Workspace } from './chatflow-types';

type ErrorBody = {
  code?: unknown;
  error?: { code?: unknown; message?: unknown };
} | null;

/**
 * Parse a JSON API response. Failures throw plain words for the person; only a
 * response that says it has no content (204/205) resolves to null. `read`
 * marks a request that changes nothing, so an unreadable answer is not a
 * pending write.
 */
export async function readJson<T>(
  response: Response,
  options: { read?: boolean } = {},
): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow');
    throw new Error(requestFailureMessage({ status: 401 }));
  }
  if (response.ok && [204, 205].includes(response.status)) return null as T;
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch (cause) {
    // A cancelled request stays a cancellation for the caller.
    if ((cause as Error | undefined)?.name === 'AbortError') throw cause;
  }
  if (!response.ok) {
    const failure = body as ErrorBody;
    throw new Error(
      requestFailureMessage({
        status: response.status,
        code: failure?.error?.code ?? failure?.code,
        message: failure?.error?.message,
      }),
    );
  }
  // A success without a readable answer may still have changed something.
  if (body === null)
    throw new Error(
      options.read
        ? '暂时读不到内容，请刷新页面'
        : '结果待确认，请刷新页面查看',
    );
  return body as T;
}

const messageTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
});
export function formatTime(value: string) {
  return messageTimeFormatter.format(new Date(value));
}

export async function fileToBase64(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string') {
        reject(new Error('文件读取失败'));
        return;
      }
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function employeeForSession(workspace: Workspace, session: Session) {
  return employeeChoice(workspace, sessionEmployeeKey(session));
}

export function assistantDelta(events: ChatFlowEventEnvelope[]) {
  return assistantStreamText(events, '');
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;

  textarea.style.height = 'auto';
  const configuredMaxHeight = Number.parseFloat(
    window.getComputedStyle(textarea).maxHeight,
  );
  const maxHeight = Number.isFinite(configuredMaxHeight)
    ? configuredMaxHeight
    : 336;
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
