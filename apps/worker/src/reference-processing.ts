import {
  claimReferenceProcessing,
  finishReferenceProcessing,
  failReferenceProcessing,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { chunkKnowledgeText, readKnowledgeText } from './knowledge.js';

/** Deterministic processing of published fixed files. No employee/model Run. */
export async function processNextReference(storageRoot: string) {
  const claim = await claimReferenceProcessing();
  if (!claim) return false;
  if (
    !['text/plain', 'text/markdown', 'application/json'].includes(
      claim.object.mediaType,
    ) ||
    claim.object.sizeBytes > 2_000_000
  ) {
    await failReferenceProcessing(
      claim,
      '文件已保存，可预览和下载；当前格式或大小暂不支持检索。',
      true,
    );
    return true;
  }
  try {
    const text = await readKnowledgeText(
      new LocalStorageAdapter(storageRoot),
      claim.object,
      true,
    );
    await finishReferenceProcessing(claim, chunkKnowledgeText(text));
  } catch (error) {
    // Never publish filesystem details or arbitrary parser exceptions to tenants.
    const reason =
      error instanceof Error &&
      ['资料没有可检索的文本', '资料已停用', '资料文件校验失败'].includes(
        error.message,
      )
        ? error.message
        : '资料处理失败，请重试；原文件已保留。';
    await failReferenceProcessing(claim, reason);
  }
  return true;
}
