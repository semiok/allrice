import { officeMediaTypes } from '@allrice/contracts';
import { createHash } from 'node:crypto';
import {
  OfficeRenderResponseSchema,
  type OfficeFormat,
  type OfficeRenderResponse,
  type OfficePreview,
} from '@allrice/contracts';

export { officeMediaTypes } from '@allrice/contracts';
export function officeFormat(mediaType: string): OfficeFormat | undefined {
  return (Object.keys(officeMediaTypes) as OfficeFormat[]).find(
    (f) => officeMediaTypes[f] === mediaType,
  );
}

export class OfficeRenderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function officeRenderNotice(error: unknown) {
  const code = error instanceof OfficeRenderError ? error.code : '';
  if (code === 'unsupported_formula_range')
    return '此文件包含数组公式，暂未重算及预览。请下载后用 Excel 或 LibreOffice 检查。';
  if (code === 'external_content' || code === 'active_content')
    return '此文件含外部数据或活动内容，暂未重算及预览。请下载后在可信环境检查。';
  return '文档预览与公式检查暂不可用，文件仍可下载；不能据此认定排版或公式已通过检查。';
}

/** Only deployment configuration controls the destination. Document text and
 * model arguments can never supply a URL. No redirects, credentials or scripts. */
export async function renderOffice(
  bytes: Buffer,
  format: OfficeFormat,
): Promise<OfficeRenderResponse> {
  if (bytes.length > 8_000_000) throw new OfficeRenderError('file_too_large');
  const base = new URL(
    process.env.ALLRICE_OFFICE_RENDERER_URL || 'http://127.0.0.1:3112',
  );
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new OfficeRenderError('invalid_renderer_url');
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const response = await fetch(new URL('/render', base), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      checksum,
      format,
      base64: bytes.toString('base64'),
    }),
  });
  if (!response.body) throw new OfficeRenderError('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > (response.ok ? 8_000_000 : 1024)) {
        await reader.cancel();
        throw new OfficeRenderError('response_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!response.ok) {
    const code =
      value && typeof value === 'object' && 'code' in value ? value.code : '';
    throw new OfficeRenderError(
      typeof code === 'string' ? code : 'conversion_failed',
    );
  }
  const result = OfficeRenderResponseSchema.parse(value);
  if (result.checksum !== checksum || result.format !== format)
    throw new OfficeRenderError('content_changed');
  for (const page of result.pages) {
    const png = Buffer.from(page.base64, 'base64');
    if (
      png.length < 33 ||
      !png
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString('ascii', 12, 16) !== 'IHDR' ||
      png.readUInt32BE(16) > 1200 ||
      png.readUInt32BE(20) > 1200 ||
      !png.readUInt32BE(16) ||
      !png.readUInt32BE(20)
    )
      throw new OfficeRenderError('invalid_preview_image');
  }
  return result;
}

export function officePreview(result: OfficeRenderResponse): OfficePreview {
  return {
    kind: 'office',
    checksum: result.checksum,
    format: result.format,
    pageCount: result.pageCount,
    pages: result.pages,
    formulaCount: result.formulas.length,
    formulaErrorCount: result.formulas.filter((f) => f.type === 'e').length,
    // Show errors first without silently discarding the total/error count.
    formulas: [
      ...result.formulas.filter((f) => f.type === 'e'),
      ...result.formulas.filter((f) => f.type !== 'e'),
    ].slice(0, 50),
  };
}
