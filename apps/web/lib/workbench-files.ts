import { UuidSchema } from '@allrice/contracts';
import { DataAccessError, WorkbenchFileError } from '@allrice/database';
import { getRequestContext } from './identity/session';
import { sameOriginBrowserWrite } from './identity/request-origin';
import { referenceError, referenceHeaders } from './reference-library';
import { apiProblem } from './api-error-response';
export { referenceHeaders as workbenchFileHeaders };
export async function workbenchFileContext(request: Request, write = false) {
  if (write && !sameOriginBrowserWrite(request))
    throw new DataAccessError('authorization_denied');
  const login = await getRequestContext(request);
  if (!login) throw new DataAccessError('authentication_required');
  const workspaceId = UuidSchema.parse(
    new URL(request.url).searchParams.get('workspaceId') ?? login.workspaceId,
  );
  if (login.workspaceId && login.workspaceId !== workspaceId)
    throw new DataAccessError('authorization_denied');
  return { ...login, workspaceId };
}
export function workbenchFileError(error: unknown) {
  if (error instanceof WorkbenchFileError)
    return apiProblem({
      status: error.code === 'invalid_file' ? 400 : 409,
      code: error.code === 'invalid_file' ? 'VALIDATION_FAILED' : 'CONFLICT',
      message: error.message,
    });
  return referenceError(error);
}
