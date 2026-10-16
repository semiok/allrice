import {
  createExperienceStore,
  experienceReviewEnabled,
  ExperienceError,
  listExperienceDrafts,
  getExperienceOverview,
  DataAccessError,
  EmployeeInstanceError,
  getExperienceProvenance,
  PersonalSkillError,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { isRequestValidationError } from '../api-error-response';
import { getRequestContext } from '../identity/session';
import { sameOriginBrowserWrite } from '../identity/request-origin';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function experienceHttp(
  request: Request,
  action: 'list' | 'sources' | 'create' | 'review' | 'provenance',
  id?: string,
) {
  if (!experienceReviewEnabled())
    return new Response(null, { status: 404, headers });
  try {
    if (
      ['create', 'review'].includes(action) &&
      !sameOriginBrowserWrite(request)
    )
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    const login = await getRequestContext(request);
    if (!login) return new Response(null, { status: 401, headers });
    const url = new URL(request.url);
    const workspaceId = UuidSchema.parse(
      url.searchParams.get('workspaceId') ?? login.workspaceId,
    );
    const context = { ...login, workspaceId };
    if (action === 'provenance') {
      const value = await getExperienceProvenance(context, {
        memoryId: UuidSchema.parse(id),
        instanceId: UuidSchema.parse(url.searchParams.get('instanceId')),
        revision: Number(url.searchParams.get('revision')),
      });
      return Response.json(value, { headers });
    }
    if (action === 'create' || action === 'review') {
      if (id) UuidSchema.parse(id);
      return Response.json(
        { code: 'LEGACY_EXPERIENCE_WRITE_RETIRED' },
        { status: 410, headers },
      );
    }
    const store = createExperienceStore();
    if (action === 'list') {
      const instanceId = url.searchParams.get('instanceId') ?? undefined;
      const overview = instanceId
        ? await getExperienceOverview(context, instanceId)
        : null;
      return Response.json(
        {
          overview,
          candidates: await store.list(context, instanceId),
          draftBatches: await listExperienceDrafts(context, instanceId),
        },
        { headers },
      );
    }
    return Response.json(
      {
        sources: await store.sources(
          context,
          UuidSchema.parse(url.searchParams.get('sessionId')),
        ),
      },
      { headers },
    );
  } catch (error) {
    const code =
      error instanceof PersonalSkillError
        ? 'source_changed'
        : error instanceof ExperienceError ||
            error instanceof DataAccessError ||
            error instanceof EmployeeInstanceError
          ? error.code
          : isRequestValidationError(error)
            ? 'invalid_request'
            : 'unavailable';
    const status =
      code === 'authentication_required'
        ? 401
        : code === 'not_found' || code === 'disabled'
          ? 404
          : code === 'conflict' || code === 'source_changed'
            ? 409
            : code === 'identity_denied' ||
                code === 'authorization_denied' ||
                code === 'validation_required' ||
                code === 'platform_publication_required'
              ? 403
              : code === 'invalid_request' || code === 'invalid_source'
                ? 400
                : 503;
    return Response.json({ code }, { status, headers });
  }
}
