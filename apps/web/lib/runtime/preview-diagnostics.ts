import {
  activePreviewDiagnostics,
  createPreviewDiagnostics,
} from '../../server/preview-diagnostics.mjs';

export type PreviewDiagnostics = ReturnType<typeof createPreviewDiagnostics>;

export async function previewPhase<T>(
  diagnostic: PreviewDiagnostics | undefined,
  stage: string,
  body: () => Promise<T>,
): Promise<T> {
  return diagnostic ? diagnostic.phase(stage, body) : body();
}

export function previewRequestDiagnostics(request: Request) {
  const diagnostic: PreviewDiagnostics =
    activePreviewDiagnostics() ?? createPreviewDiagnostics();
  const aborted = () => diagnostic.emit('abort', 'request', { aborted: true });
  request.signal.addEventListener('abort', aborted, { once: true });
  if (request.signal.aborted) aborted();
  return {
    diagnostic,
    dispose: () => request.signal.removeEventListener('abort', aborted),
  };
}

/** Existing callers share the same redaction, even outside the observed route. */
export function reportPreviewFailure(
  stage: 'artifact-request' | 'office-conversion',
  error: unknown,
  referenceId?: string,
  diagnostic = createPreviewDiagnostics(),
) {
  diagnostic.emit('failure', stage, {}, error, referenceId);
}
