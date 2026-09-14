/* global AbortController, AbortSignal, setTimeout, clearTimeout */
import { URL } from 'node:url';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { stream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';

const confirmationText = 'run-one-codex-subscription-cap-probe';
const timeoutMs = 20_000;
const maxOutputTokens = 64;
const modelId = 'gpt-5.6-luna';
const endpoint = 'https://chatgpt.com/backend-api';
const key = credentialKey('llm-pi-ai', 'openai-codex');
const finishReasons = new Set([
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
]);

function safeUsage(usage) {
  if (!usage) return null;
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  const fields = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  if (!fields.every(valid)) return null;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // pi-ai synthesizes zero usage on early failures / absent remote usage.
  if (!Number.isSafeInteger(inputTokens) || inputTokens === 0) return null;
  return {
    inputTokens,
    cachedInputTokens: usage.cacheRead,
    outputTokens: usage.output,
    ...(valid(usage.reasoning) ? { reasoningTokens: usage.reasoning } : {}),
  };
}

function safeFailure(message, httpStatus, aborted) {
  const text = typeof message === 'string' ? message : '';
  const fieldRejected =
    httpStatus === 400 &&
    /max_output_tokens/i.test(text) &&
    /unsupported|unknown|unrecognized|not (?:allowed|supported)|extra inputs/i.test(
      text,
    );
  return {
    fieldRejected,
    errorType: aborted
      ? 'aborted'
      : fieldRejected
        ? 'unsupported_output_cap'
        : httpStatus === 401 || httpStatus === 403
          ? 'authentication'
          : httpStatus === 429
            ? 'rate_limit_or_quota'
            : httpStatus === 400
              ? 'invalid_request'
              : httpStatus >= 500
                ? 'server'
                : 'provider_or_transport',
  };
}

/**
 * One manually authorized compatibility probe, NOT an assistant Agent loop and
 * NOT a production output-bound implementation. Nothing runs on import.
 *
 * Call with the existing DSH ctx.credentials service. Only its public
 * readRecord seam is used. No credentials file is copied, no token is printed,
 * no OAuth refresh/login or credential mutation is performed. A nearly expired
 * grant fails before model I/O; its normal owning auth workflow must renew it.
 *
 * SSE, maxRetries:0, a short fixed prompt, a 64-token requested cap and a
 * 20-second AbortSignal prevent retries / unbounded waiting. Abort is not a
 * server-side generation or billing bound. On an unsupported parameter, the
 * probe ends without another request and never retries with the cap removed.
 *
 * A length finish at the requested bound is single-sample compatibility
 * evidence. It does NOT prove universal cap enforcement, accounting readiness, or permission
 * to open an assistant output-bound gate. Only allowlisted scalar diagnostics
 * leave this function; no response text, thoughts, headers or error body do.
 *
 * loopbackEndpoint exists only for real HTTP regression tests and accepts an
 * explicit numeric IPv4 loopback listener. The live endpoint is not configurable.
 */
export async function runCodexSubscriptionCapProbe({
  confirmation,
  credentials,
  signal,
  loopbackEndpoint,
} = {}) {
  const result = {
    schemaVersion: 1,
    probe: 'codex-subscription-max-output-tokens',
    provider: 'openai-codex',
    model: modelId,
    maxOutputTokens,
    transport: 'sse',
    timeoutMs,
    sdkRetries: 0,
    httpStatus: null,
    payloadCount: 0,
    fieldRejected: false,
    finishReason: null,
    usage: null,
    errorType: null,
    outcome: 'not_started',
    serverEnforcementProven: false,
    productionGateEvidence: false,
    singleSampleCapConsistent: false,
    credentialShapeValidated: false,
  };
  if (confirmation !== confirmationText) {
    return { ...result, outcome: 'opt_in_required' };
  }
  let target = endpoint;
  if (loopbackEndpoint !== undefined) {
    try {
      const url = new URL(loopbackEndpoint);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.pathname !== '/backend-api' ||
        url.search ||
        url.hash
      ) {
        return { ...result, outcome: 'invalid_loopback_endpoint' };
      }
      target = url.href;
    } catch {
      return { ...result, outcome: 'invalid_loopback_endpoint' };
    }
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const upstream = signal
    ? AbortSignal.any([signal, abort.signal])
    : abort.signal;
  let accessToken;
  try {
    if (upstream.aborted) return { ...result, outcome: 'aborted' };
    const record = await credentials?.readRecord(key);
    const grant = record?.kind === 'grant' ? record.payload : undefined;
    if (
      grant?.type !== 'oauth' ||
      typeof grant.access !== 'string' ||
      !grant.access ||
      /\r|\n/.test(grant.access) ||
      !Number.isFinite(grant.expires)
    ) {
      return { ...result, outcome: 'subscription_grant_required' };
    }
    result.credentialShapeValidated = true;
    if (grant.expires <= Date.now() + timeoutMs) {
      return { ...result, outcome: 'unexpired_subscription_grant_required' };
    }
    accessToken = grant.access;
    if (upstream.aborted) return { ...result, outcome: 'aborted' };
    const catalogModel = openaiCodexProvider()
      .getModels()
      .find((candidate) => candidate.id === modelId);
    if (!catalogModel) return { ...result, outcome: 'pinned_model_missing' };
    const model = { ...catalogModel, baseUrl: target };
    const events = stream(
      model,
      {
        systemPrompt: 'This is a compatibility probe. Follow the exact task.',
        messages: [
          {
            role: 'user',
            content:
              'Write every integer from 1 through 100 in order, separated by spaces. Do not omit, abbreviate, compress, summarize, use ellipses, or add commentary.',
            timestamp: 0,
          },
        ],
      },
      {
        apiKey: accessToken,
        signal: upstream,
        transport: 'sse',
        timeoutMs,
        maxRetries: 0,
        cacheRetention: 'none',
        maxTokens: maxOutputTokens,
        reasoningEffort: 'low',
        onPayload(payload, selectedModel) {
          if (
            upstream.aborted ||
            selectedModel.baseUrl !== target ||
            selectedModel.id !== modelId ||
            ++result.payloadCount !== 1
          ) {
            throw Error('cap_probe_dispatch_refused');
          }
          // The sole body change under investigation.
          return { ...payload, max_output_tokens: maxOutputTokens };
        },
        onResponse(response) {
          if (
            Number.isInteger(response.status) &&
            response.status >= 100 &&
            response.status <= 599
          ) {
            result.httpStatus = response.status;
          }
        },
      },
    );
    for await (const event of events) {
      if (event.type !== 'done' && event.type !== 'error') continue;
      const message = event.type === 'done' ? event.message : event.error;
      result.finishReason = finishReasons.has(message.stopReason)
        ? message.stopReason
        : 'unknown';
      result.usage = safeUsage(message.usage);
      if (event.type === 'error') {
        Object.assign(
          result,
          safeFailure(
            message.errorMessage,
            result.httpStatus,
            upstream.aborted,
          ),
        );
        result.outcome = result.fieldRejected
          ? 'cap_field_rejected'
          : upstream.aborted
            ? 'aborted'
            : 'failed';
      } else {
        result.outcome = 'response_received_single_sample';
        result.singleSampleCapConsistent =
          result.httpStatus === 200 &&
          result.finishReason === 'length' &&
          result.usage?.outputTokens === maxOutputTokens;
      }
    }
    if (result.outcome === 'not_started') result.outcome = 'no_terminal_event';
    return result;
  } catch {
    // Never propagate arbitrary credential/provider exceptions to a CLI logger.
    return {
      ...result,
      outcome: upstream.aborted ? 'aborted' : 'probe_failed',
      errorType: upstream.aborted ? 'aborted' : 'credential_or_internal',
    };
  } finally {
    accessToken = undefined;
    abort.abort();
    clearTimeout(timer);
  }
}
