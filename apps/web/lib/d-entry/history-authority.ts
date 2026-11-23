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
import type { createColdHistorySource } from './history-source';
import { dEntryErrorResponse } from './responses';

type ColdHistorySource = ReturnType<typeof createColdHistorySource>;
type ColdHistoryInput = {
  signal: AbortSignal;
  selection: NonNullable<
    Parameters<typeof createColdHistorySource>[0]['selection']
  >;
};

/** A trusted Host supplies its existing sealed source store through this
 * synchronous constructor. No source discovery, raw-store fallback or new
 * authority is acquired here; the cold loader owns its actual read promises. */
type ProjectionPorts = Partial<
  Pick<DEntryHistoryPorts, 'files' | 'context'>
> & {
  createColdSource?(input: ColdHistoryInput): ColdHistorySource;
};

/** Host-only, per-request composition. History never enters the native/live
 * owner, release admission, root creation, VM, model or credential lifecycle. */
export function createDEntryHistoryRouteHandlers(ports: ProjectionPorts = {}) {
  async function serve(request: Request, method: 'history' | 'download') {
    let subscription: DEntryAuthoritySubscription | undefined;
    let cold: ColdHistorySource | undefined;
    let closing: Promise<void> | undefined;
    let bodyOwnsAuthority = false;
    let signal = request.signal;
    const close = () =>
      (closing ??= (async () => {
        const results = await Promise.allSettled(
          [() => cold?.close(), () => subscription?.close()].map(
            async (release) => release(),
          ),
        );
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, 'History authority close failed');
      })());
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
        const authority = subscription;
        signal = AbortSignal.any([request.signal, authority.revoked]);
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
        if (!ports.createColdSource)
          return apiProblem({
            status: 503,
            code: 'DEPENDENCY_UNAVAILABLE',
            message:
              'MET-273 cold history source/config/checkpoint/storage is not bound',
            retryable: false,
          });
        const projection = ports.createColdSource({
          signal,
          selection: {
            nativeSessionId: input.nativeSessionId,
            ...(input.snapshotDigest
              ? { snapshotDigest: input.snapshotDigest }
              : {}),
          },
        });
        cold = projection;
        signal.throwIfAborted();
        const handlers = createDEntryHistoryHandlers({
          context: async () => context,
          store: projection.store,
          binding: projection.binding,
          files: ports.files,
          closeAuthority: close,
          resources: {
            async resolve(identity, nativeSessionId, active) {
              const current = await readPin(active);
              if (!sameDEntryIdentity(current.identity, identity))
                throw new DataAccessError('authorization_denied');
              const resource = await projection.resolveColdResource(
                context,
                current,
                nativeSessionId,
                active,
              );
              active.throwIfAborted();
              if (
                resource.organizationId !== current.identity.organizationId ||
                resource.personId !== current.identity.personId ||
                resource.employeeInstanceId !==
                  current.identity.employeeInstanceId ||
                resource.threadId !== selection.threadId ||
                resource.nativeSessionId !== nativeSessionId ||
                resource.rootNativeSessionId !== current.rootNativeSessionId ||
                (nativeSessionId === current.rootNativeSessionId &&
                  (resource.parentNativeSessionId !== null ||
                    resource.bindingRef !== current.rootBindingRef))
              )
                throw new DataAccessError('authorization_denied');
              await readPin(active);
              return {
                ...resource,
                revoked: AbortSignal.any([
                  active,
                  authority.revoked,
                  resource.revoked,
                ]),
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
