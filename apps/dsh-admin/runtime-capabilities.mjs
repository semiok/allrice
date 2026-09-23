/* global process, Buffer, fetch, AbortSignal, URL */
import {
  AllriceCapabilitySummarySchema,
  DshNativeCapabilitySnapshotSchema,
} from '@allrice/contracts';

export function createNativeCapabilityObserver({
  version,
  releaseSha,
  now = Date.now,
}) {
  let latest = null;
  return {
    accept(message) {
      if (message?.type !== 'allrice/admin-native-capabilities') return false;
      const parsed = DshNativeCapabilitySnapshotSchema.safeParse(message);
      // Malformed telemetry invalidates the prior report immediately.
      latest = parsed.success ? { ...parsed.data, receivedAt: now() } : null;
      return true;
    },
    read() {
      if (!latest || now() - latest.receivedAt >= 20000) return null;
      return {
        version,
        releaseSha,
        observedAt: new Date(latest.receivedAt).toISOString(),
        components: latest.components,
      };
    },
  };
}

export async function readAllriceCapabilities({
  baseUrl = process.env.ALLRICE_CAPABILITY_SYNC_BASE_URL,
  token = process.env.ALLRICE_CAPABILITY_SYNC_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl || !token || token.length < 32)
    return { status: 'unconfigured', data: null };
  try {
    const url = new URL('/api/v1/internal/runtime-capabilities', baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Invalid sync origin');
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Unavailable');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 65536) throw new Error('Oversized status');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const data = AllriceCapabilitySummarySchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    const age = Date.now() - Date.parse(data.checkedAt);
    if (age > 30000 || age < -30000) throw new Error('Stale status');
    return { status: 'available', data };
  } catch {
    return { status: 'unavailable', data: null };
  }
}
