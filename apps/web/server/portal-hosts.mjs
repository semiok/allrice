import process from 'node:process';
import { URL } from 'node:url';

/** Portal entries a deployment adds for its own domain: comma separated hosts, each
 * with an optional port (an IPv6 address bare or in brackets). `host` is compared
 * with a request's normalized Host; `authority` builds links to the entry. */
export function configuredPortalEntries(variable, env = process.env) {
  return (env[variable] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const bareIpv6 =
        !entry.startsWith('[') && entry.indexOf(':') !== entry.lastIndexOf(':');
      let url = null;
      try {
        url = new URL(`https://${bareIpv6 ? `[${entry}]` : entry}`);
      } catch {
        // Reported below.
      }
      if (
        !url ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw Error(
          `${variable}: "${entry}" is not a host name with an optional port`,
        );
      return {
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        authority: url.host,
      };
    });
}

/** Startup check: every entry parses, and no host is both an employee and an admin
 * entry (the employee entry would win and the admin one would never open). */
export function checkPortalHostConfiguration(env = process.env) {
  const employee = [
    'allrice.bplabs.xyz',
    ...configuredPortalEntries('ALLRICE_EMPLOYEE_PORTAL_HOSTS', env).map(
      (entry) => entry.host,
    ),
  ];
  const both = configuredPortalEntries('ALLRICE_ADMIN_PORTAL_HOSTS', env)
    .map((entry) => entry.host)
    .filter((host) => employee.includes(host));
  if (both.length)
    throw Error(
      `ALLRICE_ADMIN_PORTAL_HOSTS lists employee entries: ${both.join(', ')}`,
    );
}
