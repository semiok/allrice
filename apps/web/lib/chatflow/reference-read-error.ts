import {
  isBoundedReferenceToolName,
  ReferenceImageFailureSchema,
  type ChatFlowEventEnvelope,
} from '@allrice/contracts';

/** Display a confirmed native read failure. Neither history nor this projection
 * authorizes another read, removes a citation, or changes composer state. */
export function referenceReadFailureMessage(event: ChatFlowEventEnvelope) {
  if (
    event.type !== 'tool.failed' ||
    !isBoundedReferenceToolName(event.payload.name)
  )
    return undefined;
  const native = event.sourceEvent?.payload ?? event.payload.nativePayload;
  if (!native || typeof native !== 'object') return undefined;
  const parsed = ReferenceImageFailureSchema.safeParse(
    (native as Record<string, unknown>).referenceReadError,
  );
  if (!parsed.success) return undefined;
  const failure = parsed.data;
  if (failure.code === 'REFERENCE_UNAVAILABLE')
    return '引用失败，文件可能被调整权限或移除';
  if (!('reason' in failure)) return undefined;
  // Only these approved reason/code pairs share the preview copy. Other
  // reasons retain their real business message; never infer from prose.
  switch (`${failure.code}/${failure.reason}`) {
    case 'REFERENCE_READ_UNSUPPORTED/archive_encrypted':
      return '这个 ZIP 已加密，本次未读取目录内容。';
    case 'REFERENCE_READ_INVALID/archive_crc':
      return 'ZIP 中的文件校验未通过，本次未读取文件内容。';
    case 'REFERENCE_READ_LIMIT/image_pixels':
      return '图片超过读取限制，本次未读取图片内容。';
    case 'REFERENCE_READ_TIMEOUT/operation_budget':
      return '读取超时，本次未取得文件内容。';
    default:
      // In particular image_route distinguishes unsupported and unknown in
      // the Broker's message, not in a guessed Web capability check.
      return failure.message;
  }
}
