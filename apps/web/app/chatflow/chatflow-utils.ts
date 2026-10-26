import { employeeChoice, sessionEmployeeKey } from './employee-instances';
import { assistantStreamText } from '../../lib/execution/assistant-stream';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import type { Employee, Session, Workspace } from './chatflow-types';

const statusMessages: Record<number, string> = {
  401: '登录已过期，请重新登录',
  403: '没有权限',
  404: '内容不存在或已删除',
  409: '内容已被修改，请刷新后再试',
  413: '内容太大',
  429: '操作太频繁，请稍后再试',
};

/** Plain words for a failed request: Chinese server copy, never a status code. */
function requestFailureMessage(status: number, serverMessage?: unknown) {
  if (
    typeof serverMessage === 'string' &&
    /[\u3400-\u9fff]/.test(serverMessage)
  )
    return serverMessage;
  return (
    statusMessages[status] ??
    (status >= 500 ? '服务暂时不可用，请稍后再试' : '暂时没有完成，请稍后再试')
  );
}

export async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow');
    throw new Error(statusMessages[401]);
  }
  let body: unknown = null;
  let readable = true;
  try {
    const text = await response.text();
    // An empty success (204) stays null, as before.
    body = text ? JSON.parse(text) : null;
  } catch {
    readable = false;
  }
  if (!response.ok) {
    throw new Error(
      requestFailureMessage(
        response.status,
        (body as { error?: { message?: unknown } } | null)?.error?.message,
      ),
    );
  }
  // A success whose body cannot be read may still have changed something.
  if (!readable) throw new Error('结果待确认，请刷新页面查看');
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

export function providerForEmployee(employee?: Employee) {
  const manifest = employee?.currentVersion.manifest;
  const provider = manifest?.runtimePolicy?.provider;
  if (provider === 'openai-codex' || provider === 'codex') {
    return 'Codex 订阅 · DSH';
  }
  if (provider === 'gemini' || provider === 'google') {
    return 'Gemini API · DSH';
  }
  if (provider === 'deepseek-official') return 'DeepSeek · DSH';
  if (provider === 'openai-compatible') return 'API 模型 · DSH';
  return 'DSH';
}

export function providerForSession(workspace: Workspace, session?: Session) {
  const frozen = workspace.sessionModels.find(
    (snapshot) => snapshot.sessionId === session?.id,
  );
  if (!frozen) {
    return providerForEmployee(
      session ? employeeForSession(workspace, session) : undefined,
    );
  }
  if (frozen.provider === 'openai-codex') return 'Codex 订阅 · DSH';
  if (frozen.provider === 'gemini') return 'Gemini API · DSH';
  if (frozen.provider === 'deepseek-official') return 'DeepSeek · DSH';
  if (/minimax/i.test(frozen.model)) return 'MiniMax · DSH';
  return `${frozen.model} · DSH`;
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
