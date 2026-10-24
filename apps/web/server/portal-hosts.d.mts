export interface PortalEntry {
  /** Hostname without brackets, compared with a request's normalized Host. */
  host: string;
  /** host[:port] as a URL authority (an IPv6 address in brackets), for links. */
  authority: string;
}
export function configuredPortalEntries(
  variable: string,
  env?: Record<string, string | undefined>,
): PortalEntry[];
export function checkPortalHostConfiguration(
  env?: Record<string, string | undefined>,
): void;
