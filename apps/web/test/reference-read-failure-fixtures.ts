// Approved v3 scenarios carried through the real R4b structured projection.
export const referenceReadFailureFixtures = [
  {
    scene: 'unsupported',
    tool: 'workspace.reference.read_image',
    code: 'REFERENCE_READ_UNSUPPORTED',
    reason: 'image_route',
    message: '当前模型不支持看图，本次未读取图片内容。',
    expected: '当前模型不支持看图，本次未读取图片内容。',
  },
  {
    scene: 'unknown',
    tool: 'workspace.reference.archive_read',
    code: 'REFERENCE_READ_UNSUPPORTED',
    reason: 'image_route',
    message: '当前模型尚未确认支持看图，本次未读取图片内容。',
    expected: '当前模型尚未确认支持看图，本次未读取图片内容。',
  },
  {
    scene: 'encrypted',
    tool: 'workspace.reference.archive_list',
    code: 'REFERENCE_READ_UNSUPPORTED',
    reason: 'archive_encrypted',
    message: '资料读取失败（archive_encrypted），未读取新内容。',
    expected: '这个 ZIP 已加密，本次未读取目录内容。',
  },
  {
    scene: 'invalid',
    tool: 'workspace.reference.archive_read',
    code: 'REFERENCE_READ_INVALID',
    reason: 'archive_crc',
    message: '资料读取失败（archive_crc），未读取新内容。',
    expected: 'ZIP 中的文件校验未通过，本次未读取文件内容。',
  },
  {
    scene: 'limit',
    tool: 'workspace.reference.read_image',
    code: 'REFERENCE_READ_LIMIT',
    reason: 'image_pixels',
    message: '图片读取失败（image_pixels），未读取图片内容。',
    expected: '图片超过读取限制，本次未读取图片内容。',
  },
  {
    scene: 'timeout',
    tool: 'workspace.reference.archive_read',
    code: 'REFERENCE_READ_TIMEOUT',
    reason: 'operation_budget',
    message: '资料读取失败（operation_budget），未读取新内容。',
    expected: '读取超时，本次未取得文件内容。',
  },
  {
    scene: 'unavailable',
    tool: 'workspace.reference.archive_read',
    code: 'REFERENCE_UNAVAILABLE',
    message: '所选资料尚未就绪、已撤回或访问权限已变化，请重新选择资料。',
    expected: '引用失败，文件可能被调整权限或移除',
  },
] as const;

export function referenceReadErrorFixture(
  scenario: (typeof referenceReadFailureFixtures)[number],
) {
  return {
    code: scenario.code,
    ...('reason' in scenario ? { reason: scenario.reason } : {}),
    message: scenario.message,
    retryable: scenario.code === 'REFERENCE_READ_TIMEOUT',
  };
}
