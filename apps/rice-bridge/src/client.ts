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
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.server), {
    method: input.method ?? 'GET',
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(35_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
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
