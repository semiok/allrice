import {
  NativeRunDiagnosticsSchema,
  NativeSubagentSummarySchema,
  type RequestContext,
} from '@allrice/contracts';

export class NativeDiagnosticsUnavailable extends Error {
  constructor(readonly status = 503) {
    super('Native diagnostics unavailable');
  }
}

type NativeReadInput = {
  token: string;
  context: RequestContext;
  workspaceId: string;
  signal: AbortSignal;
};

async function requestNativeRead<T>(
  input: NativeReadInput,
  address: { runId: string } | { sessionId: string },
  read: (body: Record<string, unknown>) => T,
) {
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
      new URL(
        'runId' in address
          ? '/internal/native-run-diagnostics'
          : '/internal/native-subagent-summary',
        base,
      ),
      {
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.token}`,
        },
        body: JSON.stringify({
          ...address,
          organizationId: input.context.organizationId,
          workspaceId: input.workspaceId,
        }),
        signal:
          'runId' in address
            ? AbortSignal.any([input.signal, AbortSignal.timeout(12_000)])
            : input.signal,
      },
    );
    if (!response.ok)
      throw new NativeDiagnosticsUnavailable(
        [401, 404].includes(response.status) ? response.status : 503,
      );
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object')
      throw new NativeDiagnosticsUnavailable();
    return read(body as Record<string, unknown>);
  } catch (error) {
    if (error instanceof NativeDiagnosticsUnavailable) throw error;
    throw new NativeDiagnosticsUnavailable();
  }
}

export function requestNativeRunDiagnostics(
  input: NativeReadInput & { runId: string },
) {
  return requestNativeRead(input, { runId: input.runId }, (body) => {
    const diagnostics = NativeRunDiagnosticsSchema.parse(body.diagnostics);
    if (diagnostics.runId !== input.runId)
      throw new NativeDiagnosticsUnavailable();
    return diagnostics;
  });
}

export function requestNativeSubagentSummary(
  input: NativeReadInput & { sessionId: string },
) {
  return requestNativeRead(input, { sessionId: input.sessionId }, (body) => {
    if (body.sessionId !== input.sessionId)
      throw new NativeDiagnosticsUnavailable();
    return NativeSubagentSummarySchema.parse(body.summary);
  });
}
