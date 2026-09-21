import {
  runtimeStaticPreviewPolicy,
  type WorkbenchArtifact,
} from '@allrice/contracts';
import { parseChangesetBytes, readArtifactBytes } from '@allrice/database';
import { getStorageAdapter } from '../storage/runtime';
import { boundedRaster } from './raster-preview';

/** Only renders verified stored bytes. Caller must authorize before AND after
 * storage IO. Never executes HTML/SVG or remote content in the main document. */
export async function readStaticArtifactPreview(artifact: WorkbenchArtifact) {
  const policy = runtimeStaticPreviewPolicy(artifact.object.mediaType);
  if (
    artifact.object.sizeBytes > 512_000 ||
    (![
      'text/plain',
      'text/markdown',
      'text/html',
      'application/json',
      'image/svg+xml',
    ].includes(artifact.object.mediaType) &&
      policy.mode !== 'authenticated_raster')
  )
    return {
      kind: 'download_only',
      reason: '此格式或文件大小仅支持下载，不在主站执行。',
    };
  const bytes = await readArtifactBytes(getStorageAdapter(), artifact.object);
  if (artifact.kind === 'changeset')
    return { kind: 'changeset', changeset: parseChangesetBytes(bytes) };
  if (policy.mode === 'authenticated_raster')
    return boundedRaster(bytes, artifact.object.mediaType)
      ? {
          kind: 'image',
          mediaType: artifact.object.mediaType,
          base64: bytes.toString('base64'),
        }
      : {
          kind: 'download_only',
          reason: '图片格式、动画或像素尺寸不符合静态预览限制，请下载查看。',
        };
  try {
    return {
      kind: 'text',
      text: new TextDecoder('utf8', { fatal: true }).decode(bytes),
      mediaType: artifact.object.mediaType,
    };
  } catch {
    return { kind: 'download_only', reason: '非 UTF-8 文本，请下载查看。' };
  }
}
