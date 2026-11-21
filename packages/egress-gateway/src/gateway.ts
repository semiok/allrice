import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type {
  PersonVmBinding,
  PersonVmEgressPort,
  PersonVmEgressReceipt,
} from '@allrice/person-vm';
import {
  EgressError,
  type EgressDependencies,
  type EgressPolicy,
  type EgressProvisioner,
  type EgressRequest,
  type EgressResponse,
  type ManagedHostService,
} from './contract.js';

function exact(a: PersonVmBinding, b: PersonVmBinding) {
  return (
    a.vmId === b.vmId &&
    a.personId === b.personId &&
    a.organizationId === b.organizationId &&
    a.instanceId === b.instanceId &&
    a.leaseEpoch === b.leaseEpoch
  );
}
type BindingState = {
  receipt: PersonVmEgressReceipt;
  capability: string;
  controller: AbortController;
  server: Server;
  inflight: Set<Promise<unknown>>;
  active: boolean;
  origin: string;
};
function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')
        ? reject(error)
        : resolve(),
    );
    server.closeAllConnections();
  });
}
function denied() {
  return new EgressError('DENIED');
}

/** Host factory. No default authority, fixture implementation or platform credentials. */
export function createEgressGateway(
  options: EgressDependencies & {
    policy: EgressPolicy;
    provisioner: EgressProvisioner;
    services?: readonly ManagedHostService[];
  },
) {
  const states = new Map<string, BindingState>();
  const lanes = new Map<string, Promise<unknown>>();
  const routes = new Map(
    options.policy.routes.map((route) => [route.path, route]),
  );
  const services = options.services ?? [];
  if (
    new Set(services.map((service) => service.path)).size !== services.length ||
    services.some(
      (service) =>
        !service.id ||
        !service.path.startsWith('/') ||
        /[?#\\]/.test(service.path) ||
        !['GET', 'POST'].includes(service.method) ||
        [...routes.values()].some(
          (route) =>
            route.path === service.path || route.matches?.(service.path),
        ),
    )
  )
    throw new EgressError('POLICY_INVALID');
  if (
    routes.size !== options.policy.routes.length ||
    [...routes.values()].some(
      (route) =>
        !route.path.startsWith('/') ||
        route.path.includes('?') ||
        route.path.includes('#') ||
        !route.id ||
        !Number.isSafeInteger(route.maxResponseBytes) ||
        route.maxResponseBytes <= 0 ||
        !Number.isSafeInteger(route.timeoutMs) ||
        route.timeoutMs <= 0 ||
        !route.origins.length ||
        route.origins.some((origin) => {
          try {
            const u = new URL(origin);
            return (
              u.origin !== origin ||
              u.protocol !== 'https:' ||
              !!u.username ||
              !!u.password ||
              !!u.port
            );
          } catch {
            return true;
          }
        }),
    )
  )
    throw new EgressError('POLICY_INVALID');

  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (lanes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    lanes.set(id, next);
    void next
      .finally(() => {
        if (lanes.get(id) === next) lanes.delete(id);
      })
      .catch(() => {});
    return next;
  }
  function stateFor(receipt: PersonVmEgressReceipt) {
    const state = states.get(receipt.binding.vmId);
    if (
      !state?.active ||
      state.controller.signal.aborted ||
      state.receipt.bindingId !== receipt.bindingId ||
      !exact(state.receipt.binding, receipt.binding) ||
      state.receipt.gatewayPorts.length !== receipt.gatewayPorts.length ||
      state.receipt.gatewayPorts.some(
        (port, i) => port !== receipt.gatewayPorts[i],
      )
    )
      throw new EgressError('STALE_BINDING');
    return state;
  }
  async function read(
    state: BindingState,
    request: EgressRequest,
    signal: AbortSignal,
  ): Promise<EgressResponse> {
    stateFor(state.receipt);
    signal.throwIfAborted();
    if (
      request.method !== 'GET' ||
      request.body.byteLength ||
      !request.path.startsWith('/') ||
      request.path.startsWith('//') ||
      request.path.includes('#') ||
      request.path.includes('\\')
    )
      throw denied();
    const url = new URL(request.path, 'http://egress.invalid');
    const matching = [...routes.values()].filter(
      (route) => route.path === url.pathname || route.matches?.(url.pathname),
    );
    const route = matching[0];
    if (
      !route ||
      matching.length !== 1 ||
      url.origin !== 'http://egress.invalid'
    )
      throw denied();
    const timeout = AbortSignal.timeout(route.timeoutMs);
    const activeSignal = AbortSignal.any([
      signal,
      state.controller.signal,
      timeout,
    ]);
    const binding = state.receipt.binding;
    const context = await options.authority.context(binding, activeSignal);
    await options.vm.assertCurrentBinding(context, binding, activeSignal);
    await options.authority.allow(context, binding, route.id, activeSignal);
    const target = route.target(url.searchParams, url.pathname);
    if (
      !route.origins.includes(target.origin) ||
      target.username ||
      target.password ||
      target.hash ||
      target.protocol !== 'https:'
    )
      throw denied();
    stateFor(state.receipt);
    activeSignal.throwIfAborted();
    const response = await options.transport.read(target, {
      maxBytes: route.maxResponseBytes,
      signal: activeSignal,
    });
    if (response.body.byteLength > route.maxResponseBytes)
      throw new EgressError('LIMIT_EXCEEDED');
    route.validate(response);
    // Buffered reads never return new bytes after current permission was revoked.
    await options.vm.assertCurrentBinding(context, binding, activeSignal);
    await options.authority.allow(context, binding, route.id, activeSignal);
    stateFor(state.receipt);
    activeSignal.throwIfAborted();
    const result =
      route.transform?.(response, url.pathname, state.origin) ?? response;
    if (result.body.byteLength > route.maxResponseBytes)
      throw new EgressError('LIMIT_EXCEEDED');
    return result;
  }
  async function retire(state: BindingState, signal: AbortSignal) {
    state.active = false;
    state.controller.abort(new EgressError('STALE_BINDING'));
    // Do not let one cleanup failure skip the model drain or transport shutdown.
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() =>
        options.revokeModel(state.receipt.binding, signal),
      ),
      Promise.resolve().then(() =>
        options.provisioner.remove(state.receipt.binding, signal),
      ),
      Promise.resolve().then(() => close(state.server)),
      Promise.allSettled([...state.inflight]),
    ]);
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'EGRESS_CLEANUP_INCOMPLETE',
      );
  }
  const port: PersonVmEgressPort = {
    prepare(bindingInput, signal) {
      const binding = Object.freeze({ ...bindingInput });
      return serial(binding.vmId, async () => {
        signal.throwIfAborted();
        const previous = states.get(binding.vmId);
        if (previous) {
          if (exact(previous.receipt.binding, binding) && previous.active)
            return previous.receipt;
          if (binding.leaseEpoch <= previous.receipt.binding.leaseEpoch)
            throw new EgressError('STALE_BINDING');
          await retire(previous, signal);
        }
        const endpoint = await options.provisioner.endpoint(
          binding.vmId,
          signal,
        );
        const origin = new URL(endpoint.guestOrigin);
        if (
          !Number.isInteger(endpoint.port) ||
          endpoint.port < 1 ||
          endpoint.port > 65535 ||
          origin.origin !== endpoint.guestOrigin ||
          origin.protocol !== 'http:' ||
          origin.username ||
          origin.password ||
          Number(origin.port || 80) !== endpoint.port ||
          (previous && previous.receipt.gatewayPorts[0] !== endpoint.port)
        )
          throw new EgressError('POLICY_INVALID');
        const receipt = Object.freeze({
          binding,
          bindingId: randomUUID(),
          gatewayPorts: Object.freeze([endpoint.port]),
        });
        const state: BindingState = {
          receipt,
          capability: randomBytes(32).toString('base64url'),
          controller: new AbortController(),
          inflight: new Set(),
          active: false,
          server: createServer(),
          origin: endpoint.guestOrigin,
        };
        // Epoch tombstone retained even on preparation failure; delayed prepare cannot revive it.
        states.set(binding.vmId, state);
        state.server.on('request', (req, res) => {
          const operation = (async () => {
            const disconnect = new AbortController();
            res.once('close', () => disconnect.abort());
            try {
              const rawAuth = req.headers.authorization ?? '';
              // pip's netrc uses HTTP Basic; the password is only this VM-local capability.
              const auth = Buffer.from(
                rawAuth.startsWith('Basic ') &&
                  Buffer.from(rawAuth.slice(6), 'base64')
                    .toString()
                    .startsWith('egress:')
                  ? 'Bearer ' +
                      Buffer.from(rawAuth.slice(6), 'base64')
                        .toString()
                        .slice(7)
                  : rawAuth,
              );
              const expected = Buffer.from('Bearer ' + state.capability);
              if (
                !state.active ||
                auth.length !== expected.length ||
                !timingSafeEqual(auth, expected) ||
                req.headers.host !== origin.host
              )
                throw denied();
              const service = services.find(
                (item) => req.url === item.path && req.method === item.method,
              );
              if (service) {
                const serviceSignal = AbortSignal.any([
                  disconnect.signal,
                  state.controller.signal,
                ]);
                const context = await options.authority.context(
                  binding,
                  serviceSignal,
                );
                await options.vm.assertCurrentBinding(
                  context,
                  binding,
                  serviceSignal,
                );
                await options.authority.allow(
                  context,
                  binding,
                  service.id,
                  serviceSignal,
                );
                stateFor(receipt);
                serviceSignal.throwIfAborted();
                delete req.headers.authorization;
                await service.handle(
                  req,
                  res,
                  { context, binding },
                  serviceSignal,
                );
                return;
              }
              if (
                req.headers['transfer-encoding'] ||
                (req.headers['content-length'] &&
                  req.headers['content-length'] !== '0')
              )
                throw denied();
              // GET bodies without framing cannot be smuggled through the strict Node parser.
              const response = await read(
                state,
                {
                  method: req.method ?? '',
                  path: req.url ?? '',
                  body: new Uint8Array(),
                },
                disconnect.signal,
              );
              res.writeHead(response.status, {
                'content-type': response.contentType,
                'content-length': response.body.byteLength,
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              });
              res.end(response.body);
            } catch (error) {
              if (res.headersSent) {
                // A failed native stream cannot become a second JSON response.
                res.destroy();
                return;
              }
              if (!res.destroyed) {
                res.writeHead(
                  error instanceof EgressError &&
                    ['DENIED', 'STALE_BINDING'].includes(error.code)
                    ? 403
                    : 502,
                  {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                  },
                );
                res.end(
                  JSON.stringify({
                    code:
                      error instanceof EgressError ? error.code : 'UNAVAILABLE',
                  }),
                );
              }
            }
          })();
          state.inflight.add(operation);
          void operation
            .finally(() => state.inflight.delete(operation))
            .catch(() => {});
        });
        state.server.on('connect', (_req, socket) => socket.destroy());
        state.server.on('upgrade', (_req, socket) => socket.destroy());
        try {
          await new Promise<void>((resolve, reject) => {
            state.server.once('error', reject);
            state.server.listen(endpoint.port, endpoint.host, () => {
              state.server.off('error', reject);
              resolve();
            });
          });
          await options.provisioner.install(
            binding,
            { origin: endpoint.guestOrigin, capability: state.capability },
            signal,
          );
          signal.throwIfAborted();
          state.active = true;
          return receipt;
        } catch (error) {
          try {
            await retire(state, signal);
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'EGRESS_PREPARE_FAILED');
          }
          throw error;
        }
      });
    },
    async assertActive(receipt, signal) {
      signal.throwIfAborted();
      stateFor(receipt);
    },
    revoke(receipt, _reason, signal) {
      return serial(receipt.binding.vmId, async () => {
        const state = states.get(receipt.binding.vmId);
        if (
          !state ||
          state.receipt.bindingId !== receipt.bindingId ||
          !exact(state.receipt.binding, receipt.binding)
        )
          return;
        await retire(state, signal);
      });
    },
  };
  return port;
}
