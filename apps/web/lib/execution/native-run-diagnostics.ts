import {
  NativeRunDiagnosticsSchema,
  type RequestContext,
} from '@allrice/contracts';

export class NativeDiagnosticsUnavailable extends Error {
  constructor(readonly status = 503) {
    super('Native diagnostics unavailable');
  }
}

export async function requestNativeRunDiagnostics(input: {
  token: string;
  context: RequestContext;
  workspaceId: string;
  runId: string;
  signal: AbortSignal;
}) {
  try {
    // Fixed deployment address, never a request URL. Redirects must not carry
    // an authenticated user's session token to another destination.
    const base = new URL(
      process.env.ALLRICE_WORKER_INTERNAL_URL?.trim() ||
        `http://127.0.0.1:${process.env.ALLRICE_WORKER_PORT ?? '3101'}`,
    );
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new NativeDiagnosticsUnavailable();
    const response = await fetch(
      new URL('/internal/native-run-diagnostics', base),
      {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          runId: input.runId,
          organizationId: input.context.organizationId,
          workspaceId: input.workspaceId,
        }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(12_000)]),
      },
    );
    if (!response.ok)
      throw new NativeDiagnosticsUnavailable(
        [401, 404].includes(response.status) ? response.status : 503,
      );
    const body: unknown = await response.json();
    const diagnostics = NativeRunDiagnosticsSchema.parse(
      body && typeof body === 'object' && 'diagnostics' in body
        ? body.diagnostics
        : undefined,
    );
    if (diagnostics.runId !== input.runId)
      throw new NativeDiagnosticsUnavailable();
    return diagnostics;
  } catch (error) {
    if (error instanceof NativeDiagnosticsUnavailable) throw error;
    throw new NativeDiagnosticsUnavailable();
  }
}
