import { safeNavigationQuery } from './navigation-query';
/** Preserve employee trial navigation after tenant login, never redirect off-site.
 * `employeeEntry` comes from the server, which knows this deployment's hosts: an
 * employee entry never navigates into the admin console. */
export function loginDestination(
  next: string | null,
  fallback: string,
  origin: string,
  employeeEntry: boolean,
) {
  if (!next) return fallback;
  try {
    const target = new URL(next, origin);
    if (
      target.origin === origin &&
      !(employeeEntry && /^\/runtime-console(\/|$)/.test(target.pathname)) &&
      /^\/(chatflow|runtime-console|workspace|employees|automation)(\/|$)/.test(
        target.pathname,
      )
    )
      return target.pathname + safeNavigationQuery(target);
  } catch {
    /* Invalid navigation hints do not change the login destination. */
  }
  return fallback;
}
