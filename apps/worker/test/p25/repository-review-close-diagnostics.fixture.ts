// CI-only projection for the synthetic repository-review fixture. Never emit
// arbitrary error text, stacks, paths, transport frames or user content.
const identities = new Set([
  'DSH runtime closure remains unconfirmed',
  'DSH closure or pre-spawn observation remains unconfirmed',
  'DSH owned close failed',
  'DSH runtime close observation remains unconfirmed',
  'DSH root closure remains unconfirmed',
  'SDK server teardown failed',
  'DSH_RUNTIME_CLOSE_UNCONFIRMED',
  'DSH_RUNTIME_CLOSED',
  'DSH_RUNTIME_UNAVAILABLE',
  'DSH_RUNTIME_CLOSING',
  'DSH_REQUEST_TIMEOUT',
  'DSH_REQUEST_FAILED',
  'DSH_PROTOCOL_MISMATCH',
  'PLATFORM_TECHNICAL_AUTH_REVOKED',
  'EMPLOYEE_CONTENT_UNAVAILABLE',
  'task_progress_lease_lost',
  'lease_lost',
  'DSH_CLOSE_EVIDENCE_INVALID',
  'DSH_CLOSE_EVIDENCE_WRITE_UNCONFIRMED',
  'DSH_CLOSE_EVIDENCE_CONFLICT',
  'DSH_CLOSE_CONTEXT_SCOPE_INVALID',
  'DSH_CLOSE_OWNER_ALREADY_OBSERVED',
  'DSH_CLOSE_OWNER_INVALID',
  'DSH_CLOSE_OWNER_CONFLICT',
  'DSH_CLOSE_EVIDENCE_DUPLICATE',
  'DSH_CLOSE_OWNER_MISSING_OR_CONFLICT',
  'DSH_CLOSE_EVIDENCE_NEVER_SPAWNED_CONFLICT',
  // Fixed transport/SQLSTATE identities from possible close/observation faults.
  'EPIPE',
  'ECONNRESET',
  '40001',
  '40P01',
  '23505',
  '08006',
  '57P01',
]);
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const choice = (value: unknown, allowed: readonly unknown[]) =>
  allowed.includes(value) ? value : null;
const boolean = (value: unknown) => choice(value, [true, false]);
const signal = (value: unknown) =>
  value === null
    ? null
    : (choice(value, [
        'SIGTERM',
        'SIGKILL',
        'SIGINT',
        'SIGHUP',
        'SIGABRT',
        'SIGSEGV',
        'SIGPIPE',
      ]) ?? 'unknown');

function closeFacts(value: unknown) {
  const process = field(value, 'process') ?? value;
  const exitCode = field(process, 'exitCode');
  return {
    process: {
      state: choice(field(value, 'processState') ?? field(process, 'state'), [
        'running',
        'exited',
        'unknown',
      ]),
      stdioClosed: boolean(field(process, 'stdioClosed')),
      exitCode:
        typeof exitCode === 'number' && Number.isSafeInteger(exitCode)
          ? exitCode
          : null,
      signal: signal(field(process, 'signal')),
    },
    shutdownAcknowledged: boolean(field(value, 'shutdownAcknowledged')),
    wrapperCleanupConfirmed: boolean(field(value, 'wrapperCleanupConfirmed')),
    emptyTransportClosed: boolean(field(value, 'emptyTransportClosed')),
    terminationAttempted: signal(field(value, 'terminationAttempted')),
  };
}

export function reviewCloseError(error: unknown): unknown {
  const seen = new Set<object>();
  let remaining = 32;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 4 || --remaining < 0) return { omitted: 'limit' };
    if (!value || typeof value !== 'object') return { name: 'NonError' };
    if (seen.has(value)) return { omitted: 'cycle' };
    seen.add(value);
    const code = field(value, 'code');
    const message = field(value, 'message');
    const cause = field(value, 'cause');
    const errors = field(value, 'errors');
    const evidence = field(value, 'evidence');
    return {
      name:
        value instanceof AggregateError
          ? 'AggregateError'
          : value instanceof Error
            ? 'Error'
            : 'NonError',
      ...(typeof code === 'string' && identities.has(code) ? { code } : {}),
      ...(typeof message === 'string' && identities.has(message)
        ? { message }
        : {}),
      ...(evidence ? { evidence: closeFacts(evidence) } : {}),
      ...(cause !== undefined ? { cause: visit(cause, depth + 1) } : {}),
      ...(Array.isArray(errors)
        ? {
            errors: errors.slice(0, 8).map((item) => visit(item, depth + 1)),
            ...(errors.length > 8 ? { omittedErrors: errors.length - 8 } : {}),
          }
        : {}),
    };
  };
  return visit(error, 0);
}

export function logReviewCloseDiagnostics(input: {
  bodyError?: unknown;
  cleanupError?: unknown;
  clients: Iterable<{ closureEvidence(): unknown }>;
  adapter: { runtimeClosureInventory(): readonly unknown[] };
}) {
  // Diagnostics must not replace either original failure, even if inspection
  // itself fails. The fixture's existing catch/finally owns error propagation.
  try {
    console.info(
      '[repository-review-close]',
      JSON.stringify({
        bodyError:
          input.bodyError === undefined
            ? null
            : reviewCloseError(input.bodyError),
        cleanupError:
          input.cleanupError === undefined
            ? null
            : reviewCloseError(input.cleanupError),
        clients: [...input.clients].slice(0, 8).map((client) => {
          const evidence = client.closureEvidence();
          return evidence ? closeFacts(evidence) : null;
        }),
        inventory: input.adapter
          .runtimeClosureInventory()
          .slice(0, 8)
          .map((row) => ({
            state: choice(field(row, 'state'), ['closing', 'unconfirmed']),
            ...closeFacts(row),
          })),
      }),
    );
  } catch {
    /* Original errors and cleanup remain authoritative. */
  }
}

export async function closeReviewRuntime(input: {
  bodyError?: unknown;
  clients: Iterable<{ closureEvidence(): unknown }>;
  adapter: {
    close(): Promise<void>;
    runtimeClosureInventory(): readonly unknown[];
  };
}) {
  let cleanupError: unknown;
  try {
    await input.adapter.close();
  } catch (error) {
    cleanupError = error;
    throw error;
  } finally {
    logReviewCloseDiagnostics({ ...input, cleanupError });
  }
}
