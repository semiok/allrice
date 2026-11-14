import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

// Native process is shared by the custom server and separately bundled Node
// routes. This single ALS instance holds no per-request registry or authority.
const contextKey = Symbol.for('allrice.web.preview-diagnostics');
const context = (process[contextKey] ??= new AsyncLocalStorage());
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const errorNames = new Set([
  'Error',
  'AbortError',
  'ResponseAborted',
  'OfficeToPdfError',
  'ConversionError',
  'ArtifactReviewError',
  'DataAccessError',
  'AggregateError',
]);
const errorCodes = new Set([
  'CONNECT_TIMEOUT',
  'ETIMEDOUT',
  'busy',
  'timeout',
  'unavailable',
  'failed',
  'invalid-document',
  'invalid-output',
  'input-too-large',
  'output-too-large',
  'unsupported-format',
  'source-changed',
  'preview_timeout',
  'content_changed',
  'authentication_required',
  'authorization_denied',
  'not_found',
]);
const hash = (value) =>
  typeof value === 'string'
    ? createHash('sha256').update(value).digest('hex')
    : undefined;

/** Only fixed fields cross this boundary; no message, raw identifier or URL. */
export function createPreviewDiagnostics() {
  const requestId = randomUUID();
  const started = performance.now();
  let objectHash;
  const emit = (event, stage, details = {}, error, referenceId) => {
    const causes = [];
    for (
      let cause = error;
      cause instanceof Error && causes.length < 3;
      cause = cause.cause
    )
      causes.push({
        name: errorNames.has(cause.name) ? cause.name : 'OtherError',
        code: errorCodes.has(cause.code) ? cause.code : undefined,
      });
    const release = process.env.ALLRICE_RELEASE_SHA;
    const entry = {
      at: new Date().toISOString(),
      requestId,
      objectHash,
      referenceHash: hash(referenceId),
      event,
      stage,
      elapsedMs: Math.round(performance.now() - started),
      durationMs: details.durationMs,
      status: details.status,
      aborted: details.aborted,
      outcome: details.outcome,
      releaseSha: /^[a-f0-9]{40}$/.test(release ?? '') ? release : undefined,
      ...(error === undefined ? {} : { causes }),
    };
    if (error === undefined) globalThis.console.info('Document preview', entry);
    else globalThis.console.error('Document preview failed', entry);
  };
  return {
    requestId,
    started,
    emit,
    object: (id) => {
      objectHash = hash(id);
    },
    async phase(stage, body) {
      const phaseStart = performance.now();
      emit('start', stage);
      try {
        const result = await body();
        emit('end', stage, {
          durationMs: Math.round(performance.now() - phaseStart),
          outcome: 'ok',
        });
        return result;
      } catch (error) {
        emit(
          'end',
          stage,
          {
            durationMs: Math.round(performance.now() - phaseStart),
            outcome: 'error',
          },
          error,
        );
        throw error;
      }
    },
  };
}

export function activePreviewDiagnostics() {
  return context.getStore();
}

/** Only this exact endpoint gets HTTP observation and an asynchronous scope.
 * Other entrypoints create fresh route diagnostics, never trusting headers. */
export function observePreviewHttp(request, response, handle) {
  const path = request.url?.split('?')[0];
  const match = /^\/api\/v1\/workbench\/files\/([^/]+)\/preview$/.exec(
    path ?? '',
  );
  if (request.method !== 'GET' || !match || !uuid.test(match[1]))
    return handle();
  const diagnostic = createPreviewDiagnostics();
  diagnostic.object(match[1]);
  diagnostic.emit('start', 'http');
  response.once('finish', () =>
    diagnostic.emit('finish', 'http', {
      status: response.statusCode,
      aborted: false,
    }),
  );
  response.once('close', () =>
    diagnostic.emit('close', 'http', {
      status: response.headersSent ? response.statusCode : undefined,
      aborted: !response.writableFinished,
    }),
  );
  return context.run(diagnostic, handle);
}
