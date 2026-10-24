import process from 'node:process';
import { URL } from 'node:url';

/** Built-in entries of the shared deployment. */
export const builtInEmployeeHosts = ['allrice.bplabs.xyz'];
export const builtInAdminHosts = [
  'allrice-admin.bplabs.xyz',
  'allrice-admin.traditionow.ai',
  'allrice-dsh.bplabs.xyz',
  'allrice-dsh.traditionow.ai',
];

/** Loopback hosts; ALLRICE_LOCAL_PORTAL decides what they serve. */
export const loopbackHosts = ['localhost', '127.0.0.1', '::1'];

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const namePattern = new RegExp(`^${label}(?:\\.${label})*$`);
const ipv6Pattern = /^\[[0-9a-f:.]+\]$/;
// A DNS name or a bracketed IPv6 address, then an optional port.
const entryPattern = new RegExp(
  `^(${label}(?:\\.${label})*|\\[[0-9a-f:.]+\\])(?::([0-9]{1,5}))?$`,
);

/** The canonical hostname, or null when `host` is not one: a lowercase DNS name
 * already in canonical form (plain IPv4 included), or an IPv6 address in brackets,
 * returned compressed and without them. */
const parsedHost = (host) => {
  const ipv6 = ipv6Pattern.test(host);
  if (!ipv6 && !namePattern.test(host)) return null;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return ipv6 ? hostname.slice(1, -1) : hostname === host ? host : null;
  } catch {
    return null;
  }
};

/** A hostname as the portal compares it: IPv6 compressed without brackets, so
 * equivalent spellings compare equal; '' (matching no entry) for anything that is
 * not strictly a host: whitespace, userinfo, paths, other IPv4 spellings. */
export const canonicalHost = (host) => parsedHost(host) ?? '';

/** Portal entries a deployment adds for its own domain: comma separated
 * `host[:port]` (a DNS name, or an IPv6 address bare or in brackets). `host` is
 * compared with a request's canonical host; `authority` builds links to the entry. */
export function configuredPortalEntries(variable, env = process.env) {
  return (env[variable] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const bareIpv6 =
        !entry.startsWith('[') && entry.indexOf(':') !== entry.lastIndexOf(':');
      const match = entryPattern.exec(bareIpv6 ? `[${entry}]` : entry);
      const host = match ? parsedHost(match[1]) : null;
      const port = match?.[2] === undefined ? null : Number(match[2]);
      if (!host || (port !== null && (port < 1 || port > 65535)))
        throw Error(
          `${variable}: "${entry}" is not a host name with an optional port`,
        );
      if (loopbackHosts.includes(host))
        throw Error(
          `${variable}: "${entry}" is a loopback host; ALLRICE_LOCAL_PORTAL decides what it serves`,
        );
      return {
        host,
        authority: `${host.includes(':') ? `[${host}]` : host}${port && port !== 443 ? `:${port}` : ''}`,
      };
    });
}

/** Both lists, checked: every entry parses, and no host is both an employee and
 * an admin entry, built-in ones included (the employee entry would win and the
 * admin one would never open). The portal reads them through this on every
 * request, so a bad list never serves; the server also checks it at startup. */
export function portalEntries(env = process.env) {
  const employee = configuredPortalEntries(
    'ALLRICE_EMPLOYEE_PORTAL_HOSTS',
    env,
  );
  const admin = configuredPortalEntries('ALLRICE_ADMIN_PORTAL_HOSTS', env);
  const employeeHosts = [
    ...builtInEmployeeHosts,
    ...employee.map((entry) => entry.host),
  ];
  const both = [
    ...new Set([...builtInAdminHosts, ...admin.map((entry) => entry.host)]),
  ].filter((host) => employeeHosts.includes(host));
  if (both.length)
    throw Error(
      `portal hosts listed as both employee and admin entries: ${both.join(', ')}`,
    );
  return { employee, admin };
}
