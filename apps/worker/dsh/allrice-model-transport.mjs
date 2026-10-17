/* global AbortController, AbortSignal, ReadableStream, Response, TextDecoder */
import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { ModelTransportFailureCodeSchema } from '@allrice/contracts';
import {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
} from '@earendil-works/pi-ai/api/openai-codex-responses';

const requests = new AsyncLocalStorage();
const httpAttempts = new AsyncLocalStorage();
const undiciAttempts = new WeakMap();
let installed = false;
const failureCodes = new Set(ModelTransportFailureCodeSchema.options);

function ownData(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function transportFailureCode(error) {
  // Native fetch commonly nests the socket/DNS code under cause. Never read
  // accessors or arbitrary error text, and keep even cyclic causes bounded.
  for (let depth = 0; error && depth < 4; depth++) {
    const code = ownData(error, 'code');
    if (failureCodes.has(code)) return code;
    error = ownData(error, 'cause');
  }
}

// The published DSH adapter does not forward pi-ai's fetch option. Observe
// fetch only inside our request's async scope; unrelated tools/auth/UI requests
// retain the original fetch. No provider payload, header or URL is retained.
export function installModelTransportObservation() {
  if (installed) return;
  installed = true;
  // Public Node diagnostics only. A pooled connection may have no connect
  // events for this request: leave those fields unknown, never infer zero.
  subscribe('undici:request:create', (message) => {
    const request = ownData(message, 'request');
    const attempt = httpAttempts.getStore();
    if (attempt && request && typeof request === 'object')
      undiciAttempts.set(request, attempt);
  });
  subscribe('undici:client:beforeConnect', () => {
    const attempt = httpAttempts.getStore();
    if (attempt) attempt.connectionStartedAt ??= performance.now();
  });
  subscribe('undici:client:connected', () => {
    const attempt = httpAttempts.getStore();
    if (attempt) attempt.connectionReadyAt ??= performance.now();
  });
  subscribe('undici:request:bodySent', (message) => {
    const request = ownData(message, 'request');
    const attempt = undiciAttempts.get(request);
    if (attempt) attempt.bodySentAt ??= performance.now();
  });
  const original = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const scope = requests.getStore();
    return scope ? scope.fetch(original, input, init) : original(input, init);
  };
}

