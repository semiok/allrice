import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { GatewayLlmAdapter } from './dsh-provider.ts';

afterEach(() => vi.unstubAllGlobals());

const endpoint = 'http://vm-egress.invalid:39001/v1/stream';
const chunks: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Synthetic rice price.' },
  {
    type: 'block-end',
    index: 0,
    block: { type: 'text', text: 'Synthetic rice price.' },
  },
  { type: 'finish', reason: { kind: 'stop' } },
];
function input(): GenerateOptions {
  return {
    provider: 'host-gateway',
    model: 'fixture-model',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '请查一下今天的大米价格。' }],
      },
    ],
    system: 'Synthetic managed model test.',
    temperature: 0.5,
    maxTokens: 512,
    signal: new AbortController().signal,
  };
}
async function collect(adapter: GatewayLlmAdapter, options: GenerateOptions) {
  const result: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) result.push(chunk);
  return result;
}

describe('guest adapter VM-local egress capability (synthetic fetch only)', () => {
  it.each([
    { label: 'without a capability', capability: undefined },
    { label: 'with a capability', capability: 'synthetic-vm-epoch-capability' },
  ])('forwards the native call $label', async ({ capability }) => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n',
        ),
      );
    vi.stubGlobal('fetch', transport);
    const options = input();
    const adapter =
      capability === undefined
        ? new GatewayLlmAdapter(endpoint)
        : new GatewayLlmAdapter(endpoint, capability);

    expect(await collect(adapter, options)).toEqual(chunks);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init!.signal).toBe(options.signal);
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({
      'content-type': 'application/json',
      'x-allrice-model-contract': '1',
      ...(capability === undefined
        ? {}
        : { authorization: 'Bearer ' + capability }),
    });
    expect(JSON.parse(init!.body as string)).toEqual({
      messages: options.messages,
      system: options.system,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    if (capability !== undefined) {
      expect(String(url)).not.toContain(capability);
      expect(init!.body).not.toContain(capability);
    }
  });

  it.each(['', 'wrong-synthetic-capability'])(
    'does not repair or retry a denied local capability %j',
    async (capability) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'DENIED' }), { status: 403 }),
        );
      vi.stubGlobal('fetch', transport);

      await expect(
        collect(new GatewayLlmAdapter(endpoint, capability), input()),
      ).rejects.toMatchObject({ code: 'TRANSPORT' });
      expect(transport).toHaveBeenCalledTimes(1);
      const [url, init] = transport.mock.calls[0]!;
      expect(url).toBe(endpoint);
      expect(init!.headers).toMatchObject({
        authorization: 'Bearer ' + capability,
      });
    },
  );
});
