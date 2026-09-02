import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import type { Employee, Session, Workspace } from './chatflow-types';

export async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow');
    throw new Error('登录状态已失效');
  }
  const body = (await response.json().catch(() => null)) as
    T | { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
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
  return workspace.employees.find(
    (employee) =>
      employee.id === session.employeeAssignmentId ||
      employee.versions.some(
        (version) => version.id === session.employeeVersionId,
      ),
  );
}

export function providerForEmployee(employee?: Employee) {
  const manifest = employee?.currentVersion.manifest;
  const provider = manifest?.runtimePolicy?.provider;
  if (provider === 'openai-codex' || provider === 'codex') {
    return 'Codex 订阅 · DSH';
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
  if (frozen.provider === 'deepseek-official') return 'DeepSeek · DSH';
  if (/minimax/i.test(frozen.model)) return 'MiniMax · DSH';
  return `${frozen.model} · DSH`;
}

export function assistantDelta(events: ChatFlowEventEnvelope[]) {
  return events
    .filter((event) => event.type === 'assistant.text.delta')
    .map((event) => String(event.payload.text ?? ''))
    .join('');
}

export function nativeExperienceIcon(kind: string) {
  if (kind === 'context') return '▣';
  if (kind === 'search') return '◎';
  if (kind === 'think') return '◉';
  if (kind === 'todo') return '☷';
  if (kind === 'compaction') return '↻';
  return '◇';
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
