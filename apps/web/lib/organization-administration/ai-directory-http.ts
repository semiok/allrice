import {
  DataAccessError,
  getOrganizationAiReferenceFile,
  getOrganizationAiSharedDetails,
  listOrganizationAiDirectory,
  listOrganizationPersonAiInstances,
} from '@allrice/database';
import { OrganizationAiDirectoryQuerySchema } from '@allrice/contracts';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { isRequestValidationError } from '../api-error-response';
import { referenceError, referenceHeaders } from '../reference-library';
import { readStaticArtifactPreview } from '../runtime/static-artifact-preview';
import { getStorageAdapter } from '../storage/runtime';

/** All entry points are GET-only. The original administrator identity and the
 * selected organization/person/instance are kept separate by the database. */
export async function organizationAiDirectoryHttp(
  request: Request,
  organizationId: string,
  userId?: string,
  instanceId?: string,
  file?: { revisionId: string; action: 'preview' | 'download' },
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const params = new URL(request.url).searchParams;
    if (file && userId && instanceId) {
      const read = () =>
        getOrganizationAiReferenceFile(
          context,
          organizationId,
          userId,
          instanceId,
          file.revisionId,
        );
      const current = await read();
      if (file.action === 'preview') {
        const preview = await readStaticArtifactPreview(
          {
            object: current.object,
            kind: 'file',
            version: { fileName: current.fileName },
          },
          {
            offset: Number(params.get('offset') ?? 1),
            source: params.get('source') === '1',
            signal: request.signal,
          },
        );
        await read();
        return Response.json(preview, { headers: referenceHeaders });
      }
      const stream = await getStorageAdapter().get(current.object);
      try {
        await read();
      } catch (error) {
        await stream.cancel();
        throw error;
      }
      return new Response(stream, {
        headers: {
          ...referenceHeaders,
          'Content-Type': current.object.mediaType,
          'Content-Length': String(current.object.sizeBytes),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(current.fileName.replace(/[\r\n/\\]/g, '-'))}`,
        },
      });
    }
    const after = params.get('after') ?? undefined;
    const query = OrganizationAiDirectoryQuerySchema.parse({
      after,
      kind: params.get('kind') ?? undefined,
      sourceTemplate: params.get('sourceTemplate') ?? undefined,
      search: params.get('search') ?? undefined,
      departmentId: params.get('departmentId') ?? undefined,
    });
    const result =
      instanceId && userId
        ? await getOrganizationAiSharedDetails(
            context,
            organizationId,
            userId,
            instanceId,
          )
        : userId
          ? await listOrganizationPersonAiInstances(
              context,
              organizationId,
              userId,
              query,
            )
          : await listOrganizationAiDirectory(context, organizationId, query);
    return Response.json(result, { headers: referenceHeaders });
  } catch (error) {
    if (isRequestValidationError(error))
      return Response.json(
        { code: 'INVALID_REQUEST' },
        { status: 400, headers: referenceHeaders },
      );
    if (error instanceof DataAccessError)
      return Response.json(
        {
          code:
            error.code === 'not_found' ? 'NOT_FOUND' : 'AUTHORIZATION_DENIED',
        },
        {
          status:
            error.code === 'not_found'
              ? 404
              : error.code === 'authentication_required'
                ? 401
                : 403,
          headers: referenceHeaders,
        },
      );
    return referenceError(error);
  }
}
