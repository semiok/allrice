export const fileReadNativeTools = [{
  canonicalName: 'workspace.file.read',
  wireName: 'workspace_file_read',
  description: '按文件 ID 分页读取当前工作区内有权访问的文本文件（含工具结果）。offset 是字符偏移，按 nextOffset 继续；不要反复加载整个文件。',
  parameters: {
    objectId: { type: 'string', format: 'uuid', required: true },
    offset: { type: 'integer', minimum: 0, maximum: 2_000_000 },
    limit: { type: 'integer', minimum: 1, maximum: 4_000 },
  },
}];
