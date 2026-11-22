import {
  DEntrySelectionInputSchema,
  sameDEntryIdentity,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import {
  createDeliverablesPort,
  createEnterpriseMaterialsPort,
  DataAccessError,
  ReferenceLibraryError,
  requireEmployeePanelsAccess,
} from '@allrice/database';
import { getRequestContext } from '../identity/session';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { getStorageAdapter } from '../storage/runtime';

export interface EmployeePanelsDependencies {
  context(request: Request): Promise<RequestContext | null>;
  authorize: typeof requireEmployeePanelsAccess;
  storage(): StoragePort;
}
export const employeePanelsDependencies: EmployeePanelsDependencies = {
  context: getRequestContext,
  authorize: requireEmployeePanelsAccess,
  storage: getStorageAdapter,
};

/** Each call resolves the original Cookie again. Expected viewer is a stale
 * view precondition, never authority; the path employee is a target selector. */
export async function requireEmployeePanelsContext(
  request: Request,
  panelEmployeeInstanceId: string,
  write: boolean,
  dependencies = employeePanelsDependencies,
) {
  if (write && !sameOriginBrowserWrite(request))
    throw new DataAccessError('authorization_denied');
  const context = await dependencies.context(request);
  if (!context) throw new DataAccessError('authentication_required');
  const params = new URL(request.url).searchParams;
  const selection = DEntrySelectionInputSchema.parse({
    workspaceId: params.get('workspaceId') ?? context.workspaceId,
    employeeInstanceId: panelEmployeeInstanceId,
    ...(params.has('threadId') ? { threadId: params.get('threadId') } : {}),
  });
  const identity = await dependencies.authorize(context, selection);
  const expected = request.headers.get('x-allrice-expected-viewer-id');
  if (expected !== null && expected !== context.actor.id)
    throw new ReferenceLibraryError('request_conflict');
  async function current(candidate: RequestContext, signal: AbortSignal) {
    signal.throwIfAborted();
    const fresh = await dependencies.context(request);
    if (
      !fresh ||
      fresh.sessionId !== context!.sessionId ||
      fresh.actor.id !== context!.actor.id ||
      fresh.organizationId !== context!.organizationId ||
      fresh.workspaceId !== context!.workspaceId ||
      candidate.sessionId !== context!.sessionId ||
      candidate.actor.id !== context!.actor.id ||
      candidate.organizationId !== context!.organizationId ||
      candidate.workspaceId !== selection.workspaceId
    )
      throw new DataAccessError('authorization_denied');
    if (
      !sameDEntryIdentity(
        identity,
        await dependencies.authorize(fresh, selection),
      )
    )
      throw new DataAccessError('authorization_denied');
    signal.throwIfAborted();
  }
  await current(context, request.signal);
  // Metadata-only management does not depend on opening the byte backend.
  // Each I/O still delegates to the real configured storage producer.
  const storage: StoragePort = {
    get: (object) => dependencies.storage().get(object),
    put: (object, content) => dependencies.storage().put(object, content),
    delete: (object) => dependencies.storage().delete(object),
    exists: (object) => dependencies.storage().exists(object),
  };
  return {
    context,
    selection,
    current: () => current(context, request.signal),
    materials: createEnterpriseMaterialsPort({
      storage,
      requireCurrentAccess: current,
    }),
    deliverables: createDeliverablesPort({
      storage,
      requireCurrentAccess: current,
    }),
  };
}
