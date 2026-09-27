import { UuidSchema, runtimeStaticPreviewPolicy } from '@allrice/contracts';
import {
  ArtifactReviewError,
  getTenantValidationSummary,
  inspectTenantRun,
  inspectTenantRunArtifacts,
  readArtifactBytes,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { executionErrorResponse } from '../execution/responses';
import { readStaticArtifactPreview } from '../runtime/static-artifact-preview';
import { getStorageAdapter } from '../storage/runtime';
const headers = {
  'Cache-Control': 'private, no-store',
  ...runtimeStaticPreviewPolicy('application/json').responseHeaders,
};
export async function tenantValidationHttp(
  request: Request,
  organizationInput: string,
) {
  try {
    const issuer = await requirePlatformAdminContext(request);
    if (request.method !== 'GET')
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: 'GET' },
      });
    const p = new URL(request.url).searchParams,
      target = {
        organizationId: UuidSchema.parse(organizationInput),
        workspaceId: UuidSchema.parse(p.get('workspaceId')),
        subjectId: UuidSchema.parse(p.get('subjectId')),
      };
    const run = p.get('runId'),
      artifact = p.get('artifactId');
    if (artifact) {
      const runId = UuidSchema.parse(run),
        artifactId = UuidSchema.parse(artifact);
      const first = await inspectTenantRunArtifacts(
        issuer,
        target,
        runId,
        artifactId,
      );
      if (p.get('download') === '1') {
        const artifact = first.artifacts[0]!,
          bytes = await readArtifactBytes(
            getStorageAdapter(),
            artifact.object,
            64_000_000,
          );
        const checked = await inspectTenantRunArtifacts(
          issuer,
          target,
          runId,
          artifactId,
        );
        if (checked.artifacts[0]?.object.checksum !== artifact.object.checksum)
          throw new ArtifactReviewError('content_changed');
        return new Response(new Uint8Array(bytes), {
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.version.fileName)}`,
          },
        });
      }
      const preview = await readStaticArtifactPreview(first.artifacts[0]!);
      const second = await inspectTenantRunArtifacts(
        issuer,
        target,
        runId,
        artifactId,
      );
      if (
        second.artifacts[0]?.object.checksum !==
        first.artifacts[0]!.object.checksum
      )
        throw new ArtifactReviewError('content_changed');
      return Response.json(
        { ...target, inspectorId: issuer.actor.id, runId, artifactId, preview },
        { headers },
      );
    }
    return Response.json(
      run
        ? await inspectTenantRun(issuer, target, run)
        : await getTenantValidationSummary(issuer, target, p.get('deviceId')),
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
