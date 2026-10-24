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

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// A DNS name or a bracketed IPv6 address, then an optional port.
const entryPattern = new RegExp(
  `^(?:(${label}(?:\\.${label})*)|(\\[[0-9a-f:.]+\\]))(?::([0-9]{1,5}))?$`,
);

const parsedHost = (host) => {
  try {
    const url = new URL(`http://${host}`);
    if (
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    // Not a host.
  }
  return null;
};

/** A hostname as the portal compares it: URL's canonical form (lowercase,
 * compressed IPv6 without brackets, plain IPv4), so equal hosts compare equal.
 * Anything that is not a bare host is returned unchanged and matches no entry. */
export const canonicalHost = (host) => parsedHost(host) ?? host;

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
      const host = match ? parsedHost(match[1] ?? match[2]) : null;
      const port = match?.[3] === undefined ? null : Number(match[3]);
      if (!host || (port !== null && (port < 1 || port > 65535)))
        throw Error(
          `${variable}: "${entry}" is not a host name with an optional port`,
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
