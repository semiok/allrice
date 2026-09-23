/* global AbortSignal, Buffer */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { describe, expect, it } from 'vitest';
import { runCodexSubscriptionCapProbe } from './allrice-codex-subscription-cap-probe.mjs';

// This unsigned, deliberately synthetic value is generated here, not read from
// an environment variable, a credential store, a browser or a Codex login.
const syntheticToken = [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-loopback-account',
      },
    }),
  ).toString('base64url'),
  'synthetic-signature',
].join('.');

/** Real pinned DSH adapter -> real pinned pi-ai -> real loopback HTTP.
 * There is no fetch/client/SDK mock and no model invocation. The only model
 * endpoint comes from the just-bound loopback listener; auth is request-local.
 *
 * A loopback server accepting max_output_tokens proves ONLY serialization.
 * Neither public Responses API documentation nor this fixture establishes
 * that chatgpt.com/backend-api/codex/responses accepts/enforces that parameter.
 * Keep the exploratory hook test-local: it is NOT production gate evidence.
 */
async function runWire({
  injectLimit = false,
  rejectLimit = false,
  probe = false,
  incomplete = false,
  stall = false,
} = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_000_000) throw Error('synthetic_request_too_large');
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks);
      const decoded =
        request.headers['content-encoding'] === 'zstd'
          ? zstdDecompressSync(raw)
          : raw;
      calls.push({
        method: request.method,
        path: request.url,
        account: request.headers['chatgpt-account-id'],
        body: JSON.parse(decoded.toString('utf8')),
      });
      if (stall) return;
      if (rejectLimit) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              code: 'invalid_request_error',
              message: '400 Unsupported parameter: max_output_tokens',
            },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'synthetic-message', content: [] },
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          delta: 'SYNTHETIC_CODEX_WIRE_RESULT',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'synthetic-message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'SYNTHETIC_CODEX_WIRE_RESULT' },
            ],
          },
        },
      ]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end(
        `data: ${JSON.stringify({
          type: incomplete ? 'response.incomplete' : 'response.completed',
          response: {
            id: 'synthetic-response-never-openai',
            status: incomplete ? 'incomplete' : 'completed',
            ...(incomplete
              ? { incomplete_details: { reason: 'max_output_tokens' } }
              : {}),
            output: [
              {
                type: 'message',
                id: 'synthetic-message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'SYNTHETIC_CODEX_WIRE_RESULT',
                    annotations: [],
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 20,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens: incomplete ? 64 : 7,
              output_tokens_details: { reasoning_tokens: 2 },
              total_tokens: 27,
            },
          },
        })}\n\n`,
      );
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}/backend-api`;
    if (probe) {
      const result = await runCodexSubscriptionCapProbe({
        confirmation: 'run-one-codex-subscription-cap-probe',
        loopbackEndpoint: endpoint,
        ...(stall ? { signal: AbortSignal.timeout(200) } : {}),
        credentials: {
          async readRecord() {
            return {
              kind: 'grant',
              payload: {
                type: 'oauth',
                access: syntheticToken,
                refresh: 'synthetic-refresh-must-never-be-used',
                expires: Date.now() + 3_600_000,
              },
            };
          },
        },
      });
      return { calls, result };
    }
    const catalogProvider = openaiCodexProvider();
    const catalogModel = catalogProvider
      .getModels()
      .find((model) => model.id === 'gpt-5.6-luna');
    expect(catalogModel).toBeDefined();
    const model = { ...catalogModel, baseUrl: endpoint };
    const provider = createProvider({
      id: 'openai-codex',
      baseUrl: endpoint,
      auth: catalogProvider.auth,
      models: [model],
      api: openAICodexResponsesApi(),
    });
    const forwarded = [];
    let payloadHookCalls = 0;
    // A public Provider interface wrapper: no private fields, monkeypatch,
    // dependency source edits or parallel Agent implementation.
    const piProvider = {
      ...provider,
      streamSimple(selectedModel, context, options) {
        // Enforce the test's network boundary before invoking real transport.
        expect(selectedModel.baseUrl).toBe(endpoint);
        expect(options.apiKey).toBe(syntheticToken);
        expect(options.transport).toBe('sse');
        forwarded.push(options);
        return provider.streamSimple(selectedModel, context, {
          ...options,
          ...(injectLimit
            ? {
                onPayload(payload, payloadModel) {
                  expect(payloadModel.baseUrl).toBe(endpoint);
                  payloadHookCalls++;
                  return { ...payload, max_output_tokens: options.maxTokens };
                },
              }
            : {}),
        });
      },
    };
    const profiles = new Map([
      [
        'openai-codex',
        {
          provider: 'openai-codex',
          displayName: 'Synthetic Codex loopback',
          piProvider,
          configuredMaxTokens: new Map(),
          modelErrors: new Map(),
          reasoning: 'low',
          transport: 'sse',
          timeoutMs: 2000,
          streamIdleTimeoutMs: 3000,
          maxRequestImageBytes: 1_000_000,
          requestImagePixelBudget: 1_000_000,
          requestImageMaxBytes: 1_000_000,
        },
      ],
    ]);
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => undefined,
      auth: {
        credentials: {
          async read(providerId) {
            expect(providerId).toBe('openai-codex');
            return {
              type: 'oauth',
              access: syntheticToken,
              refresh: 'synthetic-refresh-must-never-be-used',
              expires: Date.now() + 3_600_000,
            };
          },
          async list() {
            return [];
          },
          async modify() {
            throw Error('synthetic_test_must_not_refresh_credentials');
          },
          async delete() {
            throw Error('synthetic_test_must_not_delete_credentials');
          },
        },
        authContext: {
          async env() {
            throw Error('synthetic_test_must_not_read_ambient_auth');
          },
          async fileExists() {
            throw Error('synthetic_test_must_not_read_ambient_auth');
          },
        },
      },
    });
    const prepared = await adapter.prepareCall('openai-codex', model.id);
    const chunks = [];
    for await (const chunk of prepared.stream({
      provider: 'openai-codex',
      model: model.id,
      maxTokens: 3754,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Synthetic test.' }] },
      ],
      signal: AbortSignal.timeout(4000),
      // This is deliberately unsupported DSH input: the regression verifies
      // that copying pi-ai's option onto a DSH request does NOT forward it.
      onPayload() {
        throw Error('DSH_does_not_forward_onPayload');
      },
    })) {
      chunks.push(chunk);
    }
    return { calls, chunks, forwarded, payloadHookCalls };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe.sequential(
  'pinned Codex output-bound wire evidence (offline only)',
  () => {
    it('forwards DSH maxTokens to pi-ai but does not serialize a remote cap', async () => {
      const result = await runWire();
      expect(result.forwarded, JSON.stringify(result.chunks)).toHaveLength(1);
      expect(result.forwarded[0].maxTokens).toBe(3754);
      expect(result.forwarded[0].onPayload).toBeUndefined();
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]).toMatchObject({
        method: 'POST',
        path: '/backend-api/codex/responses',
        account: 'synthetic-loopback-account',
        body: { model: 'gpt-5.6-luna', reasoning: { effort: 'low' } },
      });
      expect(result.calls[0].body).not.toHaveProperty('max_output_tokens');
      expect(result.calls[0].body).not.toHaveProperty('max_tokens');
      expect(result.calls[0].body).not.toHaveProperty('max_completion_tokens');
      expect(result.chunks).toContainEqual({
        type: 'usage',
        usage: {
          inputTokens: 16,
          cacheReadTokens: 4,
          outputTokens: 7,
          totalTokens: 27,
        },
      });
      expect(result.chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'stop' },
      });
    });

    it('serializes an exploratory Provider onPayload cap without implying remote support', async () => {
      const result = await runWire({ injectLimit: true });
      expect(result.calls).toHaveLength(1);
      expect(result.payloadHookCalls).toBe(1);
      expect(result.calls[0].body.max_output_tokens).toBe(3754);
      expect(result.chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'stop' },
      });
    });

    it('preserves a synthetic unsupported-parameter error with no unbounded retry', async () => {
      const result = await runWire({ injectLimit: true, rejectLimit: true });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].body.max_output_tokens).toBe(3754);
      expect(result.chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } },
      });
    });

    it('single-request cap probe strips bodies, credentials and account data from 400 diagnostics', async () => {
      const { calls, result } = await runWire({
        probe: true,
        rejectLimit: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body.max_output_tokens).toBe(64);
      expect(result).toMatchObject({
        outcome: 'cap_field_rejected',
        errorType: 'unsupported_output_cap',
        httpStatus: 400,
        fieldRejected: true,
        payloadCount: 1,
        sdkRetries: 0,
        serverEnforcementProven: false,
        productionGateEvidence: false,
      });
      const encoded = JSON.stringify(result);
      for (const forbidden of [
        syntheticToken,
        'synthetic-loopback-account',
        'Unsupported parameter',
        'SYNTHETIC_CODEX_WIRE_RESULT',
        'synthetic-refresh',
      ]) {
        expect(encoded).not.toContain(forbidden);
      }
    });

    it('reports a synthetic length-at-cap sample without generalizing enforcement', async () => {
      const { calls, result } = await runWire({
        probe: true,
        incomplete: true,
      });

      expect(calls).toHaveLength(1);
      expect(result).toMatchObject({
        outcome: 'response_received_single_sample',
        httpStatus: 200,
        finishReason: 'length',
        singleSampleCapConsistent: true,
        usage: { inputTokens: 20, outputTokens: 64, reasoningTokens: 2 },
        serverEnforcementProven: false,
        productionGateEvidence: false,
      });
    });

    it('aborts one stalled loopback request without retry or raw diagnostics', async () => {
      const started = Date.now();
      const { calls, result } = await runWire({ probe: true, stall: true });
      expect(calls).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result).toMatchObject({
        outcome: 'aborted',
        errorType: 'aborted',
        payloadCount: 1,
      });
    });

    it('requires opt-in before resolving credentials', async () => {
      let reads = 0;
      const result = await runCodexSubscriptionCapProbe({
        credentials: { readRecord: () => reads++ },
      });
      expect(reads).toBe(0);
      expect(result.outcome).toBe('opt_in_required');
    });

    it('refuses expiring grants without refresh or model dispatch', async () => {
      const result = await runCodexSubscriptionCapProbe({
        confirmation: 'run-one-codex-subscription-cap-probe',
        credentials: {
          async readRecord() {
            return {
              kind: 'grant',
              payload: {
                type: 'oauth',
                access: syntheticToken,
                expires: Date.now(),
              },
            };
          },
          modifyRecord() {
            throw Error('must_not_refresh');
          },
        },
      });
      expect(result.outcome).toBe('unexpired_subscription_grant_required');
      expect(result.payloadCount).toBe(0);
    });

    it.each([
      'http://localhost:1234/backend-api',
      'http://127.0.0.1:1234/backend-api?redirect=1',
      'http://user:password@127.0.0.1:1234/backend-api',
      'https://remote.invalid/backend-api',
    ])(
      'rejects the endpoint override %s before auth',
      async (loopbackEndpoint) => {
        let reads = 0;
        const result = await runCodexSubscriptionCapProbe({
          confirmation: 'run-one-codex-subscription-cap-probe',
          loopbackEndpoint,
          credentials: { readRecord: () => reads++ },
        });
        expect(reads).toBe(0);
        expect(result.outcome).toBe('invalid_loopback_endpoint');
      },
    );
  },
);
