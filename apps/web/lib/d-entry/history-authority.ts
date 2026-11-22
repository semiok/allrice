import { sameDEntryIdentity } from '@allrice/contracts';
import {
  DataAccessError,
  getDEntryHistoryRootPin,
  watchDEntryHistoryAuthority,
  type DEntryAuthoritySubscription,
} from '@allrice/database';
import { apiProblem } from '../api-error-response';
import { requireRequestContext } from '../identity/session';
import {
  createDEntryHistoryHandlers,
  parseDEntryHistoryRequest,
  type DEntryHistoryPorts,
} from './history';
import { DEntryDependencyUnavailable } from './release-policy';
import { dEntryErrorResponse } from './responses';

/** Existing projection ports only, not a proposed 273 carrier. Until that owner
 * supplies its cold source/config/checkpoint/storage, production passes none.
 * Tests may explicitly compose those existing ports with contract substitutes. */
type ProjectionPorts = Partial<
  Pick<DEntryHistoryPorts, 'binding' | 'store' | 'files' | 'context'>
>;

/** Host-only, per-request composition. History never enters the native/live
 * owner, release admission, root creation, VM, model or credential lifecycle. */
export function createDEntryHistoryRouteHandlers(ports: ProjectionPorts = {}) {
  async function serve(request: Request, method: 'history' | 'download') {
    let subscription: DEntryAuthoritySubscription | undefined;
    let closing: Promise<void> | undefined;
    let bodyOwnsAuthority = false;
    let signal = request.signal;
    const close = () =>
      (closing ??= subscription?.close() ?? Promise.resolve());
    try {
      try {
        const input = parseDEntryHistoryRequest(request, method);
        const context = await (ports.context ?? requireRequestContext)(request);
        request.signal.throwIfAborted();
        const selection = {
          workspaceId: input.workspaceId,
          employeeInstanceId: input.employeeInstanceId,
          threadId: input.threadId,
        };
        const pin = await getDEntryHistoryRootPin(context, selection);
        request.signal.throwIfAborted();
        // No root and claim-only are absent history, never creation permission.
        if (!pin) throw new DataAccessError('not_found');
        // Omit feed in production. The formal owner registers LISTEN first,
        // then rechecks current SQL and owns setup-failure cleanup itself.
        subscription = await watchDEntryHistoryAuthority(
          context,
          selection,
          pin.identity,
          request.signal,
        );
        signal = AbortSignal.any([request.signal, subscription.revoked]);
        signal.throwIfAborted();
        const readPin = async (active: AbortSignal) => {
          active.throwIfAborted();
          const current = await getDEntryHistoryRootPin(context, selection);
          active.throwIfAborted();
          if (
            !current ||
            !sameDEntryIdentity(current.identity, pin.identity) ||
            current.rootNativeSessionId !== pin.rootNativeSessionId ||
            current.rootOriginDigest !== pin.rootOriginDigest ||
            current.rootBindingRef !== pin.rootBindingRef ||
            current.vmId !== pin.vmId
          )
            throw new DataAccessError('authorization_denied');
          return current;
        };
        await readPin(signal);
        if (!ports.binding || !ports.store)
          return apiProblem({
            status: 503,
            code: 'DEPENDENCY_UNAVAILABLE',
            message:
              'MET-273 cold history source/config/checkpoint/storage is not bound',
            retryable: false,
          });
        const handlers = createDEntryHistoryHandlers({
          context: async () => context,
          store: ports.store,
          binding: ports.binding,
          files: ports.files,
          closeAuthority: close,
          resources: {
            async resolve(identity, nativeSessionId, active) {
              const current = await readPin(active);
              if (!sameDEntryIdentity(current.identity, identity))
                throw new DataAccessError('authorization_denied');
              // 271 supplies the root only. Without 273's cold ancestry source
              // a browser-selected child cannot become an authorized resource.
              if (nativeSessionId !== current.rootNativeSessionId)
                throw new DEntryDependencyUnavailable('native-route');
              return {
                organizationId: current.identity.organizationId,
                personId: current.identity.personId,
                employeeInstanceId: current.identity.employeeInstanceId,
                threadId: selection.threadId,
                nativeSessionId: current.rootNativeSessionId,
                rootNativeSessionId: current.rootNativeSessionId,
                parentNativeSessionId: null,
                bindingRef: current.rootBindingRef,
                revoked: subscription!.revoked,
              };
            },
          },
        });
        const response = await handlers[method](
          new Request(request, { signal }),
        );
        // prepareHistoryAttachment owns the independent authority close from
        // here through actual body EOF/cancel/error, including an unpulled body.
        bodyOwnsAuthority =
          method === 'download' &&
          response.status === 200 &&
          response.body !== null;
        return response;
      } finally {
        if (!bodyOwnsAuthority) {
          await close();
          signal.throwIfAborted();
        }
      }
    } catch (error) {
      return dEntryErrorResponse(error);
    }
  }
  return {
    history: (request: Request) => serve(request, 'history'),
    download: (request: Request) => serve(request, 'download'),
  };
}
