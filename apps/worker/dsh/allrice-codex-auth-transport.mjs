/* global AbortSignal, URL, fetch, process */
import { setTimeout as sleep } from 'node:timers/promises';

// Only the dedicated authorization child loads this module. Keep native DSH
// OAuth, polling intervals and credential persistence; recover transient HTTP
// transport failures without restarting the login or replacing its device code.
const paths = new Set([
  '/api/accounts/deviceauth/usercode',
  '/api/accounts/deviceauth/token',
]);
const transientStatus = new Set([500, 502, 503, 504]);
function isTransient(error) {
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout/i.test(
    `${error?.name ?? ''} ${error?.message ?? ''} ${error?.cause?.code ?? ''}`,
  );
}

export function codexAuthorizationFetch(
  fetchImpl,
  { wait = sleep, timeoutMs = 15_000 } = {},
) {
  return async function authorizationFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input.href);
    } catch {
      return fetchImpl(input, init);
    }
    if (
      url.origin !== 'https://auth.openai.com' ||
      !paths.has(url.pathname) ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      return fetchImpl(input, init);

    for (let attempt = 0; attempt < 3; attempt++) {
      init.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      let response;
      let failure = 'codex_authorization_network_unavailable';
      try {
        response = await fetchImpl(input, { ...init, signal });
      } catch (error) {
        init.signal?.throwIfAborted();
        if (!isTransient(error)) throw error;
      }
      if (response) {
        // Native 403/404 authorization-pending and slow_down handling must pass
        // through. Never retry OAuth token exchanges, grants, or model calls.
        if (!transientStatus.has(response.status)) return response;
        failure = 'codex_authorization_service_unavailable';
        await response.body?.cancel().catch(() => {});
      }
      if (attempt === 2) throw new Error(failure);
      await wait(1000 * 2 ** attempt, undefined, { signal: init.signal });
    }
  };
}

if (process.env.ALLRICE_CODEX_AUTH_TRANSPORT === '1') {
  globalThis.fetch = codexAuthorizationFetch(fetch);
}
