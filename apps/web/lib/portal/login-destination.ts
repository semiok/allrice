/** Preserve employee trial navigation after tenant login, never redirect off-site. */
export function loginDestination(
  next: string | null,
  fallback: string,
  origin: string,
) {
  if (!next) return fallback;
  try {
    const target = new URL(next, origin);
    if (
      target.origin === origin &&
      /^\/(chatflow|runtime-console|workspace|employees|automation)(\/|$)/.test(
        target.pathname,
      )
    )
      return target.pathname + target.search;
  } catch {
    /* Invalid navigation hints do not change the login destination. */
  }
  return fallback;
}