export function createModelTransport({
  provider,
  sessionId,
  startedMono = performance.now(),
} = {}) {
  const controller = new AbortController();
  const bodies = new Set();
  const now = () => Date.now();
  let pendingFetches = 0;
  let pendingCancellations = 0;
  let observed = false;
  let bytes = 0;
  let heartbeats = 0;
  let events = 0;
  let lastByteAt;
  let lastHeartbeatAt;
  let lastEventAt;
  let outputItemEnded = false;
  let terminalEvent = false;
  let incompleteFrames = false;
  let readFailed = false;
  let stopped = false;
  let lastRequest;
  const attempts = [];
  let requestCount = 0;
  const offset = (value) =>
    value === undefined ? null : Math.max(0, Math.round(value - startedMono));
  const websocketRequests = () =>
    provider === 'openai-codex' && sessionId
      ? (getOpenAICodexWebSocketDebugStats(String(sessionId))?.requests ?? 0)
      : 0;
  const initialWebsocketRequests = websocketRequests();
  let closedWebsocket = false;

  function parser(request) {
    const decoder = new TextDecoder();
    let line = '';
    let oversized = false;
    return (chunk) => {
      bytes += chunk.byteLength;
      lastByteAt = now();
      request.firstByteAt ??= performance.now();
      // Parse only bounded SSE lines. Large payloads still pass through intact;
      // diagnostics never accumulate a response, arguments, or model thoughts.
      for (const part of decoder
        .decode(chunk, { stream: true })
        .split(/(\n)/)) {
        if (part !== '\n') {
          if (!oversized && line.length + part.length <= 65_536) line += part;
          else {
            line = '';
            oversized = true;
          }
          continue;
        }
        if (oversized) {
          incompleteFrames = true;
          events++;
          lastEventAt = lastByteAt;
        } else if (
          line.startsWith(':') ||
          /^data:\s*\[?ping\]?\s*$/i.test(line)
        ) {
          heartbeats++;
          lastHeartbeatAt = lastByteAt;
        } else if (line.startsWith('data:')) {
          try {
            const value = JSON.parse(line.slice(5).trim());
            if (['ping', 'heartbeat', 'keepalive'].includes(value?.type)) {
              heartbeats++;
              lastHeartbeatAt = lastByteAt;
            } else {
              events++;
              lastEventAt = lastByteAt;
              request.firstEventAt ??= performance.now();
              if (value?.type === 'response.output_item.done')
                outputItemEnded = true;
              if (
                [
                  'response.completed',
                  'response.failed',
                  'response.incomplete',
                ].includes(value?.type)
              )
                terminalEvent = true;
            }
          } catch {
            events++;
            lastEventAt = lastByteAt;
          }
        }
        line = '';
        oversized = false;
      }
    };
  }
  const scope = {
    run: (fn) => requests.run(scope, fn),
    async fetch(original, input, init) {
      // An abandoned producer must not start a late fallback/reconnect.
      if (stopped) throw controller.signal.reason;
      pendingFetches++;
      const request = {
        phase: 'awaiting_headers',
        startedAt: now(),
        startedMono: performance.now(),
      };
      requestCount++;
      if (attempts.length < 8) attempts.push(request);
      lastRequest = request;
      request.signal = controller.signal;
      const failed = (phase, error) => {
        request.phase = phase;
        request.finishedAt = now();
        request.aborted = request.signal.aborted;
        request.errorCode = transportFailureCode(error);
      };
      try {
        const incoming = init?.signal ?? input?.signal;
        const signal = incoming
          ? AbortSignal.any([incoming, controller.signal])
          : controller.signal;
        request.signal = signal;
        const response = await httpAttempts.run(request, () =>
          original(input, {
            ...init,
            signal,
          }),
        );
        request.phase = 'headers_received';
        request.finishedAt = now();
        request.headersAt = performance.now();
        request.status = response.status;
        if (
          !response.body ||
          !response.headers.get('content-type')?.includes('text/event-stream')
        )
          return response;
        observed = true;
        const reader = response.body.getReader();
        const observe = parser(request);
        const state = { cancel: undefined };
        bodies.add(state);
        const finish = () => {
          request.closedAt ??= performance.now();
          bodies.delete(state);
          controller.signal.removeEventListener('abort', onAbort);
        };
        const cancel = () => {
          if (!state.cancel) {
            pendingCancellations++;
            state.cancel = reader
              .cancel(controller.signal.reason)
              .then(finish)
              .finally(() => {
                pendingCancellations--;
              });
          }
          state.cancel.catch(() => {});
          return state.cancel;
        };
        const onAbort = () => {
          void cancel();
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) void cancel();
        const body = new ReadableStream(
          {
            async pull(target) {
              try {
                const result = await reader.read();
                if (result.done) {
                  finish();
                  target.close();
                } else {
                  observe(result.value);
                  target.enqueue(result.value);
                }
              } catch (error) {
                failed('body_failed', error);
                readFailed = !controller.signal.aborted;
                finish();
                target.error(error);
              }
            },
            cancel,
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        failed('request_failed', error);
        throw error;
      } finally {
        pendingFetches--;
      }
    },
    timing() {
      return {
        transport: observed
          ? 'sse'
          : websocketRequests() > initialWebsocketRequests
            ? 'websocket'
            : 'unobserved',
        requestCount,
        websocketRequests: Math.max(
          0,
          websocketRequests() - initialWebsocketRequests,
        ),
        requestsTruncated: requestCount > attempts.length,
        // Raw URL/headers/body/socket/credentials are never retained here.
        httpRequests: attempts.map((request) => ({
          startedMs: offset(request.startedMono),
          connectionStartedMs: offset(request.connectionStartedAt),
          connectionReadyMs: offset(request.connectionReadyAt),
          bodySentMs: offset(request.bodySentAt),
          headersMs: offset(request.headersAt),
          firstByteMs: offset(request.firstByteAt),
          firstEventMs: offset(request.firstEventAt),
          closedMs: offset(request.closedAt),
          ...(request.status >= 100 && request.status <= 599
            ? { status: request.status }
            : {}),
          ...(request.errorCode ? { errorCode: request.errorCode } : {}),
        })),
      };
    },
    snapshot(lastChunkAt) {
      const websocket = websocketRequests() > initialWebsocketRequests;
      const missingTerminal =
        outputItemEnded && !terminalEvent && !incompleteFrames;
      const heartbeatOnly =
        lastHeartbeatAt > (lastChunkAt ?? 0) &&
        (lastEventAt ?? 0) <= (lastChunkAt ?? 0);
      return {
        transport: observed ? 'sse' : websocket ? 'websocket' : 'unobserved',
        state: missingTerminal
          ? 'missing_terminal'
          : observed && !bodies.size && !pendingFetches
            ? 'transport_closed'
            : heartbeatOnly
              ? 'heartbeat_only'
              : observed && lastByteAt > (lastChunkAt ?? 0)
                ? 'transport_active'
                : observed
                  ? 'transport_silent'
                  : 'unobserved',
        bytes,
        heartbeats,
        events,
        terminalEvent,
        outputItemEnded,
        readFailed,
        ...(lastByteAt === undefined
          ? {}
          : { lastByteAgeMs: Math.max(0, now() - lastByteAt) }),
        ...(lastRequest
          ? {
              request: {
                phase: lastRequest.phase,
                elapsedMs: Math.max(
                  0,
                  (lastRequest.finishedAt ?? now()) - lastRequest.startedAt,
                ),
                aborted: lastRequest.aborted ?? lastRequest.signal.aborted,
                ...(lastRequest.status >= 100 && lastRequest.status <= 599
                  ? { status: lastRequest.status }
                  : {}),
                ...(lastRequest.errorCode
                  ? { errorCode: lastRequest.errorCode }
                  : {}),
              },
            }
          : {}),
      };
    },
    stop() {
      if (stopped) return;
      stopped = true;
      controller.abort(new Error('allrice_model_request_stopped'));
      if (
        provider === 'openai-codex' &&
        sessionId &&
        websocketRequests() > initialWebsocketRequests
      ) {
        closedWebsocket = true;
        // Public, session-scoped pi-ai cleanup; never closes another session.
        closeOpenAICodexWebSocketSessions(String(sessionId));
      }
    },
    locallyClosed() {
      return (
        pendingFetches === 0 &&
        pendingCancellations === 0 &&
        bodies.size === 0 &&
        (observed || closedWebsocket)
      );
    },
  };
  return scope;
}
