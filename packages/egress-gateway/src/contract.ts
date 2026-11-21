import type { RequestContext } from '@allrice/contracts';
import type {
  PersonVmBinding,
  PersonVmAdmissionBindingPort,
  PersonVmAdmissionBoundary,
} from '@allrice/person-vm';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class EgressError extends Error {
  constructor(
    readonly code:
      | 'EXECUTION_REBIND_REQUIRED'
      | 'DENIED'
      | 'STALE_BINDING'
      | 'UNAVAILABLE'
      | 'INVALID_RESPONSE'
      | 'LIMIT_EXCEEDED'
      | 'POLICY_INVALID',
  ) {
    super(code);
    this.name = 'EgressError';
  }
}

export type EgressResponse = Readonly<{
  status: number;
  contentType: string;
  body: Uint8Array;
}>;
export type EgressRequest = Readonly<{
  method: string;
  path: string;
  body: Uint8Array;
}>;
export type EgressReadRoute = Readonly<{
  id: string;
  /** Exact local path. No arbitrary URL or CONNECT tunnel is exposed. */
  path: string;
  /** Registered protocol adapter, e.g. npm package paths. Not a guest regex. */
  matches?(path: string): boolean;
  /** Host-owned parser reconstructs a fixed semantic upstream target. */
  target(query: URLSearchParams, path: string): URL;
  /** Host-configured origins, not supplied by guest or upstream metadata. */
  origins: readonly string[];
  maxResponseBytes: number;
  timeoutMs: number;
  /** Must reject responses outside the registered business result schema. */
  validate(response: EgressResponse): void;
  transform?(
    response: EgressResponse,
    path: string,
    gatewayOrigin: string,
  ): EgressResponse;
}>;
export interface EgressTransport {
  /** Settles only after the owned response/request transport has closed, including cancellation. */
  read(
    url: URL,
    options: { maxBytes: number; signal: AbortSignal },
  ): Promise<EgressResponse>;
}
export interface EgressAuthority {
  /** Trusted identity service, never parse a guest RequestContext. */
  context(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<RequestContext>;
  /** Current enterprise/employee/business permission, checked on each request. */
  allow(
    context: RequestContext,
    binding: PersonVmBinding,
    routeId: string,
    signal: AbortSignal,
  ): Promise<void>;
}
export type EgressDependencies = {
  vm: PersonVmAdmissionBindingPort;
  /** Same shared PG host as vm; read operations own exactly one permit. */
  admission: PersonVmAdmissionBoundary;
  authority: EgressAuthority;
  transport: EgressTransport;
  /** Actual ModelGatewayPort.revoke adapter; must abort AND await drain. */
  revokeModel(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
};

/** All values come from host configuration. No new defaults or limits here. */
export type EgressPolicy = Readonly<{ routes: readonly EgressReadRoute[] }>;
export type ManagedHostService = Readonly<{
  id: string;
  path: string;
  method: 'GET' | 'POST';
  /** Service owns admission AND complete call identity; local capability is insufficient. */
  admissionOwner: 'service';
  /** Owner parses native protocol and resolves call/resource authority; no raw proxy. */
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    trusted: { context: RequestContext; binding: PersonVmBinding },
    signal: AbortSignal,
  ): Promise<void>;
}>;

/** Upstream credentials are NEVER returned. This is a VM-specific local capability. */
export type GuestEgressAccess = Readonly<{
  origin: string;
  capability: string;
}>;
export interface EgressProvisioner {
  /** Durable allocation owned by host: stable for vmId, including across restart. */
  endpoint(
    vmId: string,
    signal: AbortSignal,
  ): Promise<{ host: string; port: number; guestOrigin: string }>;
  /** Trusted disk/config writer installs only into this exact VM/epoch, before boot. */
  install(
    binding: PersonVmBinding,
    access: GuestEgressAccess,
    signal: AbortSignal,
  ): Promise<void>;
  /** Remove only this epoch's access; never remove a newer epoch. */
  remove(binding: PersonVmBinding, signal: AbortSignal): Promise<void>;
}
