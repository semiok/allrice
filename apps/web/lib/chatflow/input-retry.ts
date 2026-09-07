/** Store only an opaque request fingerprint and UUID, never prompt text.
 * Keep uncertain submissions across reload; a confirmed ordinary message frees
 * its slot so intentionally repeating the same message creates a new input. */
export async function inputRetry(scope: string, body: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, body]));
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const key = `allrice-input:${digest}`;
  const fresh = () => ({ id: crypto.randomUUID(), at: Date.now() });
  let entry = fresh();
  try {
    const old = JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
      id?: unknown;
      at?: unknown;
    } | null;
    if (
      old &&
      typeof old.id === 'string' &&
      /^[a-f0-9-]{36}$/.test(old.id) &&
      typeof old.at === 'number' &&
      Date.now() - old.at < 86_400_000
    )
      entry = { id: old.id, at: old.at };
    sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* Storage may be disabled; server still binds every supplied ID. */
  }
  return {
    id: entry.id,
    confirmed: () => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Browser storage can be unavailable. */
      }
    },
  };
}
