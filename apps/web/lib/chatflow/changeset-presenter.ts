// Plain-language wording for saving reviewed file changes to the employee's
// computer. Checksums, error codes and run identities stay in the collapsed
// technical details.

// The task: a Run state (contracts runs.ts) or its operation snapshot state
// (runtime-v2 operations.ts). Waiting states say what they wait for.
const taskLabels: Record<string, string> = {
  planned: '准备中',
  queued: '排队中',
  waiting_user: '等你确认',
  waiting_approval: '等你确认',
  waiting_device: '等待电脑连接',
  waiting_dependency: '等前面的步骤完成',
  ready: '等待电脑连接',
  dispatched: '已发送到电脑',
  running: '正在处理',
  cancel_requested: '正在停止',
  unknown: '结果待确认',
  needs_attention: '需要你查看',
  succeeded: '已完成',
  failed: '未完成',
  canceled: '已停止',
  partial: '部分完成',
};
export const changesetTaskLabel = (status: string) =>
  taskLabels[status] ?? '状态待确认，请刷新查看';

// One file's result (ChangesetFileResultSchema).
const fileLabels: Record<string, string> = {
  pending: '还没开始',
  prepared: '结果待确认',
  applied: '已保存到你的电脑',
  conflict: '没有改动',
  canceled: '已停止，没有改动',
  failed: '未完成',
  unknown: '结果待确认',
};
export const changesetFileLabel = (status: string) =>
  fileLabels[status] ?? '结果待确认';

// Codes reported by apps/rice-bridge: changeset-executor.ts, executor.ts
// (LocalExecutionError), file-organization.ts and native/FileGuardian.swift.
// Only codes with a single cause name it. WRITE_CONFLICT, FILE_CHANGED and
// the other *_CHANGED codes cover a changed file, a missing or already
// existing file, a payload mismatch or lost authority alike, so they get the
// neutral words below.
const reasons: [codes: string[], text: string][] = [
  [
    // FileGuardian EEXIST; a directory to create exists; a file to overwrite
    // without a reviewed checksum (writeTextFile).
    [
      'FILE_DESTINATION_EXISTS',
      'PATH_ALREADY_EXISTS',
      'WRITE_PRECONDITION_REQUIRED',
    ],
    '目标位置已经有同名的文件或文件夹，没有覆盖它。请换个名字或先移走它，再让 AI 员工重新安排。',
  ],
  [
    ['FILE_NOT_FOUND'],
    '找不到这个文件或它所在的文件夹，没有改动。请确认位置后让 AI 员工重新安排。',
  ],
  [
    ['DIRECTORY_NOT_FOUND'],
    '无法访问要保存到的位置，没有改动。请确认这个文件夹存在、AllRice 助手有权限访问，或让 AI 员工换个位置。',
  ],
  [
    ['FILE_DIRECTORY_REQUIRED'],
    '路径里有一段不是文件夹，没有改动。请确认保存位置后让 AI 员工重新安排。',
  ],
  [
    ['GRANT_NOT_FOUND', 'FOLDER_NOT_FOUND'],
    '允许改动的文件夹找不到了，没有改动。可以在「我的电脑」里检查允许的文件夹。',
  ],
  [
    [
      'PATH_OUTSIDE_GRANT',
      'SENSITIVE_PATH',
      'FILE_PATH_DENIED',
      'FILE_ROOT_INVALID',
      'FILE_SYMLINK',
      'FILE_HARD_LINK_UNSUPPORTED',
    ],
    '这个位置不在允许改动的文件夹里，或不能安全地改动，没有改动。可以在「我的电脑」里检查允许的文件夹。',
  ],
  [
    ['FILE_ACCESS_DENIED'],
    '电脑没有权限改动这个位置，没有改动。请检查这个文件或文件夹的权限。',
  ],
  [
    [
      'FILE_TOO_LARGE',
      'FILE_TYPE_UNSUPPORTED',
      'FILE_NAME_UNSUPPORTED',
      'FILE_OPEN_UNSUPPORTED',
      'FILE_PATH_INVALID',
      'FILE_OUTPUT_TOO_LARGE',
      'FILE_REQUEST_TOO_LARGE',
      'FILE_REQUEST_LIMIT',
      'FILE_HASH_BUDGET',
      'FILE_DEPTH_LIMIT',
    ],
    '这个文件太大，或文件名、类型暂不支持，没有改动。',
  ],
  [
    ['AUTHORITY_LOST', 'FILE_CANCELED', 'FILE_OWNER_LOST'],
    '处理中途停止了，或授权已失效，这个文件没有改动。',
  ],
];

/** Why one file did not finish and what to do next; null when it finished. */
export function changesetFileNote(status: string, code?: string) {
  if (status === 'applied' || status === 'pending') return null;
  if (status === 'unknown' || status === 'prepared')
    return '没有收到这个文件的处理结果，请打开文件确认有没有改动。';
  const reason = code && reasons.find(([codes]) => codes.includes(code))?.[1];
  if (reason) return reason;
  // A conflict is a check that failed before any write; a failure may not be.
  return status === 'conflict'
    ? '保存前的检查没有通过，这个文件没有改动。请看一下文件现在的内容，再让 AI 员工重新安排。'
    : status === 'canceled'
      ? '处理已停止，这个文件没有改动。'
      : '这个文件没有处理完。请打开文件看一下现在的内容，再让 AI 员工重新安排。';
}

export function changesetTitle(restore: boolean, organization: boolean) {
  return restore ? '恢复文件' : organization ? '整理文件' : '保存修改';
}

export function changesetApproveLabel(restore: boolean, organization: boolean) {
  return restore
    ? '允许恢复这些文件'
    : organization
      ? '允许整理这些文件'
      : '允许保存这些修改';
}

/** What one reviewed file change does. */
export function fileChangeLabel(file: {
  before: unknown | null;
  after: unknown | null;
}) {
  return !file.before ? '新建文件' : !file.after ? '删除文件' : '修改文件';
}
