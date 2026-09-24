import {
  ChangesetDocumentSchema,
  ReviewFeedbackSchema,
  WorkbenchArtifactSchema,
  WorkbenchCursorSchema,
  OfficePreviewSchema,
  type OfficePreview,
  type ChangesetDocument,
  type ReviewFeedback,
  type WorkbenchArtifact,
  type RuntimeExecutionScope,
} from '@allrice/contracts';

export type ArtifactPreview =
  | OfficePreview
  | { kind: 'text'; text: string; mediaType: string }
  | { kind: 'changeset'; changeset: ChangesetDocument }
  | {
      kind: 'image';
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      base64: string;
    }
  | { kind: 'download_only'; reason: string };
export type ArtifactCursor = { createdAt: string; id: string };
export function artifactExecutionLabels(execution: RuntimeExecutionScope) {
  return {
    target:
      {
        cloud_sandbox: '云端沙箱',
        cloud_mcp: '远程 MCP 服务',
        rice_bridge: '本地 Bridge',
      }[execution.targetKind] ?? '未知执行目标',
    workCopy:
      {
        in_place: '授权原目录',
        git_worktree: 'Git 隔离工作树',
        cloud_copy: '云端隔离副本',
        local_copy: '本地隔离副本',
        remote_service: '远程服务（无本地工作副本）',
      }[execution.workCopy.kind] ?? '未知工作副本',
    availability:
      execution.targetKind === 'rice_bridge'
        ? '此处不证明设备当前在线'
        : '执行时的目标记录，不代表当前运行状态',
  };
}
export function parseArtifactList(input: unknown): {
  artifacts: WorkbenchArtifact[];
  nextCursor: ArtifactCursor | null;
} {
  const value = input as { artifacts?: unknown[]; nextCursor?: unknown };
  if (!value || !Array.isArray(value.artifacts) || value.artifacts.length > 50)
    throw Error('成果列表格式无效');
  return {
    artifacts: value.artifacts.map((a) => WorkbenchArtifactSchema.parse(a)),
    nextCursor:
      value.nextCursor === null
        ? null
        : WorkbenchCursorSchema.parse(value.nextCursor),
  };
}
export function parseArtifactDetail(input: unknown): {
  artifact: WorkbenchArtifact;
  feedback: ReviewFeedback[];
} {
  const v = input as { artifact: unknown; feedback: unknown[] };
  if (!v || !Array.isArray(v.feedback) || v.feedback.length > 100)
    throw Error('版本反馈格式无效');
  const artifact = WorkbenchArtifactSchema.parse(v.artifact),
    feedback = v.feedback.map((f) => ReviewFeedbackSchema.parse(f));
  if (feedback.some((f) => f.artifactId !== artifact.id))
    throw Error('版本反馈不匹配');
  return { artifact, feedback };
}
export function parseArtifactPreview(input: unknown): ArtifactPreview {
  const v = input as Record<string, unknown>;
  if (!v || typeof v !== 'object') throw Error('预览格式无效');
  if (v.kind === 'office') return OfficePreviewSchema.parse(v);
  if (
    v.kind === 'text' &&
    typeof v.text === 'string' &&
    v.text.length <= 512_000 &&
    typeof v.mediaType === 'string'
  )
    return { kind: 'text', text: v.text, mediaType: v.mediaType };
  if (v.kind === 'changeset')
    return {
      kind: 'changeset',
      changeset: ChangesetDocumentSchema.parse(v.changeset),
    };
  if (
    v.kind === 'image' &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(String(v.mediaType)) &&
    typeof v.base64 === 'string' &&
    v.base64.length <= 684_000 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(v.base64)
  )
    return {
      kind: 'image',
      mediaType: v.mediaType as 'image/png' | 'image/jpeg' | 'image/webp',
      base64: v.base64,
    };
  if (
    v.kind === 'download_only' &&
    typeof v.reason === 'string' &&
    v.reason.length < 1000
  )
    return { kind: 'download_only', reason: v.reason };
  throw Error('预览格式无效');
}
export const artifactKindLabel = (a: WorkbenchArtifact) =>
  ({
    document: '文档',
    plan: '计划',
    changeset: '修改提案',
    command_output: '命令输出',
    browser_capture: '浏览器截图',
    file: '文件',
  })[a.kind];
export function boundedRichDiff(before: string | null, after: string | null) {
  const texts = [before ?? '', after ?? ''];
  return (
    texts.reduce((n, t) => n + new TextEncoder().encode(t).byteLength, 0) <=
      120_000 &&
    texts.reduce((n, t) => n + t.split('\n').length, 0) <= 2500 &&
    texts.every((t) => t.split('\n').every((l) => l.length <= 4000))
  );
}
export function mergeArtifactPage(
  previous: WorkbenchArtifact[],
  page: WorkbenchArtifact[],
) {
  const map = new Map(previous.map((a) => [a.id, a]));
  for (const a of page) map.set(a.id, a);
  return [...map.values()].sort(
    (a, b) =>
      b.version.createdAt.localeCompare(a.version.createdAt) ||
      b.id.localeCompare(a.id),
  );
}
export const reviewAnchorLabel = (
  anchor: ReviewFeedback['comments'][number]['anchor'],
) =>
  anchor.kind === 'whole'
    ? '整个成果'
    : `${anchor.path ?? '正文'} · ${anchor.side === 'before' ? '修改前' : '修改后'} L${anchor.startLine}${anchor.endLine === anchor.startLine ? '' : `–${anchor.endLine}`}`;
export async function workbenchJson(
  url: string,
  headers: Record<string, string>,
  options: RequestInit = {},
) {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: '提交内容或版本无效，请检查后重试。',
      401: '登录已失效，请重新登录。',
      403: '当前权限已撤销或不允许此操作。',
      404: '此成果不可访问，或工作台尚未启用。',
      409: '版本或草稿已变化。请刷新后重新核对；旧意见不会自动批准新内容。',
      413: '文件或评论超过本次大小限制。',
    };
    throw Error(messages[response.status] ?? '成果服务暂不可用，请重试。');
  }
  return response.json() as Promise<unknown>;
}
