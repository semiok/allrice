import { UuidSchema, runtimeStaticPreviewPolicy } from '@allrice/contracts';
import { z } from 'zod';
import {
  ArtifactReviewError,
  inspectCompanyDeliverable,
  listCompanyDeliverables,
  readArtifactBytes,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { executionErrorResponse } from '../execution/responses';
import { getStorageAdapter } from '../storage/runtime';
import { readStaticArtifactPreview } from '../runtime/static-artifact-preview';
const headers = {
  ...runtimeStaticPreviewPolicy('application/json').responseHeaders,
  'Cache-Control': 'private, no-store',
};
export async function companyDeliverablesHttp(
  request: Request,
  organizationInput: string,
) {
  try {
    if (request.method !== 'GET')
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: 'GET' },
      });
    const issuer = await requirePlatformAdminContext(request),
      organizationId = UuidSchema.parse(organizationInput),
      p = new URL(request.url).searchParams;
    const artifactId = p.has('artifactId')
      ? UuidSchema.parse(p.get('artifactId'))
      : null;
    if (artifactId) {
      const first = await inspectCompanyDeliverable(
        issuer,
        organizationId,
        artifactId,
      );
      const value =
        p.get('metadata') === '1'
          ? first.companyEvidence
          : p.get('download') === '1'
            ? await readArtifactBytes(
                getStorageAdapter(),
                first.object,
                64_000_000,
              )
            : await readStaticArtifactPreview(first, {
                source: p.get('source') === '1',
                offset: p.has('offset')
                  ? z.coerce
                      .number()
                      .int()
                      .min(1)
                      .max(1_000_000)
                      .parse(p.get('offset'))
                  : undefined,
                signal: request.signal,
              });
      const second = await inspectCompanyDeliverable(
        issuer,
        organizationId,
        artifactId,
      );
      if (
        second.object.id !== first.object.id ||
        second.object.checksum !== first.object.checksum
      )
        throw new ArtifactReviewError('content_changed');
      if (value instanceof Uint8Array)
        return new Response(new Uint8Array(value), {
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(first.version.fileName)}`,
          },
        });
      // NativeDocumentPreview requests subsequent text pages and source views
      // through this same URL and parses the preview directly.
      return Response.json(value, { headers });
    }
    return Response.json(
      await listCompanyDeliverables(issuer, organizationId, {
        range: p.get('range') ?? '7d',
        from: p.get('from') ?? undefined,
        to: p.get('to') ?? undefined,
        timeZone: p.get('timeZone') ?? undefined,
        userId: p.get('userId') ?? undefined,
        employeeId: p.get('employeeId') ?? undefined,
        jobTitle: p.get('jobTitle') ?? undefined,
        format: p.get('format') ?? undefined,
        includeUnavailable: p.get('includeUnavailable') === '1',
        periodOnly: p.get('periodOnly') === '1',
        before: p.get('before') ?? undefined,
        seriesId: p.get('seriesId') ?? undefined,
      }),
      { headers },
    );
  } catch (e) {
    if (e instanceof ArtifactReviewError)
      return Response.json(
        {
          code: e.code,
          error: { message: '文件不存在、权限已改变或内容暂时无法读取。' },
        },
        { status: e.code === 'artifact_not_found' ? 404 : 409, headers },
      );
    return executionErrorResponse(e);
  }
}
