export class BridgeClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function bridgeRequest<T>(input: {
  server: string;
  path: string;
  method?: 'GET' | 'POST';
  token?: string;
  body?: unknown;
  maximumResponseBytes?: number;
  timeoutMs?: number;
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.server), {
    // Opt-in operation requests are bounded and cannot silently redirect their
    // authenticated execution channel. Legacy request behavior is unchanged.
    redirect: input.maximumResponseBytes === undefined ? 'follow' : 'error',
    method: input.method ?? 'GET',
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs ?? 35_000),
  });
  let parsed: unknown;
  if (input.maximumResponseBytes !== undefined) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (reader) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > input.maximumResponseBytes) {
          await reader.cancel();
          throw new BridgeClientError(
            'Bridge response exceeded its limit',
            413,
          );
        }
        chunks.push(next.value);
      }
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      reader?.releaseLock();
    }
  } else {
    parsed = await response.json().catch(() => ({}));
  }
  const body = parsed as {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new BridgeClientError(
      body.error?.message ?? `Rice Bridge API returned HTTP ${response.status}`,
      response.status,
    );
  }
  return body as T;
}
