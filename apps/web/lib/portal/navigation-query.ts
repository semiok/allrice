/** Keep useful page state while preventing credential-bearing legacy bookmarks
 * from forwarding passwords or session tokens to another portal. */
export function safeNavigationQuery(url: URL) {
  const query = new URLSearchParams(url.search);
  for (const key of [...query.keys()]) {
    if (key === 'token' && url.pathname === '/accept-invitation') continue;
    if (
      /^(?:password|pass|pwd|token|session_?token|access_?token|refresh_?token|id_?token|authorization|cookie|allrice_session|api_?key|secret)$/i.test(
        key,
      )
    )
      query.delete(key);
  }
  const next = query.get('next');
  if (next) {
    try {
      const target = new URL(next, url.origin);
      if (
        target.origin !== url.origin ||
        !/^\/(chatflow|runtime-console|workspace|employees|automation)(\/|$)/.test(
          target.pathname,
        )
      )
        query.delete('next');
      else {
        target.searchParams.delete('next');
        query.set('next', target.pathname + safeNavigationQuery(target));
      }
    } catch {
      query.delete('next');
    }
  }
  const result = query.toString();
  return result ? `?${result}` : '';
}
