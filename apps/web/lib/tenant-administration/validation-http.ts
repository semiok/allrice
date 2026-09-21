import { UuidSchema, runtimeStaticPreviewPolicy } from '@allrice/contracts';
import {
  ArtifactReviewError,
  getTenantValidationSummary,
  inspectTenantRun,
  inspectTenantRunArtifacts,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { executionErrorResponse } from '../execution/responses';
import { readStaticArtifactPreview } from '../runtime/static-artifact-preview';
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
          error: { message: '工件不存在、权限已改变或内容无法安全预览。' },
        },
        { status: e.code === 'artifact_not_found' ? 404 : 409, headers },
      );
    return executionErrorResponse(e);
  }
}
