/* global AbortSignal, URL, fetch */

/** Keep the native browser credential inside the administrator gateway. */
export function createUpstreamAuthentication(upstream) {
  let launchUrl;
  let cookie;
  let expiresAt = 0;
  let pending;
  return {
    accept(message) {
      if (message?.type !== 'allrice/admin-native-auth') return;
      const url = new URL(message.url);
      if (
        url.origin !== upstream ||
        url.pathname !== '/' ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams.keys()].join(',') !== 'token' ||
        !/^[A-Za-z0-9_-]{20,200}$/.test(url.searchParams.get('token') ?? '')
      )
        throw new Error('Invalid native administrator authentication endpoint');
      launchUrl = url.href;
      cookie = undefined;
      expiresAt = 0;
    },
    async cookie() {
      if (!launchUrl) throw new Error('Native administrator is starting');
      if (cookie && Date.now() < expiresAt) return cookie;
      pending ??= (async () => {
        const response = await fetch(launchUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        const value = response.headers.get('set-cookie')?.split(';')[0];
        if (
          response.status !== 303 ||
          !value ||
          response.headers.get('location') !== '/'
        )
          throw new Error('Native administrator authentication failed');
        cookie = value;
        // Native cookies last 30 days; refresh long before expiration.
        expiresAt = Date.now() + 60 * 60 * 1000;
        return cookie;
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

/** Validate the browser origin before lending the gateway's native identity. */
export function trustedGatewayOrigin(request, secure) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === `${secure ? 'https' : 'http'}://${request.headers.host}`;
}
