export interface PortalEntry {
  /** Canonical hostname (IPv6 without brackets), compared with a request's. */
  host: string;
  /** host[:port] as a URL authority (an IPv6 address in brackets), for links. */
  authority: string;
}
export const builtInEmployeeHosts: readonly string[];
export const builtInAdminHosts: readonly string[];
export const loopbackHosts: readonly string[];
export function canonicalHost(host: string): string;
export function configuredPortalEntries(
  variable: string,
  env?: Record<string, string | undefined>,
): PortalEntry[];
export function portalEntries(env?: Record<string, string | undefined>): {
  employee: PortalEntry[];
  admin: PortalEntry[];
};
