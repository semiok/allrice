import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmRuntime,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import {
  MODEL_GATEWAY_CONTRACT_VERSION,
  ModelGatewayError,
} from './contract.ts';
import type {
  GatewayFetchClassification,
  GatewayProvider,
} from './contract.ts';

/** Use the existing host subscription loader's LlmRuntime, including its
 * credentials/refresh implementation. This function never opens credentials.
 * The loader's pinned provider profile must use HTTP SSE, not websocket/auto. */
export function createDshGatewayProvider(
  llm: Pick<LlmRuntime, 'prepareCall'>,
  route: {
    provider: string;
    model: string;
    transport: 'sse';
    classify(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): GatewayFetchClassification | null;
  },
): GatewayProvider {
  return {
    classify: route.classify,
    async *stream(binding, input, signal) {
      if (
        binding.provider !== route.provider ||
        binding.model !== route.model ||
        route.transport !== 'sse'
      )
        throw new ModelGatewayError('BINDING_INVALID');
      const prepared = await llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          ...(input.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: input.reasoningEffort }),
          ...(input.temperature === undefined
            ? {}
            : { temperature: input.temperature }),
          ...(input.maxTokens === undefined
            ? {}
            : { maxTokens: input.maxTokens }),
          ...(input.stop === undefined ? {} : { stop: input.stop }),
        },
        signal,
      );
      yield* prepared.stream({
        ...input,
        ...prepared.config,
        signal,
        sessionId: binding.native.sessionId as GenerateOptions['sessionId'],
      });
    },
  };
}

/** Guest-side public DSH provider seam. The host supplies the managed endpoint
 * and optional VM-local egress capability, never an upstream model credential.
 * Neither supplies person/tenant authority. No reconnect, retry, credential
 * refresh or tool protocol is invented here. */
export class GatewayLlmAdapter extends LlmAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly egressCapability?: string,
  ) {
    super();
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const {
      messages,
      system,
      tools,
      toolHistory,
      temperature,
      maxTokens,
      stop,
      reasoningEffort,
      purpose,
    } = options;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal: options.signal,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-allrice-model-contract': String(MODEL_GATEWAY_CONTRACT_VERSION),
        ...(this.egressCapability === undefined
          ? {}
          : { authorization: 'Bearer ' + this.egressCapability }),
      },
      body: JSON.stringify({
        messages,
        system,
        tools,
        toolHistory,
        temperature,
        maxTokens,
        stop,
        reasoningEffort,
        purpose,
      }),
    });
    if (!response.body)
      throw new LlmError('Host gateway returned no stream', 'TRANSPORT', {
        status: response.status,
      });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let terminal = false;
    let exhausted = false;
    try {
      for (;;) {
        options.signal?.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          exhausted = true;
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const chunk = JSON.parse(line) as StreamChunk;
          if (
            !chunk ||
            ![
              'block-start',
              'text-delta',
              'reasoning-delta',
              'tool-call-delta',
              'block-end',
              'usage',
              'finish',
            ].includes(chunk.type)
          )
            throw new LlmError('Invalid host gateway stream', 'TRANSPORT');
          if (terminal)
            throw new LlmError('Data after host terminal', 'TRANSPORT');
          if (chunk.type === 'finish') terminal = true;
          yield chunk;
        }
      }
      if (buffer.trim() || !terminal)
        throw new LlmError(
          'Host gateway stream ended without terminal',
          'TRANSPORT',
        );
    } finally {
      if (!exhausted) await reader.cancel();
      reader.releaseLock();
    }
  }
}
